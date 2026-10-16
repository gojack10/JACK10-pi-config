import test from 'node:test';
import assert from 'node:assert/strict';
import { page, snapshot, flushed } from './test/page.mjs';

test('discovery adds floors without restart; messages, drafts, cached state and votes stay floor scoped', async () => {
  const snapshots = { alpha: snapshot('alpha'), beta: snapshot('beta') }, p = page({ multi: true, snapshots }); await flushed();
  snapshots.alpha.posts.push({ number: 1, role: 'peer', sender: 'aaaaaaaa', text: 'Only alpha', created: '2026-01-01T00:00:00Z' });
  snapshots.beta.posts.push({ number: 1, role: 'peer', sender: 'aaaaaaaa', text: 'Only beta', created: '2026-01-01T00:00:00Z' });
  snapshots.beta.vote = { electorate: [{ sender: 'aaaaaaaa', answer: 'yes' }, { sender: 'bbbbbbbb', answer: null }], reason: 'Beta vote' };
  await p.poll(); assert.match(p.element('#transcript').innerHTML, /Only alpha/); assert.doesNotMatch(p.element('#transcript').innerHTML, /Only beta/);
  p.element('#message').value = 'alpha draft'; p.element('#message').events.input();
  p.selectFloor('beta'); assert.equal(p.element('#message').value, '');
  assert.match(p.element('#transcript').innerHTML, /Only beta/); assert.match(p.element('#request').innerHTML, /1 \/ 2 yes/);
  p.element('#message').value = 'beta message'; p.element('#message').events.input();
  await p.element('#composer').events.submit({ preventDefault() {} });
  const post = p.requests.find(([path, options]) => options.method === 'POST');
  assert.equal(post[0], '/api/floors/beta/message'); assert.equal(JSON.parse(post[1].body).text, 'beta message');
  assert.equal(p.element('#message').value, '');
  p.selectFloor('alpha'); assert.equal(p.element('#message').value, 'alpha draft');
  snapshots.gamma = snapshot('gamma'); await p.poll(); assert.match(p.element('#floor-tabs').innerHTML, /gamma/);
});

test('legacy single-room pause retains proposer attribution and never requests floor discovery', async () => {
  const s = snapshot(); delete s.settings;
  s.vote = { reason: 'Legacy peer pause', proposer: 'peer-session', electorate: [{ session: 'peer-session', sender: 'aaaaaaaa', answer: 'yes' }, { sender: 'bbbbbbbb', answer: null }] };
  const p = page({ snapshots: { legacy: s } }); await flushed();
  assert.match(p.element('#request').innerHTML, /Called by/); assert.match(p.element('#request').innerHTML, /aaaaaaaa/);
  assert.equal(p.requests.some(([path]) => path.startsWith('/api/floors')), false);
});

test('validated operator provider aliases stay selectable even when route templates are generic', async () => {
  const s = snapshot(); s.settings.slots = s.settings.slots.map(slot => ({ ...slot, provider: 'openai-codex-fixture' }));
  const p = page({ multi: true, snapshots: { alpha: s } }); await flushed(); p.openSettings();
  assert.match(p.element('#slot-fields').innerHTML, /value="openai-codex-fixture\/gpt-6\.1-sol" selected/);
});

