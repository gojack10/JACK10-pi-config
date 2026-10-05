import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { loadExtensions } = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js')).href);

test('Codex alias catalogs preserve provider identity for async typed-model discovery', async () => {
  // Registration/catalog only. No credential resolution, model calls or streams.
  const { errors, runtime } = await loadExtensions([fileURLToPath(new URL('../codex-workspaces.ts', import.meta.url))], homedir());
  assert.deepEqual(errors, []);
  const providers = runtime.pendingNativeProviderRegistrations.map(entry => entry.provider);
  assert.ok(providers.some(provider => provider.id === 'openai-codex-personal'));
  for (const provider of providers) {
    const models = provider.getModels();
    const all = provider.getAllModels();
    assert.ok(all.every(model => model.provider === provider.id), `catalog alias mismatch for ${provider.id}`);
    if (provider.id === 'openai-codex-personal') assert.deepEqual(all.map(m => m.id).sort(), models.map(m => m.id).sort());
  }
});
