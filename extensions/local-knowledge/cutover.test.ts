import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const agent = join(homedir(), '.pi/agent');

test('local pointer skills resolve actual procedures and do not require hosted tools', () => {
  for (const name of ['shotgun', 'tmux-pi-subagent', 'tmux-sessions', 'pi-clean-transcript', 'git-commit', 'local-ai', 'create-factory-floor', 'browser-harness']) {
    const text = readFileSync(join(agent, 'skills', name, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /sifttext_get_node|sifttext_sql|app\.sifttext|sifttext-mcp/);
    const paths = [...text.matchAll(/`(\/Users\/jack\/[^`<>]+\/node\.md)`/g)].map(match => match[1]);
    assert(paths.length, name);
    for (const path of paths) assert(existsSync(path), path);
  }
  assert(!existsSync(join(agent, 'extensions/sifttext-mcp')), 'hosted extension is outside discovery');
});

test('stale hosted CLI names fail closed instead of forwarding to any endpoint', () => {
  const path = join(homedir(), '.local/bin/sifttext-mcp');
  const source = readFileSync(path, 'utf8');
  assert.doesNotMatch(source, /urllib|curl|https?:|SIFTTEXT_API_KEY/);
  const result = spawnSync(path, ['sql', 'query=SELECT 1'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hosted SiftText MCP is retired/);
});
