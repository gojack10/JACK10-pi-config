import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { loadExtensions } = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js')).href);
const directory = mkdtempSync(join(tmpdir(), 'launch-route-'));
const entry = join(directory, 'fixture.ts');
writeFileSync(entry, `import {SubagentLauncher} from ${JSON.stringify(fileURLToPath(new URL('./manager.ts', import.meta.url)))};
export default pi => pi.registerCommand('route-check', {handler: async (_,ctx) => {
  const launcher = new SubagentLauncher(pi,ctx,{});
  await launcher.validateRoutes([{provider:'fixture',model:'fixture-model',thinking:'high',mode:'task'}]);
}});`);
const { extensions, errors } = await loadExtensions([entry], directory);
assert.deepEqual(errors, []);
const check = extensions[0].commands.get('route-check').handler;
const model = { provider: 'fixture', id: 'fixture-model', reasoning: true, api: 'openai-completions', contextWindow: 128000, maxTokens: 4096, input: ['text'] };
test.after(() => rmSync(directory, { recursive: true, force: true }));

test('fresh async availability admits a route absent from the SDK compatibility snapshot', async () => {
  const calls = [];
  await check('', { modelRegistry: { find: () => model, getAvailable: () => [],
    getAvailableOfType: async (...args) => { calls.push(args); return [model]; } } });
  assert.deepEqual(calls, [['chat', 'fixture']]);
});

test('stale available snapshot cannot admit an actually unavailable route', async () => {
  await assert.rejects(check('', { modelRegistry: { find: () => model, getAvailable: () => [model], getAvailableOfType: async () => [] } }), /exact provider\/model is unavailable/);
});
