---
name: rlm-sifttext-commit
description: "Commits a completed Pi session into SiftText from a fresh root using branch-aware transcript probing and human-gated persistence. Use when asked to commit or sweep a historical Pi session or huge chat into an ideation tree without reopening the source session."
argument-hint: "<historical-session-id-or-jsonl-path>"
---

SHOTGUN tree: `f0000000-0000-4000-8000-62ccd64177ba`
Canonical procedure node: `f0000000-0000-4000-8000-da279ed63fde`
Adaptive pipeline child: `f0000000-0000-4000-8000-600c586fd504`

Call `sifttext_get_node` on both nodes and follow their current adaptive ceremony with the supplied arguments before acting; do not skip this even if you think you remember it. If either node cannot be read, halt and tell the human rather than guessing.

For deterministic source projection, run the installed builder only against an already-frozen/hash-verified JSONL:

```bash
uv run --with duckdb --with tiktoken \
  ~/.pi/agent/skills/rlm-sifttext-commit/scripts/adaptive_projection.py \
  --source "$FROZEN_JSONL" \
  --source-sha256 "$SOURCE_SHA256" \
  --snapshots "$SNAPSHOTS_JSON" \
  --run-dir "$RUN_DIR"
```

The builder emits clean dialogue, a complete tool index, compact attention cards, deterministic chunks, and metadata. Preflight the complete initial request with the Procedure's 30K reserve: ≤80K uses one-Sol Fast Path; larger input uses structured Full Path.

After all Full Path chunk analysts emit schema-valid `full/analysis-<chunk_id>.json` artifacts, compile and validate the Sol bundle deterministically:

```bash
uv run ~/.pi/agent/skills/rlm-sifttext-commit/scripts/compile_full.py \
  --run-dir "$RUN_DIR"
```

Dispatch is forbidden unless the compiler succeeds, replay hashes are stable, exact entry/effect coverage passes, and the resulting `full/molder-mission.txt` passes the complete ≤80K preflight. Never add a classifier/reviewer model or truncate evidence to force Fast Path.
