---
name: git-commit
description: Turns a working tree diff into clean Scoped Commits. Use when you need to inspect, split, or commit repository changes.
argument-hint: <optional focus or commit guidance>
---

# Git Commit

## Scoped Commit Conventions

Use Scoped Commits format. Max 100 char title.
Do NOT add `Co-Authored-By` trailers to commits.

### Format

```
<scope>: <description>

[optional body]

[optional trailer(s)]
```

- Choose the subsystem, area, or module as the scope; it is the most important part.
- Write a short, clear description of the changes.
- Do not use Conventional Commit type prefixes such as `feat`, `fix`, or `chore`.
- For multiple scopes, prefer a more general scope, comma-separated scopes, or `treewide`, `all`, or `global` for whole-tree changes. If none is useful, use a good unscoped description.
- Put ticket numbers in the scope (`auth (PROJ-123): fix login bug`) or a trailer (`Jira-Ticket: PROJ-123`).
- Use the optional body for details contributors need to understand the project's evolution.
- Reverts, merges, and other special commits may use any appropriate format.

Examples:
- `i2c: virtio: mark device ready before registering the adapter`
- `linuxulator: Return EINVAL for invalid inotify flags`
- `gitlab-ci: update macOS image`
- `net/http/cookiejar: add godoc links`
- `xwayland: 24.1.11 -> 24.1.12`

### Branch Naming

Prefer a pragmatic scope and short slug, with an optional ticket:

```
<scope>/<ticket>-<short-slug>
<scope>/<short-slug>
```

Examples:
- `auth/123-add-login-form`
- `parser/handle-nested-blocks`
- `llm/split-prompt-sections`

### Large Diffs

Segment into logical commits. Output with:

```bash
git add <files>
```

```
<scope>: <description>

Optional body explaining the change.
```

## Workflow

1. Inspect `git status`, `git diff --stat`, and relevant file diffs.
2. Split unrelated changes into logical commits.
3. Write commit messages that follow the rules.
4. Commit with `git commit`.
5. Report the hash and a short summary.

If this skill was invoked with extra text, treat it as priority guidance.
