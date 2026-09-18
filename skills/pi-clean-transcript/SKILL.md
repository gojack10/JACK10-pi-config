---
name: pi-clean-transcript
description: Extracts from a Pi session JSONL via DuckDB the chronological user/assistant transcript WITH tool-call arguments — write/edit collapsed to their path only — no thinking, no tool results. Use when asked to clean, dump, extract, or log a Pi session transcript.
argument-hint: <session-id-or-jsonl-path>
---

duckdb queries tree: `2ba39fc8-0d4b-4f63-8a35-f198552fbb71`
Canonical procedure node: `38ff3f8b-7215-4cfe-940f-10b689d4c824`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current query, session-source resolution rules (explicit path, ID/prefix, or current session), and warnings. If the node cannot be read, halt rather than guessing from memory.
