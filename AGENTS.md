# Pi Agent Repository

## Jack's developer conventions

Before developer work, read `/Users/jack/sifttext/nodes/ab1fe127-52f8-4bc5-b5ca-2cda47f5849e/node.md`. It is the always-read entrance; follow its task-specific children just in time. The tree owns the conventions and their evidence; do not duplicate them in report files.

Jack owns testing. Never write or run tests unless he explicitly requests and designs them. The routine check is only whether the project builds and starts. No screenshots for any purpose unless he explicitly asks for screenshots. This overrides the ponytail skill's runnable-self-check requirement. The tree's Testing node owns the complete rule.

## Extension discovery

Pi auto-loads every direct `extensions/*.ts` and `extensions/*.js` file as an extension. Each such file must default-export a valid extension factory; support modules and tests at that level will fail startup.

Keep helper and test files in a subdirectory without `index.ts`, `index.js`, or a `package.json` that declares Pi extensions. Pi only discovers a subdirectory when one of those entry points explicitly makes it an extension.

Before finishing an extension change that adds or moves source files, confirm Pi starts with normal extension discovery, without making a model request:

```bash
pi --list-models '<provider/model>'
```

Do not add a test-suite or browser-verification pass.

Do not validate only with `pi --no-extensions -e <entrypoint>`: that bypasses normal discovery and will miss accidental top-level helper/test files.

## Commit conventions

Scoped Commit format, title 100 characters or fewer:

```text
<scope>: <description>

[optional body]
```

- Scope is the narrowest stable subsystem or behavior that covers the change, derived from the behavior, not the containing directory. Use comma-separated scopes (`tool-call-clean,subagent-launch: ...`) or `treewide` when several are involved. Package and repo names are a fallback, not a default.
- No Conventional Commit prefixes (`feat`, `fix`, `chore`). No `Co-Authored-By` trailers. Ticket numbers go in the scope or a trailer.
- Body only for context a reader needs: why the change exists, what it replaces, what stays broken. Most commits need no body.
- Branch names: `<scope>/<short-slug>` or `<scope>/<ticket>-<short-slug>`.

Workflow: read `git status` and the diff, split unrelated changes into separate commits, stage only the intended files and verify with `git diff --cached --check`, then commit. Push only when asked, and report the hash. Never sweep someone else's pre-existing work into the commit you were asked to make.

When a change is too large to review as one commit, segment it into independently reviewable commits rather than describing several concerns in one message. If a hunk-level split cannot produce an intermediate commit that still builds and starts, it is one commit; do not force the split or add a test pass.

## New machine

Never put private Codex account names or identifiers in tracked code, tests, docs, or commit messages. Use generic fixtures; keep account identity and routing order in the untracked `codex-accounts.json`. Its `accounts` array is first-choice first.

Six extensions read `~/.pi/agent/codex-accounts.json`, which names your Codex accounts and is never committed. Start from the tracked template and edit it:

```bash
cp codex-accounts.example.json codex-accounts.json
```

The shape enforced by `parseRegistry` in `extensions/codex-quota-extension/store.ts`: unique `accountKey` per account, `providerId` starting with `openai-codex`, matching `credentialRef`, a `label`, `policyClass` of `stable-weekly` | `perishable` | `unknown`, and `supportedModels` as model-id strings. Also create the two local-only secrets: `~/.pi/agent/.proxy-key` (localhost proxy key) and `~/.vega-url` (VEGA endpoint).