test('Pathfinder form defaults, optional removal, assignment payload and configured aliases remain floor scoped', async () => {
  const s = snapshot(), p = page({ multi: true, snapshots: { alpha: s, beta: snapshot('beta') } });
  await flushed(); p.openSettings();
  assert.equal(p.element('#pathfinder-enabled').checked, false);
  assert.equal(p.element('#pathfinder-fields').disabled, true);
  assert.match(p.element('#pathfinder-fields').innerHTML, /value="openai-codex-personal\/gpt-6\.1-sol" selected/);
  assert.doesNotMatch(p.element('#pathfinder-fields').innerHTML, /name="(?:bootstrap|question|codeRoots|resources|resultDestination|goal|entry|agent)"/);
  assert.match(p.element('#pathfinder-fields').innerHTML, /Uses the floor’s goal/);
  p.element('#pathfinder-enabled').checked = true; p.element('#pathfinder-enabled').events.change();
  assert.equal(p.element('#pathfinder-fields').hidden, false); assert.equal(p.element('#pathfinder-fields').disabled, false);
  const values = { route: 'openai-codex-personal/gpt-6.1-sol', thinking: 'high', contextWarning: '80',
    continuation: '' };
  p.element('#pathfinder-fields').querySelector = selector => ({ value: values[selector.slice(6, -1)] });
  await p.element('#pathfinder-settings').events.submit({ preventDefault() {} });
  const configured = JSON.parse(p.requests.find(([path]) => path.endsWith('/configuration'))[1].body);
  assert.deepEqual(Object.keys(configured), ['pathfinder']);
  assert.equal(configured.pathfinder.provider, 'openai-codex-personal');
  assert.deepEqual(configured.pathfinder, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80, continuation: null });
  s.settings.pathfinder = { ...configured.pathfinder, provider: 'openai-codex-fixture' };
  s.workers = [{ slotId: '@PATHFINDER', provider: 'openai-codex-test', model: 'gpt-6-luna', thinking: 'high', phase: 'active', contextPercent: 12 }];
  await p.poll(); p.openSettings();
  assert.match(p.element('#pathfinder-fields').innerHTML, /value="openai-codex-fixture\/gpt-6\.1-sol" selected/);
  assert.match(p.element('#pathfinder-current').textContent, /gpt-6-luna/);
  p.element('#pathfinder-enabled').checked = false;
  await p.element('#pathfinder-settings').events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(p.requests.filter(([path]) => path.endsWith('/configuration')).at(-1)[1].body), { pathfinder: null });
  p.selectFloor('beta'); p.openSettings(); assert.equal(p.element('#pathfinder-enabled').checked, false);
  p.selectFloor('alpha');
  await p.element('#pathfinder-settings').events.submit({ preventDefault() {} });
  assert.equal(p.requests.filter(([path]) => path.endsWith('/configuration')).length, 2, 'switching floors closes stale form');
});

test('settings expose current versus next config, advisory unknown usage, owner condition and safe OSS move', async () => {
  const snapshots = { alpha: snapshot() }, p = page({ multi: true, snapshots });
  snapshots.alpha.workers = [{ sender: 'aaaaaaaa', slotId: '1', provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh', role: 'current role', phase: 'draining' }];
  await flushed(); p.openSettings();
  assert.match(p.element('#slot-fields').innerHTML, /Current: aaaaaaaa/);
  assert.match(p.element('#slot-fields').innerHTML, /current role/); assert.match(p.element('#slot-fields').innerHTML, /Next model/);
  assert.match(p.element('#slot-fields').innerHTML, /Context usage: unknown/);
  assert.equal(p.element('#vote-condition').value, 'Owner chosen condition');
  p.element('#vote-condition').value = 'Dogfood only'; await p.element('#condition-settings').events.submit({ preventDefault() {} });
  assert.equal(JSON.parse(p.requests.find(([path]) => path.endsWith('/condition'))[1].body).condition, 'Dogfood only');
  await p.click('#oss-select'); assert.deepEqual(JSON.parse(p.requests.find(([path]) => path.endsWith('/oss'))[1].body), {});
  const field = id => ({ dataset: { slot: id }, querySelector(selector) { return { value: ({ '[name=route]': 'openai-codex-test/gpt-6.1-sol', '[name=thinking]': 'high', '[name=role]': 'next role', '[name=contextWarningPercent]': '75' })[selector] }; } });
  p.element('#slot-fields').children = Array.from({ length: 11 }, (_, i) => field(String(i)));
  await p.element('#slot-settings').events.submit({ preventDefault() {} });
  assert.equal(p.element('#settings-error').textContent, 'Configure 0–10 slots');
  assert.equal(p.requests.some(([path]) => path.endsWith('/configuration')), false);
  p.element('#slot-fields').children = [field('1'), field('2')];
  await p.element('#slot-settings').events.submit({ preventDefault() {} });
  const configured = JSON.parse(p.requests.find(([path]) => path.endsWith('/configuration'))[1].body);
  assert.equal(configured.slots.length, 2); assert.equal(configured.slots[0].role, 'next role');
  assert.equal(configured.slots[0].contextWarningPercent, 75);
  for (const count of [1, 0]) {
    p.element('#slot-fields').children = Array.from({ length: count }, (_, i) => field(String(i)));
    await p.element('#slot-settings').events.submit({ preventDefault() {} });
    assert.equal(JSON.parse(p.requests.filter(([path]) => path.endsWith('/configuration')).at(-1)[1].body).slots.length, count);
  }
});
