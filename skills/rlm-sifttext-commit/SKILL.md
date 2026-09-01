---
name: rlm-sifttext-commit
description: "Commits a completed Pi session into SiftText from a fresh root using branch-aware transcript probing and human-gated persistence. Use when asked to commit or sweep a historical Pi session or huge chat into an ideation tree without reopening the source session."
argument-hint: "<historical-session-id-or-jsonl-path>"
---

SHOTGUN tree: `ebc1156f-2fcf-424e-bf56-238e910497fc`
Canonical procedure node: `84ac7779-bcc7-44ba-bdb2-80faf57a8173`
Adaptive pipeline child: `5fef74f5-ca26-4a22-9892-7727363c2fa4`
Canonical SiftText Commit pull:
- Hub: `c72d552d-3499-445b-a8d5-05d0ff7824f2`
- Dialogue: `d00ab6fd-b475-49ef-b37a-812807879308`
- Forcing Pass: `da24ff95-9d07-4e15-9571-9313d6b90f94`
- Persistence: `af92e983-aa27-4dec-b628-2a4d0bbbd2b6`

Call `sifttext_get_node` on the Procedure, Adaptive pipeline, and all four SiftText Commit pull nodes before acting; do not skip this even if you think you remember them. Freeze the four exact `sifttext_get_node` results, in the listed order, as `$COMMIT_PROTOCOL_JSON` using schema `commit-rlm-protocol-pull/v1`, with each node's ID, name, full XML content, and SHA-256. If any node cannot be read or validated, halt rather than guessing. This exact packet—not a prompt paraphrase—is mandatory molder input on both Fast and Full paths.

For deterministic source projection, run the installed builder only against an already-frozen/hash-verified JSONL:

```bash
uv run --with duckdb --with tiktoken \
  ~/.pi/agent/skills/rlm-sifttext-commit/scripts/adaptive_projection.py \
  --source "$FROZEN_JSONL" \
  --source-sha256 "$SOURCE_SHA256" \
  --snapshots "$SNAPSHOTS_JSON" \
  --commit-protocol "$COMMIT_PROTOCOL_JSON" \
  --run-dir "$RUN_DIR"
```

The builder emits clean dialogue, a complete tool index, compact attention cards, deterministic chunks, and metadata. Preflight the complete initial request—including the exact four-node Commit Pull—with the Procedure's 30K reserve: ≤80K uses one-Sol Fast Path; larger input uses structured Full Path. The Fast molder receives the packet directly. The Full compiler validates and carries it into the final molder bundle.

The molder must apply Dialogue's deep probe-topology scan and Forcing Pass before display. Its primary human artifact is the canonical Unix-style affected-tree delta: operation marker left, effective status marker right, terse exact action notes beneath changed nodes. A prose summary, numbered operation inventory, grouped inventory, or schematic is a contract failure even when the machine JSON is valid.

After all Full Path chunk analysts emit schema-valid `full/analysis-<chunk_id>.json` artifacts, compile and validate the Sol bundle deterministically:

```bash
uv run ~/.pi/agent/skills/rlm-sifttext-commit/scripts/compile_full.py \
  --run-dir "$RUN_DIR"
```

Dispatch is forbidden unless the compiler succeeds, replay hashes are stable, exact entry/effect coverage passes, and the resulting `full/molder-mission.txt` passes the complete ≤80K preflight. Never add a classifier/reviewer model or truncate evidence to force Fast Path.
