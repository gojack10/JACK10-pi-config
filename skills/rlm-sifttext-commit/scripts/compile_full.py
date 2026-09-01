#!/usr/bin/env python
import argparse
import hashlib
import json
from pathlib import Path

PARSER = argparse.ArgumentParser(description='Validate structured Full Path analyses and compile the deterministic Sol bundle.')
PARSER.add_argument('--run-dir', required=True, type=Path)
PARSER.add_argument('--shadow-forced-full', action='store_true', help='Describe Full Path as an explicit shadow arm even when the source fits Fast Path.')
ARGS = PARSER.parse_args()
ROOT = ARGS.run_dir
FULL = ROOT / 'full'
meta = json.loads((ROOT / 'metadata.json').read_text())

protocol_path = ROOT / 'commit-protocol-pull.json'
protocol = json.loads(protocol_path.read_text())
required_protocol_ids = [
    'c72d552d-3499-445b-a8d5-05d0ff7824f2',
    'd00ab6fd-b475-49ef-b37a-812807879308',
    'da24ff95-9d07-4e15-9571-9313d6b90f94',
    'af92e983-aa27-4dec-b628-2a4d0bbbd2b6',
]
if protocol.get('schema') != 'commit-rlm-protocol-pull/v1' or protocol.get('required_node_ids') != required_protocol_ids:
    raise SystemExit('invalid SiftText Commit protocol packet')
protocol_nodes = protocol.get('nodes', [])
if [node.get('node_id') for node in protocol_nodes] != required_protocol_ids:
    raise SystemExit('SiftText Commit protocol pull coverage mismatch')
for node in protocol_nodes:
    content = node.get('content', '')
    if hashlib.sha256(content.encode()).hexdigest() != node.get('sha256'):
        raise SystemExit(f"SiftText Commit protocol node hash mismatch: {node.get('node_id')}")

reports = []
all_candidate_ids = set()
for chunk in meta['chunks']:
    path = FULL / f"analysis-{chunk['chunk_id']}.json"
    report = json.loads(path.read_text())
    if report.get('chunk_id') != chunk['chunk_id']:
        raise SystemExit(f'{path}: chunk_id mismatch')
    if report.get('chunk_sha256') != chunk['sha256']:
        raise SystemExit(f'{path}: chunk hash mismatch')
    if report.get('reviewed_entry_ids') != chunk['entry_ids']:
        raise SystemExit(f'{path}: reviewed_entry_ids mismatch')
    if report.get('reviewed_effect_ids') != chunk.get('effect_ids', []):
        raise SystemExit(f'{path}: reviewed_effect_ids mismatch')
    allowed = set(chunk['entry_ids'])
    allowed_effects = set(chunk.get('effect_ids', []))
    for candidate in report.get('candidates', []):
        cid = candidate.get('candidate_id')
        if not cid or cid in all_candidate_ids:
            raise SystemExit(f'{path}: missing/duplicate candidate_id {cid}')
        all_candidate_ids.add(cid)
        evidence = set(candidate.get('evidence_entry_ids', []))
        effects = set(candidate.get('effect_ids', []))
        if not evidence <= allowed:
            raise SystemExit(f'{path}: candidate {cid} cites out-of-chunk IDs {sorted(evidence-allowed)}')
        if not effects <= allowed_effects:
            raise SystemExit(f'{path}: candidate {cid} cites out-of-chunk effects {sorted(effects-allowed_effects)}')
    disposition_ids = [effect for d in report.get('effect_dispositions', []) for effect in d.get('effect_ids', [])]
    if len(disposition_ids) != len(set(disposition_ids)) or set(disposition_ids) != allowed_effects:
        raise SystemExit(f'{path}: effect disposition coverage mismatch')
    reports.append(report)

# Exact semantic payload duplicates only; possible semantic overlap remains for Sol.
def exact_key(candidate):
    body = {k: v for k, v in candidate.items() if k != 'candidate_id'}
    return json.dumps(body, sort_keys=True, separators=(',', ':'))

candidates, exact_duplicates, seen = [], [], {}
for report in reports:
    for candidate in report.get('candidates', []):
        key = exact_key(candidate)
        if key in seen:
            exact_duplicates.append({'kept': seen[key], 'removed': candidate['candidate_id']})
        else:
            seen[key] = candidate['candidate_id']
            candidates.append(candidate)

