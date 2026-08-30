# Codex workspaces tests

Run the focused regression from the agent repository root:

```sh
node --test extensions/codex-workspaces/*.test.ts
```

Keep tests in this directory. Pi auto-loads every top-level `extensions/*.ts` and `extensions/*.js` file as a runtime extension; the layout regression fails if a test entrypoint appears there.
