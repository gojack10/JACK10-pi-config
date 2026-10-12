import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFloors } from './room.mjs';
import { serveHosting } from '../../bf2-swarm/hosting.mjs';
import { request } from 'node:http';

export function fixtureRuntime() {
  const states = new Map(['alpha','beta'].map(id => [id, { floor: { name: id, voteCondition: 'Owner condition', database: '/private/db', bootstrap: 'private prompt' }, slots: [1,2].map(n => ({ id: String(n), provider: 'fixture', model: 'sol', thinking: 'high', role: '', contextWarning: 80 })),
    workers: [{ sender: 'peer', slot: '1', launch_config: { provider: 'fixture', model: 'old', thinking: 'high', role: 'current', contextWarning: 75 }, state: 'active', retire_requested: 'moving', context_percent: 42, database: '/private/db', credential: 'secret' }], status: 'stopped', draining: false, posts: [], members: ['peer'], known: ['peer'] }]));
  let closed = 0, recoveries = 0, selectedFloor = 'alpha';
  const calls = [], keys = new Set();
  const runtime = { ROUTES: [{ provider: 'fixture', model: 'sol', thinking: 'high' }],
    listFloors: () => [...states].map(([id,s]) => ({ id, name: s.floor.name, status: s.status, database: '/private/db' })),
    ossStatus: () => ({ selected: selectedFloor, floor: 'alpha', session: 'fixture-session', database: '/private/db' }),
    selectOssFloor: id => { if (!states.has(id)) throw Error('unknown'); selectedFloor = id; },
    openFloor(id) {
      const s = states.get(id); if (!s) throw Error('unknown');
      return { board: { history({ before, limit }) { return { posts: s.posts.filter(p => p.number < before).slice(-limit), highwater: s.posts.at(-1)?.number ?? 0 }; } },
        snapshot(after) { return { ...s, posts: s.posts.filter(p => p.number > after) }; },
        configure(patch) { calls.push([id, patch]); if (patch.slots) s.slots = patch.slots; if (patch.voteCondition) s.floor.voteCondition = patch.voteCondition; },
        command(key, action, text) { if (!keys.has(`${id}:${key}`)) { keys.add(`${id}:${key}`); if (action === 'message') { s.posts.push({ number: s.posts.length + 1, sender: 'JACK', role: 'owner', text }); } else s.status = action === 'start' ? 'running' : 'stopping'; } },
        close() { closed++; } };
    } };
  return { runtime, states, calls, closed: () => closed, recoveries: () => recoveries, ensureController: () => { recoveries++; } };
}

