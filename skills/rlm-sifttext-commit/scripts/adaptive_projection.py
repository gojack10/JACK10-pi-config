#!/usr/bin/env python
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import duckdb
import tiktoken
from tool_classifier import READ_TOOLS, STATE_TOOLS, classify_shell, one_line

PARSER = argparse.ArgumentParser(description='Build deterministic adaptive Commit RLM inputs from an already-frozen Pi JSONL.')
PARSER.add_argument('--source', required=True, type=Path)
PARSER.add_argument('--source-sha256', required=True)
PARSER.add_argument('--snapshots', required=True, type=Path)
PARSER.add_argument('--commit-protocol', required=True, type=Path, help='Frozen four-node SiftText Commit pull packet.')
PARSER.add_argument('--run-dir', required=True, type=Path)
PARSER.add_argument('--chunk-target-tokens', type=int, default=10_000)
PARSER.add_argument('--full-threshold-tokens', type=int, default=80_000)
PARSER.add_argument('--tokenizer', default='o200k_base')
ARGS = PARSER.parse_args()

ROOT = ARGS.run_dir
SOURCE = ARGS.source
SNAPSHOTS = ARGS.snapshots
COMMIT_PROTOCOL = ARGS.commit_protocol
EXPECTED_SOURCE_SHA = ARGS.source_sha256
TARGET_TOKENS = ARGS.chunk_target_tokens
ENC = tiktoken.get_encoding(ARGS.tokenizer)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tokens(text):
    return len(ENC.encode(text))


ROOT.mkdir(parents=True, exist_ok=True)
for arm in ('fast', 'full'):
    (ROOT / arm).mkdir(exist_ok=True)

if sha(SOURCE) != EXPECTED_SOURCE_SHA:
    raise SystemExit('source hash mismatch')
if SOURCE.resolve() != (ROOT / 'source.jsonl').resolve():
    shutil.copy2(SOURCE, ROOT / 'source.jsonl')
if SNAPSHOTS.resolve() != (ROOT / 'prewrite-snapshots.json').resolve():
    shutil.copy2(SNAPSHOTS, ROOT / 'prewrite-snapshots.json')
protocol_target = ROOT / 'commit-protocol-pull.json'
if COMMIT_PROTOCOL.resolve() != protocol_target.resolve():
    shutil.copy2(COMMIT_PROTOCOL, protocol_target)
protocol = json.loads(protocol_target.read_text())
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

raw = [json.loads(line) for line in SOURCE.read_text().splitlines()]
line_order = {entry.get('id'): i for i, entry in enumerate(raw) if entry.get('id')}

con = duckdb.connect()
rows = con.execute("""
WITH s AS (
  SELECT * FROM read_json_auto(?)
  WHERE type='message' AND message.role IN ('user','assistant')
)
SELECT timestamp::VARCHAR, id, parentId, message.role,
       string_agg(c.text, '' ORDER BY ord) AS text
FROM s, UNNEST(message.content) WITH ORDINALITY AS t(c,ord)
WHERE c.type='text'
GROUP BY timestamp,id,parentId,message.role
ORDER BY timestamp
""", [str(SOURCE)]).fetchall()

messages = sorted([
    {'timestamp': r[0], 'id': r[1], 'parentId': r[2], 'role': r[3], 'text': r[4]}
    for r in rows
], key=lambda m: line_order[m['id']])

def render(items):
    return '\n\n'.join(
        f"### {m['role'].upper()} | entry={m['id']} | parent={m['parentId']} | {m['timestamp']}\n{m['text']}"
        for m in items
    ) + '\n'

plain = render(messages)
(ROOT / 'plain-transcript.md').write_text(plain)

