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