test('multi-floor gateway isolates state, discovers without restart, sanitizes internals and preserves capability/origin limits', async t => {
  const h = fixtureRuntime(), room = await serveFloors(h);
  t.after(() => new Promise(r => room.server.close(r)));
  const auth = { Authorization: `Bearer ${room.token}` }, base = room.origin + '/api/floors';
  const post = (id, action, body, headers = {}) => fetch(`${base}/${id}/${action}`, { method: 'POST', headers: { ...auth, Origin: room.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base, { headers: { ...auth, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await fetch(base, { headers: { ...auth, Origin: 'null' } })).status, 403);
  let discovered = await (await fetch(base, { headers: auth })).json();
  assert.deepEqual(discovered.floors.map(f => f.id), ['alpha','beta']); assert.ok(!JSON.stringify(discovered).includes('/private'));
  h.states.set('gamma', { ...h.states.get('beta'), floor: { name: 'gamma', voteCondition: 'gamma' } });
  discovered = await (await fetch(base, { headers: auth })).json(); assert.equal(discovered.floors.length, 3);
  assert.equal((await post('alpha', 'message', { key: 'same', text: 'alpha input' })).status, 200);
  assert.equal((await post('alpha', 'message', { key: 'same', text: 'alpha input' })).status, 200);
  assert.equal((await post('beta', 'message', { key: 'same', text: 'beta input' })).status, 200);
  const read = id => fetch(`${base}/${id}/state`, { headers: auth }).then(r => r.json());
  const a = await read('alpha'), b = await read('beta');
  assert.equal(a.posts.length, 1); assert.equal(a.posts[0].text, 'alpha input'); assert.equal(b.posts[0].text, 'beta input');
  assert.equal(a.status, 'stopped'); assert.equal(b.status, 'stopped');
  assert.equal(a.settings.slots[0].contextWarningPercent, 80); assert.equal(a.workers[0].model, 'old');
  assert.ok(!JSON.stringify(a).includes('/private')); assert.ok(!JSON.stringify(a).includes('secret')); assert.ok(!JSON.stringify(a).includes('private prompt'));
  const slots = a.settings.slots.map(s => ({ ...s, contextWarningPercent: 70 }));
  assert.equal((await post('alpha', 'configuration', { slots })).status, 200);
  assert.equal(h.calls[0][1].slots[0].contextWarning, 70);
  assert.equal((await post('alpha', 'condition', { condition: 'Dogfood' })).status, 200);
  assert.equal((await read('alpha')).settings.voteCondition, 'Dogfood'); assert.equal((await read('beta')).settings.voteCondition, 'Owner condition');
  assert.equal((await post('beta', 'oss', {})).status, 200);
  assert.equal((await (await fetch(base, { headers: auth })).json()).oss.selectedFloor, 'beta');
  for (const body of [{ slots: [] }, { slots: [...slots, { id: 'bad', executable: '/bin/sh' }] }, { slots, database: '/private' }]) assert.equal((await post('alpha', 'configuration', body)).status, 400);
  assert.equal((await post('alpha', 'message', { key: 'bad', text: 'x', sender: 'peer' })).status, 400);
  assert.equal((await post('alpha', 'message', { key: 'bad', text: 'x' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('alpha', 'message', { key: 'bad', text: 'x'.repeat(300000) })).status, 413);
  for (const query of ['after=-1','after=NaN','after=9007199254740992','after=0&after=1','before=0','before=-1','before=9007199254740992','before=1&after=0','before=1&before=2','db=private']) assert.equal((await fetch(`${base}/alpha/state?${query}`, { headers: auth })).status, 400);
  for (const path of ['/api/other/state','/api/floors/alpha/vote','/floor.sqlite','/runtime.mjs']) assert.equal((await fetch(room.origin + path, { headers: auth })).status, 404);
  assert.equal((await fetch(room.origin + '/')).status, 200); assert.equal((await fetch(room.origin + '/room.js')).status, 200);
  assert.ok(h.closed() > 0); assert.equal(h.recoveries(), 0, 'stopped chat never recovers a controller');
});

test('room history GET reads the newest bounded page and pages backwards without recovery', async t => {
  const h = fixtureRuntime(), room = await serveFloors(h);
  t.after(() => new Promise(r => room.server.close(r)));
  h.states.get('alpha').posts = Array.from({ length: 350 }, (_, i) => ({ number: i + 1, sender: 'peer', role: 'peer', text: `entry ${i + 1}` }));
  const read = query => fetch(`${room.origin}/api/floors/alpha/state?${query}`, { headers: { Authorization: `Bearer ${room.token}` } }).then(r => r.json());
  const tail = await read(`before=${Number.MAX_SAFE_INTEGER}`), older = await read(`before=${tail.posts[0].number}`);
  assert.equal(tail.posts.length, 100); assert.equal(tail.posts[0].number, 251); assert.equal(tail.posts.at(-1).number, 350);
  assert.equal(older.posts[0].number, 151); assert.equal(older.posts.at(-1).number, 250);
  assert.equal(tail.status, 'stopped'); assert.equal(h.recoveries(), 0); assert.equal(h.calls.length, 0);
  assert.equal((await read('after=350')).posts.length, 0);
});

test('failed recovery reports saved input and same-key retry stays idempotent', async t => {
  const h = fixtureRuntime(); let broken = true;
  h.states.get('alpha').status = 'running';
  const room = await serveFloors({ ...h, ensureController() { if (broken) throw Error('private prerequisite/path'); } });
  t.after(() => new Promise(resolve => room.server.close(resolve)));
  const send = () => fetch(`${room.origin}/api/floors/alpha/message`, { method: 'POST', headers: { Authorization: `Bearer ${room.token}`, Origin: room.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'retry', text: 'persist fixture input' }) });
  const response = await send(); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'Saved, controller recovery pending');
  assert.equal(h.states.get('alpha').posts.length, 1); broken = false;
  assert.equal((await send()).status, 200); assert.equal(h.states.get('alpha').posts.length, 1);
});

test('explicit multi-floor hosting keeps login/cookie/bearer and only forwards approved operations', async t => {
  const h = fixtureRuntime(), room = await serveFloors(h), origin = 'https://factory.example.test';
  const basic = 'Basic ' + Buffer.from('owner:fixture').toString('base64');
  const hosting = await serveHosting({ mode: 'floors', origin, upstream: room.origin, token: room.token, basic });
  t.after(async () => { await new Promise(r => hosting.close(r)); await new Promise(r => room.server.close(r)); });
  const call = (path, headers = {}, method = 'GET', body = '') => new Promise<any>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: hosting.address().port, path, method, headers: { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https', ...headers } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal((await call('/api/floors')).status, 401);
  const login = await call('/login', { Authorization: basic }), Cookie = login.headers['set-cookie'][0].split(';')[0];
  const auth = { Cookie, Authorization: `Bearer ${room.token}` };
  assert.equal((await call('/api/floors', { Cookie })).status, 403);
  assert.equal((await call('/api/floors', auth)).status, 200);
  const bootstrap = await call('/hosting-bootstrap.js', { Cookie, 'Sec-Fetch-Site': 'same-origin' });
  assert.match(bootstrap.body, /\\"multi\\":true/); assert.equal((await call('/hosting-bootstrap.js', { Cookie })).status, 403);
  assert.equal((await call('/api/floors/alpha/state', { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/floors/alpha/close', auth, 'POST', '{}')).status, 404);
  const postAuth = { ...auth, Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await call('/api/floors/beta/condition', postAuth, 'POST', JSON.stringify({ condition: 'Hosting fixture' }))).status, 200);
  assert.equal(h.states.get('beta').floor.voteCondition, 'Hosting fixture');
});
