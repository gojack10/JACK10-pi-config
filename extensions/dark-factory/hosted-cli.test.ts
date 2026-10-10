import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('parallel factory hosted calls and dispatcher prompt use MCP CLI, not native Core', () => {
  for (const file of ['parallel-run.mjs', 'parallel-host.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /const SIFTTEXT = join\(homedir\(\), '\.local\/bin\/sifttext-mcp'\)/);
    assert.doesNotMatch(source, /['"](?:[^'"]*\/)?sifttext['"]/);
    const calls = [...source.matchAll(/(?:exec|execFileSync)\(SIFTTEXT, \['([^']+)'/g)].map(match => match[1]);
    assert.deepEqual(calls, file === 'parallel-run.mjs' ? ['get_node'] : ['sql', 'get_node']);
  }
  const controller = readFileSync(new URL('parallel-controller.mjs', import.meta.url), 'utf8');
  assert.ok(controller.includes('the `sifttext-mcp` CLI through Bash'));
  assert.ok(!controller.includes('the `sifttext` CLI through Bash'));
});
