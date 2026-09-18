---
name: pi-clean-transcript
description: Extracts from a Pi session JSONL via DuckDB the chronological user/assistant transcript WITH tool-call arguments — write/edit collapsed to their path only — no thinking, no tool results. Use when asked to clean, dump, extract, or log a Pi session transcript.
argument-hint: <session-id-or-jsonl-path>
---

duckdb queries tree: `f0000000-0000-4000-8000-f0a4eed4fa92`
Canonical procedure node: `f0000000-0000-4000-8000-c5ff4f45d78b`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current query, session-source resolution rules (explicit path, ID/prefix, or current session), and warnings. If the node cannot be read, halt rather than guessing from memory.
