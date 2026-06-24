---
name: git-commit
description: Turns a working tree diff into clean Conventional Commits. Use when you need to inspect, split, or commit repository changes.
argument-hint: <optional focus or commit guidance>
---

# Git Commit

## Git Commit Conventions

Use Conventional Commits format. Max 100 char title.
Do NOT add `Co-Authored-By` trailers to commits.

### Commit Types

| Type | Description |
|------|-------------|
| `feat` | New feature for the user |
| `fix` | Bug fix for the user |
| `docs` | Documentation changes |
| `style` | Formatting, no code change |
| `refactor` | Refactoring, no behavior change |
| `test` | Adding/refactoring tests |
| `chore` | Build tasks, no code change |
| `perf` | Performance improvements |
| `build` | Build system or dependencies |
| `ci` | CI config changes |
| `revert` | Reverts a previous commit |

### Scope

One token, kebab-case. Use domain/subsystem over file paths. Omit if cross-cutting.

Common scopes: `auth`, `api`, `db`, `ui`, `tree`, `llm`, `chat`, `context`, `parser`

### Format

```
type(scope): imperative description

CHANGES:

- Bullet describing change (7-10 words each)
- Another change
```

### Branch Naming

```
<type>[optional-scope]/<ticket>-<short-slug>
```

Examples:
- `feat/auth/123-add-login-form`
- `fix/parser-handle-nested-blocks`
- `refactor/llm-split-prompt-sections`

### Large Diffs

Segment into logical commits. Output with:

```bash
git add <files>
```

```
type(scope): description

CHANGES:

- Change 1
- Change 2
```

## Workflow

1. Inspect `git status`, `git diff --stat`, and relevant file diffs.
2. Split unrelated changes into logical commits.
3. Write commit messages that follow the rules.
4. Commit with `git commit`.
5. Report the hash and a short summary.

If this skill was invoked with extra text, treat it as priority guidance.
