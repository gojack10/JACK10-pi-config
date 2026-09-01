---
name: rlm-sifttext-commit
description: "Commits a completed Pi session into SiftText from a fresh root using branch-aware transcript probing and human-gated persistence. Use when asked to commit or sweep a historical Pi session or huge chat into an ideation tree without reopening the source session."
argument-hint: "<historical-session-id-or-jsonl-path>"
---

SHOTGUN tree: `f0000000-0000-4000-8000-62ccd64177ba`
Canonical procedure node: `f0000000-0000-4000-8000-da279ed63fde`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current routing, capability boundaries, and required structural reads. If the node cannot be read, halt rather than guessing from memory.
