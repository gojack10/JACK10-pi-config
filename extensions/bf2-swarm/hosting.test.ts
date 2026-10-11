import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { serveRoom } from './room.mjs';
import { serveHosting } from './hosting.mjs';

const origin = 'https://factory.example.test', run = 'fixture-hosting', token = 'a'.repeat(64);
const basic = 'Basic ' + Buffer.from('owner:synthetic-password').toString('base64');
test('Basic login exchanges for a private cookie; real room retains bearer/run/Origin and bounded controls', async t => {
  let commands = 0, clock = Date.now();
  const board = { lifecycle: { status: () => ({ room_token: token, status: 'stopped' }), ownerCommand: () => { commands++; return { number: commands }; } },
    roomSnapshot: () => ({ status: 'stopped', posts: [], members: [] }) };
  const room = await serveRoom(board, { run }, { controller: () => {} });
  const hosting = await serveHosting({ origin, upstream: room.origin, run, token, basic, now: () => clock });
  t.after(async () => { await new Promise(r => hosting.close(r)); await new Promise(r => room.server.close(r)); });
  const call = (path, headers = {}, method = 'GET', body = '') => new Promise<any>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: hosting.address().port, path, method,
      headers: { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https', ...headers } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); req.end(body);
  });
  const api = `/api/${run}/state`;
  assert.equal((await call('/')).headers.location, '/login');
  assert.equal((await call('/login')).status, 401);
  const entry = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };
  assert.equal((await call('/', entry)).headers.location, '/login', 'a clicked external link can reach login');
  assert.equal((await call('/login', entry)).status, 401);
  assert.equal((await call('/', { ...entry, 'Sec-Fetch-User': '' })).status, 403);
  assert.equal((await call('/login', { ...entry, 'Sec-Fetch-Dest': 'iframe' })).status, 403);
  const plaintext = await call('/login', { 'X-Forwarded-Proto': 'http', Authorization: basic });
  assert.equal(plaintext.status, 403); assert.equal(plaintext.headers['www-authenticate'], undefined);
  assert.equal((await call('/login', { 'X-Forwarded-Proto': '' })).status, 403);
  assert.equal((await call('/login', { Authorization: basic + 'wrong' })).status, 401);
  assert.equal((await call('/login', { Authorization: basic, Origin: 'null' })).status, 403);
  assert.equal((await call('/login', { Authorization: basic, Host: 'evil.test' })).status, 403);
  assert.equal((await call(api, { Authorization: `Bearer ${token}` })).status, 401);
  const login = await call('/login', { Authorization: basic });
  assert.equal(login.status, 303);
  const set = login.headers['set-cookie'][0];
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(set.includes(flag));
  assert.ok(set.startsWith('__Host-factory='));
  const Cookie = set.split(';')[0], auth = { Cookie, Authorization: `Bearer ${token}` };
  const page = await call('/', { Cookie });
  assert.equal(page.status, 200);
  assert.match(page.body, /^<!doctype html>/i);
  assert.match(page.body, /hosting-bootstrap\.js.*\n<script type="module"/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.ok(!page.body.includes(token));
  assert.equal((await call('/hosting-bootstrap.js', { Cookie })).status, 403);
  assert.match((await call('/hosting-bootstrap.js', { Cookie, 'Sec-Fetch-Site': 'same-origin' })).body, new RegExp(token));
  assert.equal((await call('/hosting-bootstrap.js')).status, 401);
  assert.equal((await call(api, { Cookie })).status, 403);
  assert.equal((await call(api, { Cookie, Authorization: basic })).status, 403);
  assert.equal((await call(api, { ...auth, Authorization: 'Bearer ' + 'b'.repeat(64) })).status, 403);
  assert.equal((await call('/api/other/state', auth)).status, 404);
  assert.equal((await call(api, { ...auth, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(api, { ...auth, 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await call(api, { ...auth, ...entry })).status, 403, 'entry exception never covers API');
  assert.equal((await call('/hosting-bootstrap.js', { Cookie, ...entry })).status, 403);
  const state = await call(api, auth);
  assert.equal(state.status, 200); assert.equal(JSON.parse(state.body).status, 'stopped');
  const message = `/api/${run}/message`, body = JSON.stringify({ key: 'synthetic', text: 'fixture only' });
  assert.equal((await call(message, auth, 'POST', body)).status, 403);
  assert.equal((await call(message, { ...auth, Origin: origin, 'Content-Type': 'text/plain' }, 'POST', body)).status, 403);
  const postAuth = { ...auth, Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await call(message, postAuth, 'POST', 'x'.repeat(100000))).status, 413);
  assert.equal(commands, 0);
  assert.equal((await call(message, postAuth, 'POST', body)).status, 200); assert.equal(commands, 1);
  assert.equal((await call('/api/' + run + '/vote', postAuth, 'POST', body)).status, 404);
  assert.equal((await call('/../board.sqlite', auth)).status, 404);
  assert.equal((await call(api, { ...auth, Cookie: Cookie + '; ' + Cookie })).status, 401);
  clock += 24 * 60 * 60 * 1000;
  assert.equal((await call(api, auth)).status, 401);
  assert.equal((await fetch(room.origin + '/api/' + run + '/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200, 'local room remains unchanged');
});

test('remote/wildcard/plaintext origin configuration refuses startup', async () => {
  const config = { origin, upstream: 'http://127.0.0.1:1234', run, token, basic };
  for (const delta of [{ origin: 'http://factory.example.test' }, { upstream: 'http://0.0.0.0:1234' }, { run: '../other' }, { token: 'short' }, { basic: '' }])
    await assert.rejects(serveHosting({ ...config, ...delta }), /invalid private/);
});
