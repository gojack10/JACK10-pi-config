---
name: pi-clean-transcript
description: Extracts from a Pi session JSONL via DuckDB the chronological user/assistant transcript WITH tool-call arguments — write/edit collapsed to their path only — no thinking, no tool results. Use when asked to clean, dump, extract, or log a Pi session transcript.
argument-hint: <session-id-or-jsonl-path>
---

Before acting, read `../../local/knowledge/pi-clean-transcript.md` relative to this skill directory with the file read tool and follow its current local DuckDB query, session-source resolution rules (explicit path, ID/prefix, or current session), and warnings. Keep snapshot/cutoff consent for growing sources, branch caveats, and the emitted-file/token/size reporting contract. `get_current_session` remains the local current-session locator; DuckDB SQL is local, not a hosted knowledge tool. If the file cannot be read, halt rather than guessing from memory.
