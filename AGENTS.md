# Pi Agent Repository

## Extension discovery

Pi auto-loads every direct `extensions/*.ts` and `extensions/*.js` file as an extension. Each such file must default-export a valid extension factory; support modules and tests at that level will fail startup.

Keep helper and test files in a subdirectory without `index.ts`, `index.js`, or a `package.json` that declares Pi extensions. Pi only discovers a subdirectory when one of those entry points explicitly makes it an extension.

Before finishing an extension change that adds or moves source files:

```bash
# Run the focused tests.
node --test extensions/<support-directory>/*.test.ts

# Exercise normal extension discovery without making a model request.
pi --list-models '<provider/model>'
```

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

When a change is too large to review as one commit, segment it into independently reviewable commits rather than describing several concerns in one message. If a hunk-level split cannot produce an intermediate commit that passes the tests, it is one commit — measure with the test suite instead of forcing the split.

## New machine

Six extensions read `~/.pi/agent/codex-accounts.json`, which names your Codex accounts and is never committed. Start from the tracked template and edit it:

```bash
cp codex-accounts.example.json codex-accounts.json
```

The shape enforced by `parseRegistry` in `extensions/codex-quota-extension/store.ts`: unique `accountKey` per account, `providerId` starting with `openai-codex`, matching `credentialRef`, a `label`, `policyClass` of `stable-weekly` | `perishable` | `unknown`, and `supportedModels` as model-id strings. Also create the two local-only secrets: `~/.pi/agent/.proxy-key` (localhost proxy key) and `~/.vega-url` (VEGA endpoint).
