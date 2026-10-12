import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
const requirePi = createRequire(join(pkg, 'package.json'));
const { createJiti } = requirePi('jiti');

// Exercise the real extension in isolation; never edit the live cache or use real credentials.
test('cached MCP tools survive startup outages; stale refresh falls back and calls still fail honestly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sifttext-mcp-startup-'));
  const originalFetch = globalThis.fetch, originalKey = process.env.SIFTTEXT_API_KEY;
  let requests = 0;
  process.env.SIFTTEXT_API_KEY = 'fixture-not-a-secret';
  globalThis.fetch = async () => { requests++; throw new Error('Fixture network unavailable'); };
  try {
    for (const scenario of ['fresh', 'stale', 'missing']) {
      const dir = join(root, scenario, 'sifttext-mcp');
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(source, 'index.ts'), join(dir, 'index.ts'));
      symlinkSync(join(source, 'node_modules'), join(dir, 'node_modules'), 'dir');
      symlinkSync(join(dirname(source), '_shared'), join(dirname(dir), '_shared'), 'dir');
      const cache = join(dir, 'tool-cache.json');
      const schemas = JSON.stringify([{ name: 'sifttext_get_node', description: 'Fixture read', inputSchema: {
        type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'],
      } }]);
      if (scenario !== 'missing') writeFileSync(cache, schemas);
      if (scenario === 'stale') { const old = new Date(Date.now() - 48 * 3600 * 1000); utimesSync(cache, old, old); }
      const jiti = createJiti(import.meta.url, { alias: {
        '@sinclair/typebox': requirePi.resolve('typebox'),
      } });
      const { default: register } = await jiti.import(join(dir, 'index.ts'));
      const tools: any[] = [];
      const before = requests;
      await register({ registerTool: (tool: any) => tools.push(tool) });
      assert.equal(tools.length, scenario === 'missing' ? 0 : 1);
      if (scenario === 'missing') continue;
      assert.equal(tools[0].name, 'sifttext_get_node');
      assert.equal(readFileSync(cache, 'utf8'), schemas, 'outage never rewrites cached schemas');
      if (scenario === 'fresh') assert.equal(requests, before, 'warm-cache registration needs no network');
      else assert(requests > before, 'stale cache attempts refresh before fallback');
      await assert.rejects(tools[0].execute('fixture-call', { node_id: 'fixture' }, undefined), /Fixture network unavailable/);
      assert.equal(tools.length, 1, 'a failed call does not remove the tool');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SIFTTEXT_API_KEY;
    else process.env.SIFTTEXT_API_KEY = originalKey;
    rmSync(root, { recursive: true, force: true });
  }
});