# Compact deterministic index; raw evidence remains in source.jsonl.
call_rows = {}
call_args = {}
results = {}
for line_no, entry in enumerate(raw, 1):
    msg = entry.get('message') or {}
    if entry.get('type') != 'message':
        continue
    if msg.get('role') == 'assistant':
        for block in msg.get('content') or []:
            if block.get('type') != 'toolCall':
                continue
            args = block.get('arguments') or {}
            target = args.get('path') or args.get('node_id') or args.get('id') or args.get('command') or ''
            if not isinstance(target, str):
                target = json.dumps(target, sort_keys=True, separators=(',', ':'))
            call_id = block.get('id')
            call_args[call_id] = args
            call_rows[call_id] = {
                'toolCallId': call_id, 'entry_id': entry.get('id'), 'source_line': line_no,
                'tool': block.get('name'), 'target': target[:240],
                'arguments_sha256': hashlib.sha256(json.dumps(args, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            }
    elif msg.get('role') == 'toolResult':
        content = msg.get('content') or []
        details = msg.get('details') or {}
        result_text = '\n'.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text')
        results[msg.get('toolCallId')] = {
            'result_entry_id': entry.get('id'), 'result_line': line_no,
            'isError': bool(msg.get('isError')), 'truncated': bool(details.get('truncated')),
            'result_text': result_text,
            'content_sha256': hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        }
index = []
cards = []
for number, (call_id, item) in enumerate(call_rows.items(), 1):
    result = results.get(call_id)
    public_result = {
        'result_entry_id': result.get('result_entry_id') if result else None,
        'result_line': result.get('result_line') if result else None,
        'isError': result.get('isError') if result else None,
        'truncated': result.get('truncated') if result else None,
        'content_sha256': result.get('content_sha256') if result else None,
    }
    index.append(item | public_result)
    tool = item['tool']
    args = call_args[call_id]
    if tool in READ_TOOLS:
        classification = 'read_only'
    elif tool == 'write' and str(args.get('path', '')).startswith('/tmp/'):
        classification = 'transient'
    elif tool in STATE_TOOLS:
        classification = 'state_change'
    elif tool in {'bash_bg', 'bash_kill'}:
        classification = 'transient'
    elif tool == 'bash':
        classification = classify_shell(args.get('command', ''))
    else:
        classification = 'unknown'
    if not result or result.get('isError') or result.get('truncated'):
        classification = 'attention_' + ('orphan' if not result else 'error' if result.get('isError') else 'truncated')
    if classification not in {'read_only', 'transient'}:
        card = {
            'effect_id': f'E{number:03d}', 'classification': classification,
            'tool': tool, 'entry_id': item['entry_id'], 'toolCallId': call_id,
            'target': item['target'], 'outcome': 'missing_result' if not result else 'error' if result.get('isError') else 'success',
            'source_line': item['source_line'], 'result_line': public_result['result_line'],
            'arguments_sha256': item['arguments_sha256'], 'result_sha256': public_result['content_sha256'],
        }
        if tool == 'edit':
            compact = []
            for edit in args.get('edits', []):
                compact.append({'oldText': one_line(edit.get('oldText',''), 900), 'newText': one_line(edit.get('newText',''), 900)})
            card['changes'] = compact
        elif tool == 'write':
            content = args.get('content', '')
            card['write'] = {'bytes': len(content.encode()), 'sha256': hashlib.sha256(content.encode()).hexdigest()}
            if not str(args.get('path','')).startswith('/tmp/') and len(content) <= 1800:
                card['write']['content'] = content
        elif tool in {'bash', 'bash_bg'}:
            card['command'] = one_line(args.get('command', ''), 900)
        if result and (result.get('isError') or result.get('truncated')):
            card['result_excerpt'] = one_line(result.get('result_text', ''), 500)
        cards.append(card)
(ROOT / 'evidence-index.json').write_text(json.dumps(index, indent=2, sort_keys=True) + '\n')
(ROOT / 'attention-cards.json').write_text(json.dumps(cards, indent=2, sort_keys=True) + '\n')

def render_cards(selected):
    return '\n'.join(json.dumps(card, sort_keys=True, separators=(',', ':')) for card in selected) + ('\n' if selected else '')

(ROOT / 'attention-cards.jsonl').write_text(render_cards(cards))

def render_inline_cards(selected):
    lines = []
    for card in selected:
        head = f"{card['effect_id']} | {card['classification']} | {card['tool']} | {card['outcome']} | entry={card['entry_id']} | lines={card['source_line']}-{card['result_line']}"
        detail = card.get('command') or card.get('target') or ''
        if card.get('changes'):
            detail = json.dumps(card['changes'], sort_keys=True, separators=(',', ':'))
        if card.get('write'):
            detail = f"{card.get('target','')} " + json.dumps(card['write'], sort_keys=True, separators=(',', ':'))
        lines.append(head + "\n" + one_line(detail, 950))
        if card.get('result_excerpt'):
            lines.append('result: ' + one_line(card['result_excerpt'], 500))
    return '\n'.join(lines) + ('\n' if lines else '')

inline_cards = render_inline_cards(cards)
(ROOT / 'attention-cards-inline.md').write_text(inline_cards)

# User-led episodes, preserving complete messages. Preamble assistants stay with the first episode.
episodes, current = [], []
for m in messages:
    if m['role'] == 'user' and current:
        episodes.append(current)
        current = []
    current.append(m)
if current:
    episodes.append(current)

chunks, current = [], []
for episode in episodes:
    trial = current + episode
    if current and tokens(render(trial)) > TARGET_TOKENS:
        chunks.append(current)
        current = list(current[-1:]) + episode  # one complete prior episode overlap
    else:
        current = trial
if current:
    chunks.append(current)

chunk_manifest = []
chunk_ranges = []
for chunk in chunks:
    lines = [line_order[m['id']] + 1 for m in chunk]
    chunk_ranges.append((min(lines), max(lines)))

assigned_effects = set()
for i, chunk in enumerate(chunks, 1):
    path = ROOT / 'full' / f'chunk-{i:03d}.md'
    entry_ids = [m['id'] for m in chunk]
    low, high = chunk_ranges[i-1]
    chunk_cards = [card for card in cards if low <= card['source_line'] <= high]
    assigned_effects.update(c['effect_id'] for c in chunk_cards)
    text = render(chunk) + '\n## TOOL CHANGES AND AMBIGUOUS CALLS\n' + render_inline_cards(chunk_cards)
    path.write_text(text)
    chunk_manifest.append({
        'chunk_id': f'chunk-{i:03d}', 'path': str(path), 'sha256': sha(path),
        'tokens': tokens(text), 'entry_ids': entry_ids, 'effect_ids': [c['effect_id'] for c in chunk_cards],
    })
(ROOT / 'full' / 'chunk-manifest.json').write_text(json.dumps(chunk_manifest, indent=2, sort_keys=True) + '\n')
missing_effects = {c['effect_id'] for c in cards} - assigned_effects
if missing_effects:
    raise SystemExit(f'attention cards not assigned to a chunk: {sorted(missing_effects)}')

metadata = {
    'source': str(SOURCE), 'source_sha256': sha(SOURCE),
    'snapshots': str(SNAPSHOTS), 'snapshots_sha256': sha(SNAPSHOTS),
    'commit_protocol': str(protocol_target), 'commit_protocol_sha256': sha(protocol_target),
    'message_count': len(messages), 'plain_bytes': len(plain.encode()), 'plain_tokens': tokens(plain),
    'evidence_calls': len(index), 'attention_cards': len(cards),
    'attention_card_tokens': tokens(inline_cards),
    'classifications': {kind: sum(c['classification'] == kind for c in cards) for kind in sorted({c['classification'] for c in cards})},
    'full_threshold_tokens': ARGS.full_threshold_tokens,
    'tokenizer': ARGS.tokenizer,
    'chunk_target_tokens': TARGET_TOKENS, 'chunks': chunk_manifest,
}
(ROOT / 'metadata.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
print(json.dumps(metadata, indent=2))
