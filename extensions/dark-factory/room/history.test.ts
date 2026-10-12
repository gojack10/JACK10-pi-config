import test from 'node:test';
import assert from 'node:assert/strict';
import { page, snapshot, flushed } from './test/page.mjs';

test('initial tail follows delayed font layout unless the reader has scrolled', async () => {
  let resolve;
  const fonts = { ready: new Promise(done => { resolve = done; }) };
  const s = snapshot(); s.posts = [{ number: 1, sender: 'aaaaaaaa', role: 'peer', text: 'latest', created: '2026-01-01T00:00:00Z' }];
  const a = page({ snapshots: { legacy: s }, fonts }), b = page({ snapshots: { legacy: s }, fonts }); await flushed();
  a.element('#transcript').scrollHeight = 2400;
  b.element('#transcript').scrollHeight = 2400; b.element('#transcript').scrollTop = 40;
  resolve(); await flushed();
  assert.equal(a.element('#transcript').scrollTop, 2400);
  assert.equal(b.element('#transcript').scrollTop, 40);
});

test('initial render is the newest page; older pages stay silent and new arrivals append', async () => {
  const s = snapshot();
  s.posts = Array.from({ length: 350 }, (_, i) => ({ number: i + 1, sender: 'aaaaaaaa', role: 'peer', text: `Entry ${i + 1} end`, created: '2026-01-01T00:00:00Z' }));
  const p = page({ snapshots: { legacy: s } }); await flushed();
  assert.equal(p.active().posts.length, 100); assert.equal(p.active().posts[0].number, 251); assert.equal(p.active().after, 350);
  assert.match(p.element('#transcript').innerHTML, /Entry 350 end/); assert.doesNotMatch(p.element('#transcript').innerHTML, /Entry 1 end/);
  assert.match(p.requests[0][0], /before=9007199254740991/);
  const log = p.element('#transcript'); log.scrollTop = 40;
  // Model a layout increase on prepend; the browser check verifies actual geometry.
  const insert = log.insertAdjacentHTML;
  log.insertAdjacentHTML = function(where, html) { insert.call(this, where, html); this.scrollHeight += 1200; };
  await p.unlockAudio(); await p.loadOlder();
  assert.equal(p.active().posts.length, 200); assert.equal(p.active().posts[0].number, 151);
  assert.equal(log.scrollTop, 1240); assert.equal(p.notices.length, 0); assert.equal(p.played.length, 0);
  const retained = log.innerHTML;
  s.posts.push({ number: 351, sender: 'aaaaaaaa', role: 'peer', text: '@JACK new arrival', created: '2026-01-01T00:00:00Z' });
  await p.poll();
  assert.ok(log.innerHTML.startsWith(retained), 'existing DOM content is not replaced for new posts');
  assert.equal(p.active().after, 351); assert.equal(p.notices.length, 1); assert.equal(p.played.length, 2);
  await p.loadOlder(); await p.loadOlder();
  assert.equal(p.active().posts.length, 351); assert.equal(p.active().hasOlder, false);
  const requests = p.requests.length; await p.loadOlder(); assert.equal(p.requests.length, requests);
});
