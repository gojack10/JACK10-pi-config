import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('legacy parallel factory has no hosted transport and refuses before model launch', () => {
  for (const file of ['parallel-run.mjs', 'parallel-host.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sifttext-mcp|callMcpTool|https:\/\/app\.sifttext/);
  }
  const host = readFileSync(new URL('parallel-host.ts', import.meta.url), 'utf8');
  assert.match(host, /Legacy parallel-factory metadata needs native ancestry\/revision migration/);
  for (const command of ['start-parallel', 'resume', 'wake', 'answer', 'controller']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('parallel-run.mjs', import.meta.url)), command], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No hosted SiftText fallback or model launch/);
  }
  const controller = readFileSync(new URL('parallel-controller.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /sifttext-mcp/);
  assert.match(controller, /local file reads at \/Users\/jack\/sifttext\/nodes/);
});