attention_path = ROOT / 'attention-cards.json'
attention_cards = json.loads(attention_path.read_text())
card_ids = [card.get('effect_id') for card in attention_cards]
required_effect_ids = sorted({effect for c in meta['chunks'] for effect in c.get('effect_ids', [])})
if len(card_ids) != len(set(card_ids)) or set(card_ids) != set(required_effect_ids):
    raise SystemExit('canonical attention-card coverage mismatch')
canonical_cards = []
for card in attention_cards:
    card_raw = json.dumps(card, sort_keys=True, separators=(',', ':'))
    canonical_cards.append({**card, 'card_sha256': hashlib.sha256(card_raw.encode()).hexdigest()})

bundle = {
    'arm': 'full',
    'source': {'path': str(ROOT/'source.jsonl'), 'sha256': meta['source_sha256']},
    'snapshots': {'path': str(ROOT/'prewrite-snapshots.json'), 'sha256': meta['snapshots_sha256']},
    'commit_protocol': {
        'path': str(protocol_path),
        'sha256': hashlib.sha256(protocol_path.read_bytes()).hexdigest(),
        'required_node_ids': required_protocol_ids,
        'nodes': protocol_nodes,
    },
    'evidence_index': {'path': str(ROOT/'evidence-index.json')},
    'attention_cards': {
        'path': str(attention_path),
        'sha256': hashlib.sha256(attention_path.read_bytes()).hexdigest(),
        'custody': 'IMMUTABLE_CANONICAL_CARDS',
        'cards': canonical_cards,
    },
    'full_threshold_tokens': meta['full_threshold_tokens'],
    'chunks': [
        {'chunk_id': c['chunk_id'], 'sha256': c['sha256'], 'tokens': c['tokens'], 'entry_ids': c['entry_ids']}
        for c in meta['chunks']
    ],
    'candidates': candidates,
    'declared_conflicts': [x for r in reports for x in r.get('conflicts', [])],
    'possible_omissions': [x for r in reports for x in r.get('possible_omissions', [])],
    'excluded_operational_detail': [x for r in reports for x in r.get('excluded_operational_detail', [])],
    'analyst_effect_dispositions': [x for r in reports for x in r.get('effect_dispositions', [])],
    'exact_duplicates': exact_duplicates,
    'coverage': {
        'all_chunk_reports_valid': True,
        'reviewed_entry_ids_match_manifests': True,
        'chunk_count': len(reports),
        'candidate_count': len(candidates),
        'required_effect_ids': required_effect_ids,
        'canonical_attention_cards_match_required_effects': True,
    },
}
raw = json.dumps(bundle, indent=2, sort_keys=True) + '\n'
bundle_path = FULL / 'molder-bundle.json'
bundle_path.write_text(raw)
bundle_sha = hashlib.sha256(raw.encode()).hexdigest()

bundle_delivery = f'''--- BEGIN DETERMINISTIC MOLDER BUNDLE ---\n{raw}--- END DETERMINISTIC MOLDER BUNDLE ---'''

route_reason = ('This shadow replay was explicitly forced through Full Path for comparison even though the source fits the Fast Path gate.'
                if ARGS.shadow_forced_full else
                'The frozen source exceeded the Fast Path gate.')
