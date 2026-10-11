import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFloor, openFloor } from './runtime.mjs';
import { serveFloors } from './room.mjs';
import { main } from './cli.mjs';
import * as runtime from './runtime.mjs';
import { validateFloorLaunch } from './supervisor.mjs';

test('pending SQLite floor: API and CLI Start are atomic, chat cannot bypass, filled settings enable Start', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-staged-')), root = join(dir, 'floors'), cwd = join(dir, 'repo'), agent = join(dir, 'agent');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(agent);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'settings.json');
  writeFileSync(input, JSON.stringify({ name: 'Pending fixture', cwd, roots: ['11111111-1111-4111-8111-111111111111'],
    slots: ['a','b'].map(id => ({ id, provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high', role: '', contextWarning: 80 })) }));
  let recoveries = 0;
  const api = { ...runtime, validateFloorLaunch, ensureFloorController() { recoveries++; },
    createFloor(input, options) {
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agent;
      try { return createFloor(input, options); }
      finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
    } };
  const env = { FACTORY_ROOT: root }, out = { write(_text, cb) { cb(); } };
  await main(['create','--floor','pending','--settings',input], env, out, api);
  const floor = openFloor('pending', { root }); t.after(() => floor.close());
  const room = await serveFloors({ root, ensureController() { recoveries++; } });
  t.after(() => new Promise(resolve => room.server.close(resolve)));
  const auth = { Authorization: `Bearer ${room.token}` };
  const read = () => fetch(`${room.origin}/api/floors/pending/state`, { headers: auth }).then(r => r.json());
  const post = (action, body) => fetch(`${room.origin}/api/floors/pending/${action}`, { method: 'POST',
    headers: { ...auth, Origin: room.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual((await read()).settings.missingLaunchSettings, ['instructions','voteCondition','bootstrap','warningText','wrapupText']);
  const before = floor.snapshot();
  await assert.rejects(main(['start','--floor','pending','--key','retry'], env, out, api), /launch settings/);
  const refused = await post('start', { key: 'retry' }); assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /instructions, voteCondition/);
  assert.deepEqual(floor.snapshot(), before); assert.equal(recoveries, 0);
  assert.equal((await post('message', { key: 'chat', text: 'Generic fixture input' })).status, 200);
  assert.equal(floor.snapshot().status, 'stopped'); assert.equal(floor.snapshot().pending, false);
  assert.equal(floor.snapshot().workers.length, 0); assert.equal(recoveries, 0);
  assert.equal((await post('condition', { condition: null })).status, 200);
  assert.equal((await post('condition', { condition: 'Fixture condition' })).status, 200);
  floor.configure({ instructions: '22222222-2222-4222-8222-222222222222', bootstrap: 'Fixture boot', warningText: 'Fixture warning', wrapupText: 'Fixture drain' });
  assert.deepEqual((await read()).settings.missingLaunchSettings, []);
  assert.equal((await post('start', { key: 'retry' })).status, 200);
  assert.equal(floor.snapshot().status, 'running'); assert.equal(recoveries, 1);
  assert.equal((await post('condition', { condition: null })).status, 400);
  assert.equal(floor.settings().voteCondition, 'Fixture condition');
  assert.equal((await post('stop', { key: 'stop' })).status, 200);
  assert.equal(floor.snapshot().status, 'stopped');
});
