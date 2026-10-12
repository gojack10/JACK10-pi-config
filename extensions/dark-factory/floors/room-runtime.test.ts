import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveFloors } from './room.mjs';

// Parent integration uses the local runtime. An explicit path allows read-only
// sibling-source consumption before merging; all runtime state remains /tmp.
const moduleURL = process.env.FACTORY_RUNTIME_MODULE ? pathToFileURL(process.env.FACTORY_RUNTIME_MODULE) : new URL('./runtime.mjs', import.meta.url);
test('real runtime consumer seam: discovery, SQLite-isolated owner input/config/condition and stopped OSS selection', { skip: !existsSync(moduleURL) }, async t => {
  const runtime = await import(moduleURL.href), dir = mkdtempSync(join(tmpdir(), 'factory-room-runtime-')), root = join(dir, 'floors'), cwd = join(dir, 'repo');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = name => ({ name, cwd, roots: ['11111111-1111-4111-8111-111111111111'], instructions: '22222222-2222-4222-8222-222222222222', voteCondition: '33333333-3333-4333-8333-333333333333', bootstrap: 'Fixture only', warningText: 'Fixture only', wrapupText: 'Fixture only',
    slots: [{ id: 'sol', provider: 'openai-codex-test', model: 'gpt-6.1-sol', thinking: 'high', role: 'fixture', contextWarning: 80 },
      { id: 'oss', provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh', role: 'fixture', contextWarning: 75 }] });
  runtime.createFloor(settings('alpha'), { root, id: 'alpha' }); runtime.createFloor(settings('beta'), { root, id: 'beta' });
  let recoveries = 0;
  const room = await serveFloors({ root, runtime, ensureController: () => { recoveries++; } });
  t.after(() => new Promise(resolve => room.server.close(resolve)));
  const auth = { Authorization: `Bearer ${room.token}` }, base = room.origin + '/api/floors';
  const read = id => fetch(`${base}/${id}/state`, { headers: auth }).then(r => r.json());
  const post = (id, action, body) => fetch(`${base}/${id}/${action}`, { method: 'POST', headers: { ...auth, Origin: room.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const list = await (await fetch(base, { headers: auth })).json();
  assert.deepEqual(list.floors.map(f => f.id), ['alpha','beta']); assert.equal(list.oss.status, 'unassigned');
  assert.equal((await read('alpha')).status, 'stopped');
  assert.equal((await post('beta', 'oss', {})).status, 200);
  assert.equal((await read('beta')).status, 'stopped', 'selection cannot start a floor');
  assert.equal((await (await fetch(base, { headers: auth })).json()).oss.selectedFloor, 'beta');
  const slots = (await read('alpha')).settings.slots.map(s => ({ ...s, role: 'edited fixture', contextWarningPercent: 65 }));
  assert.equal((await post('alpha', 'configuration', { slots })).status, 200);
  assert.equal((await read('alpha')).settings.slots[0].role, 'edited fixture');
  assert.equal((await read('beta')).settings.slots[0].role, 'fixture');
  assert.equal((await post('alpha', 'condition', { condition: 'Revised owner condition' })).status, 400);
  assert.equal((await post('alpha', 'condition', { condition: '44444444-4444-4444-8444-444444444444' })).status, 200);
  assert.equal((await read('alpha')).settings.voteCondition, '44444444-4444-4444-8444-444444444444');
  assert.equal((await read('beta')).settings.voteCondition, '33333333-3333-4333-8333-333333333333');
  assert.equal((await post('alpha', 'configuration', { slots: slots.map(s => ({ ...s, model: 'arbitrary-model' })) })).status, 400);
  assert.equal((await read('alpha')).settings.slots[0].model, 'gpt-6.1-sol');
  assert.equal((await post('alpha', 'message', { key: 'fixture-input', text: 'Alpha only fixture input' })).status, 200);
  assert.equal((await post('alpha', 'message', { key: 'fixture-input', text: 'Alpha only fixture input' })).status, 200);
  assert.equal((await read('alpha')).posts.filter(p => p.role === 'owner').length, 1);
  assert.equal((await read('beta')).posts.filter(p => p.role === 'owner').length, 0);
  assert.ok(recoveries > 0, 'command requests native recovery only through injected fake');
  const floor = runtime.openFloor('alpha', { root });
  try {
    const current = floor.settings().slots[0];
    assert.equal(floor.board.lifecycle.addWorker('fixture-session', 'aaaaaaaa', '%fixture', null, { slot: current.id, launchConfig: current }), true);
    floor.configure({ slots: floor.settings().slots.map(s => ({ ...s, role: 'next fixture role' })) });
  } finally { floor.close(); }
  const configured = await read('alpha');
  assert.equal(configured.workers[0].slotId, 'sol'); assert.equal(configured.workers[0].model, 'gpt-6.1-sol');
  assert.equal(configured.workers[0].role, 'edited fixture'); assert.equal(configured.workers[0].contextWarningPercent, 65);
  assert.equal(configured.workers[0].contextPercent, null); assert.equal(configured.workers[0].phase, 'launching');
  assert.equal(configured.settings.slots[0].role, 'next fixture role', 'native current occupant config remains unchanged');
  const encoded = JSON.stringify(await read('alpha'));
  assert.ok(!encoded.includes(root)); assert.ok(!encoded.includes(cwd)); assert.ok(!encoded.includes('bootstrap'));
});
