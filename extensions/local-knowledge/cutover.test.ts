import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const agent = join(homedir(), '.pi/agent');
const requirePi = createRequire(join(homedir(), '.local/share/pi-mono/packages/coding-agent/package.json'));
const { createJiti } = requirePi('jiti');

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

test('both commands load full local bodies without a network request or model turn', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('unexpected network request'); };
  try {
    const jiti = createJiti(import.meta.url);
    for (const [name, id] of [
      ['sifttext-commit', 'c72d552d-3499-445b-a8d5-05d0ff7824f2'],
      ['local-refresh', 'd36f646c-f719-4383-843b-e4458e76465a'],
    ]) {
      let command: any;
      let message = '';
      const notices: string[] = [];
      const { default: register } = await jiti.import(join(agent, 'extensions', name, 'index.ts'));
      register({ registerCommand: (_name: string, value: any) => { command = value; },
        sendUserMessage: (text: string) => { message = text; } });
      await command.handler('fixture focus', { ui: { notify: (text: string, level: string) => { notices.push(level); }, input: async () => '' } });
      assert.deepEqual(notices, ['success']);
      assert(message.includes(readFileSync(join(homedir(), 'sifttext/nodes', id, 'node.md'), 'utf8')));
      if (name === 'sifttext-commit') {
        assert.match(message, /explicit human approval/);
        assert.match(message, /native private-worktree publication/);
      } else assert.match(message, /grants no model request/);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('stale hosted CLI names fail closed instead of forwarding to any endpoint', () => {
  const path = join(homedir(), '.local/bin/sifttext-mcp');
  const source = readFileSync(path, 'utf8');
  assert.doesNotMatch(source, /urllib|curl|https?:|SIFTTEXT_API_KEY/);
  const result = spawnSync(path, ['sql', 'query=SELECT 1'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hosted SiftText MCP is retired/);
});
