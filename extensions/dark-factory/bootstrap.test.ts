import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local selector auth only: no model requests, real credentials or remote endpoints.
test('launcher uses live async provider availability instead of the stale SDK snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-availability-'));
  try {
    const { ModelRuntime } = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/index.js')).href);
    const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json'), refreshFromNetwork: false });
    const model = { id: 'fixture', name: 'Fixture', provider: 'factory-selector-fixture', api: 'openai-completions',
      baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    runtime.registerNativeProvider({ id: model.provider, name: 'Fixture', getModels: () => [model],
      auth: { apiKey: { name: 'Local fixture', resolve: async () => ({ auth: { apiKey: 'fixture-only' }, source: 'local fixture' }) } },
      stream: () => { throw Error('a bootstrap test must not make model calls'); },
      streamSimple: () => { throw Error('a bootstrap test must not make model calls'); } });
    assert.ok(runtime.getModel(model.provider, model.id));
    assert.equal(runtime.getAvailableSnapshot().some(m => m.provider === model.provider), false);
    const live = await runtime.getAvailableOfType('chat', model.provider);
    assert.equal(live.some(m => m.provider === model.provider && m.id === model.id), true);
    const code = readFileSync(new URL('../subagent-launch/manager.ts', import.meta.url), 'utf8');
    assert.match(code, /await this\.ctx\.modelRegistry\.getAvailableOfType\('chat', provider\)/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
