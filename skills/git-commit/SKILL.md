---
name: git-commit
description: Turns a working tree diff into clean Conventional Commits. Use when you need to inspect, split, or commit repository changes.
argument-hint: <optional focus or commit guidance>
---

# Git Commit

Read [git-commit-rules.md](../../git-commit-rules.md) for the canonical commit policy.

## Workflow

1. Inspect `git status`, `git diff --stat`, and relevant file diffs.
2. Split unrelated changes into logical commits.
3. Write commit messages that follow the rules.
4. Commit with `git commit`.
5. Report the hash and a short summary.

## Guardrails

- No `Co-Authored-By` trailers.
- Max 100 characters in the title.
- Prefer domain scopes over file paths.

If this skill was invoked with extra text, treat it as priority guidance.