mission = f"""This is the no-mutation Full Path molding phase of a Commit RLM run.

You are the sole final topology molder. {route_reason} The source was deterministically split at complete message/episode boundaries, analyzed by structured chunk analysts, and compiled without an LLM normalizer.

Hard boundaries:
- Do not call any SiftText mutation tool. Do not alter any tree or node.
- Do not inspect prior run directories or superseded pipeline artifacts.
- Do not read the complete plain transcript; that would bypass Full Path decomposition.
- If exact evidence is needed, use candidate entry IDs and {ROOT/'evidence-index.json'}, then read only targeted lines from {ROOT/'source.jsonl'}.
- Frozen pre-Persistence nodes are at {ROOT/'prewrite-snapshots.json'}.
- Git owns implementation details, commit chronology, tests, and build history. SiftText owns durable decisions, rationale, invariants, unresolved work, failure lessons, and concise locators.
- Do not create a commit-mirror tree or one node per commit. Git-owned commit chronology must be excluded, not promoted into SiftText topology. Do not create a new root unless an unavoidable durable domain has no existing owner.
- Every required effect ID in bundle.coverage.required_effect_ids must receive exactly one grouped final disposition: operation, exclusion, or unresolved. This is part of your existing molding pass, not another review stage.
- `bundle.attention_cards.cards` is the immutable canonical evidence-custody layer. Analysts may have generalized an effect; you must use the original card's tool/target/command/outcome/pointers when deciding and describing its disposition. Never replace a specific card with a generic label. Every final disposition must include the exact matching `{{effect_id, card_sha256}}` pair in `canonical_card_refs`.
- `bundle.commit_protocol.nodes` is the exact mandatory SiftText Commit pull: hub, Dialogue, Forcing Pass, and Persistence. Treat it as authoritative. Run Dialogue's deep probe-topology scan and Forcing Pass before display. The primary human artifact must be Dialogue's compact Unix-style tree delta: affected hierarchy only, operation marker left, effective status marker right, with exact action notes beneath each changed node. A grouped operation inventory or prose summary is not a canonical tree delta.
- Analyst target hints are nonbinding. Resolve final topology yourself.

Bundle integrity:
- bundle SHA-256: {bundle_sha}
- source SHA-256: {meta['source_sha256']}
- snapshots SHA-256: {meta['snapshots_sha256']}
- validated chunk reports: {len(reports)}
- compiled candidates: {len(candidates)}

Produce an approval-ready proposed SiftText delta. Consolidate semantic duplicates, resolve analyst conflicts, and leave only genuinely material human choices unresolved.

Write both artifacts:
1. {FULL/'proposed-delta.json'}
2. {FULL/'proposed-delta.md'}

JSON contract:
{{
  "arm": "full",
  "summary": "...",
  "operations": [
    {{
      "op_id": "L001",
      "action": "create_tree|create_node|append_crystallization|edit_crystallization|edit_section|set_scope|set_vitals|link|rename|move|resolve|discard|defer|activate|set_priority",
      "target": {{"tree_id": "... or null", "node_id": "... or null", "node_name": "..."}},
      "field_or_section": "... or null",
      "content": "exact proposed content or exact operation payload",
      "effective_status": "not_examined|in_progress|resolved|discarded|deferred|stuck|null",
      "evidence_entry_ids": ["..."],
      "effect_ids": ["..."],
      "rationale": "...",
      "propagation_impact": "which connected nodes are affected, or no_propagation with reason"
    }}
  ],
  "exclusions": [{{"subject": "...", "reason": "...", "evidence_entry_ids": ["..."], "effect_ids": ["..."]}}],
  "unresolved_choices": [{{"question": "...", "options": ["..."], "evidence_entry_ids": ["..."], "effect_ids": ["..."]}}],
  "effect_dispositions": [{{"effect_ids": ["E001"], "canonical_card_refs": [{{"effect_id": "E001", "card_sha256": "..."}}], "disposition": "operation|exclusion|unresolved", "ref_ids": ["L001"], "reason": "effect-specific reason retaining the canonical tool/target/command identity"}}],
  "coverage": {{"durable_topics": ["..."], "known_omissions": ["..."]}}
}}

The Markdown artifact must render exactly the same delta and begin with the canonical Unix-style affected-tree rendering required by Dialogue. Validate JSON, unique operation IDs, exact canonical-card references, and exact nonduplicated coverage of bundle.coverage.required_effect_ids by effect_dispositions. Your actual final response is the direct human-facing molding turn: present that complete topology-first tree delta with exact action notes, then any decision explanation, and ask the human whether to revise it or commit it. A numbered prose operation list, grouped inventory, schematic, or artifact-path/count response fails the contract. Do not mutate SiftText.

{bundle_delivery}
"""
mission_path = FULL / 'molder-mission.txt'
mission_path.write_text(mission)
receipt = {
    'bundle_path': str(bundle_path), 'bundle_sha256': bundle_sha,
    'bundle_bytes': len(raw.encode()), 'candidate_count': len(candidates),
    'exact_duplicates': len(exact_duplicates), 'mission_path': str(mission_path),
    'mission_sha256': hashlib.sha256(mission.encode()).hexdigest(),
}
(FULL/'compiler-receipt.json').write_text(json.dumps(receipt, indent=2, sort_keys=True)+'\n')
print(json.dumps(receipt, indent=2))
