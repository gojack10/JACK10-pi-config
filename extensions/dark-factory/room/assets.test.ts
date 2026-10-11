import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { serveRoom } from '../../bf2-swarm/room.mjs';
import { messageMarkup as legacyMarkup } from '../../bf2-swarm/room/markup.mjs';
import { messageMarkup } from './markup.mjs';

const files = ['index.html', 'room.js', 'markup.mjs', 'colors_and_type.css',
  ...['Light', 'Medium', 'SemiBold', 'Italic'].map(f => `fonts/JetBrainsMono-${f}.woff2`)];
const canonical = file => new URL(file, import.meta.url);
const legacy = file => new URL(`../../bf2-swarm/room/${file}`, import.meta.url);

test('canonical assets and old callers share one source; old HTTP URLs still serve all modules/fonts', async t => {
  assert.equal(legacyMarkup, messageMarkup);
  const board = { lifecycle: { status: () => ({ room_token: 'a'.repeat(64) }),
    ownerCommand: () => { throw Error('static checks must never mutate'); } },
    roomSnapshot: () => ({ posts: [], members: [] }) };
  const room = await serveRoom(board, { run: 'fixture-assets' }, { controller: () => { throw Error('no recovery'); } });
  t.after(() => new Promise<void>(r => room.server.close(() => r())));
  for (const file of files) {
    assert.match(readlinkSync(legacy(file)), /^\.\.\//, 'compatibility is a relative symlink, not a duplicate');
    assert.equal(realpathSync(legacy(file)), realpathSync(canonical(file)));
    const expected = readFileSync(canonical(file));
    assert.deepEqual(readFileSync(legacy(file)), expected);
    const response = await fetch(room.origin + (file === 'index.html' ? '/' : `/${file}`));
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    if (/\.(js|mjs)$/.test(file)) assert.equal(response.headers.get('content-type'), 'text/javascript');
    if (file.endsWith('.woff2')) assert.equal(response.headers.get('content-type'), 'font/woff2');
  }
  const html = readFileSync(canonical('index.html'), 'utf8');
  assert.match(html, /<title>Dark Factory \| SiftText<\/title>/);
  assert.match(html, /<h1>Dark Factory<\/h1>/);
  assert.match(html, /<script type="module" src="room\.js"><\/script>/);
  assert.match(readFileSync(canonical('room.js'), 'utf8'), /^import .* from '\.\/markup\.mjs';/);
  assert.equal((await fetch(room.origin + '/api/fixture-assets/state')).status, 403);
  assert.equal((await fetch(room.origin + '/api/other/state', { headers: { Authorization: `Bearer ${room.token}` } })).status, 404);
});

test('unmodified canonical and compatible room modules load, render real metadata, and retain auth/draft keys', async t => {
  const names = ['document', 'location', 'sessionStorage', 'localStorage', 'setInterval', 'fetch'];
  const originals = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => { for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  } });
  for (const [i, source] of [canonical('room.js'), legacy('room.js')].entries()) {
    const elements = new Map(), requests = [], timers = [];
    const element = selector => {
      if (!elements.has(selector)) elements.set(selector, { value: '', events: {}, attrs: {}, dataset: {}, scrollHeight: 0, clientHeight: 0, scrollTop: 0,
        addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attrs[name] = value; } });
      return elements.get(selector);
    };
    const saved = new Map([['bf2-room', JSON.stringify({ run: 'fixture-modules', token: 'synthetic-capability' })],
      ['bf2-pending:fixture-modules', JSON.stringify({ key: 'retry-key', text: 'Retained draft' })]]);
    const snapshot = { status: 'running', known: ['aaaaaaaa'], members: ['aaaaaaaa'], posts: [
      { number: 1, sender: 'aaaaaaaa', role: 'peer', created: '2026-01-01T00:00:00Z', text: '<peer> @JACK' },
      { number: 2, sender: 'JACK', role: 'owner', created: '2026-01-01T00:00:01Z', text: 'Fixture owner metadata' },
    ] };
    const globals = { document: { querySelector: element, addEventListener() {} }, location: { hash: '' },
      sessionStorage: { getItem: key => saved.get(key) ?? null,
        setItem() { throw Error('must not rename storage or mutate saved draft'); }, removeItem() { throw Error('must not clear saved draft'); } },
      localStorage: { getItem: () => null, setItem() {} },
      setInterval: (fn, ms) => { timers.push(ms); return 0; },
      fetch: async (path, options) => { requests.push([path, options]); return { ok: true, json: async () => snapshot }; } };
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    await import(source.href + `?fixture=${i}`); // Real module loading, including its relative markup import.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], '/api/fixture-modules/state?after=0');
    assert.equal(requests[0][1].method, 'GET');
    assert.equal(requests[0][1].headers.Authorization, 'Bearer synthetic-capability');
    assert.deepEqual(timers, [1000]);
    assert.equal(element('#message').value, 'Retained draft');
    assert.equal(element('#status').textContent, 'running');
    assert.match(element('#transcript').innerHTML, /&lt;peer&gt;/);
    assert.match(element('#transcript').innerHTML, /data-mention="JACK"/);
    assert.match(element('#transcript').innerHTML, /class="name jack">JACK/);
    assert.match(element('#members').innerHTML, /swarm agent/);
    assert.match(element('#members').innerHTML, /factory owner/);
    assert.equal(element('#request').hidden, true);
    assert.equal(element('#sound-toggle').attrs['aria-pressed'], 'true', 'sounds enabled by default; no audio context before a gesture');
  }
});
