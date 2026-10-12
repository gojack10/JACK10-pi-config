import test from 'node:test';
import assert from 'node:assert/strict';
import { page, snapshot, flushed } from './test/page.mjs';

test('sounds/desktop default on; audio unlock and desktop permission remain gesture-only', async () => {
  const p = page({ snapshots: { legacy: snapshot() }, permission: 'default' }); await flushed();
  assert.equal(p.active().prefs.sound, true); assert.equal(p.active().prefs.desktop, true);
  assert.equal(p.contexts.length, 0); assert.equal(p.permissionRequests(), 0); assert.equal(p.notices.length, 0);
  await p.unlockAudio(); assert.equal(p.contexts.length, 1); assert.equal(p.played.length, 0);
  await p.click('#notification-toggle'); assert.equal(p.permissionRequests(), 1);
  p.notify(p.active(), [{ role: 'owner', text: '@JACK', number: 1 }, { role: 'system', text: '@JACK', number: 2 }]);
  assert.equal(p.notices.length, 0); assert.equal(p.played.length, 0);
  p.notify(p.active(), [{ role: 'peer', sender: 'peer', text: '`@JACK` https://example.test/@JACK @JACK@example.test', number: 2 }]);
  assert.equal(p.notices.length, 0, 'code/URL/email text is not a real mention'); p.played.length = 0;
  p.notify(p.active(), [{ role: 'peer', sender: 'peer', text: '@JACK ready', number: 3 }]);
  assert.equal(p.played.length, 2); assert.equal(p.notices.length, 1);
  assert.deepEqual(p.played, [.015, .14500000000000002]);
  await p.click('#sound-toggle'); assert.equal(p.active().prefs.sound, false);
  await p.click('#notification-toggle'); assert.equal(p.active().prefs.desktop, false);
  p.notify(p.active(), [{ role: 'peer', sender: 'peer', text: '@JACK muted', number: 4 }]);
  assert.equal(p.notices.length, 1); assert.equal(p.played.length, 2);
  await p.click('#sound-toggle'); assert.equal(p.contexts.length, 1);
  p.failSynthesis(); assert.doesNotThrow(() => p.notify(p.active(), [{ role: 'peer', text: 'audio lost', number: 5 }]));
});

test('all initial pages silent; cross-floor @JACK notifications focus destination and dedupe browser tabs', async () => {
  const snapshots = { alpha: snapshot('alpha'), beta: snapshot('beta') }, shared = new Map();
  snapshots.beta.posts = Array.from({ length: 100 }, (_, i) => ({ role: 'peer', sender: 'peer', text: '@JACK old history', number: i + 1 }));
  const a = page({ multi: true, snapshots, shared }), b = page({ multi: true, snapshots, shared }); await flushed();
  assert.equal(a.notices.length, 0); assert.equal(a.selected(), 'alpha');
  await a.poll(); await b.poll(); // Exhaust initial 100-post page, still silent.
  snapshots.beta.posts.push({ role: 'peer', sender: 'peer', text: '@JACK new beta mention', number: 101 });
  await a.poll(); await b.poll();
  assert.equal(a.notices.length, 1); assert.equal(b.notices.length, 0);
  assert.equal(a.notices[0].title, 'beta · peer'); assert.match(a.notices[0].options.body, /new beta/);
  a.notices[0].onclick(); assert.equal(a.selected(), 'beta'); assert.equal(a.notices[0].closed, true);
  a.active().prefs.desktop = false;
  snapshots.beta.posts.push({ role: 'peer', sender: 'peer', text: '@JACK muted beta', number: 102 });
  await a.poll(); assert.equal(a.notices.length, 1);
  snapshots.alpha.posts.push({ role: 'peer', sender: 'peer', text: '@JACK alpha', number: 1 });
  await a.poll(); assert.equal(a.notices.length, 2, 'mute scoped to beta');
});

test('background peer arrivals resume gesture-unlocked audio without focus or visibility gates', async () => {
  const p = page({ snapshots: { legacy: snapshot() } }); await flushed();
  p.document.visibilityState = 'hidden'; p.document.hasFocus = () => false;
  p.notify(p.active(), [{ role: 'peer', text: 'not unlocked', number: 1 }]);
  assert.equal(p.contexts.length, 0, 'background arrivals cannot create a context');
  p.document.events.keydown(); await flushed();
  assert.equal(p.contexts[0].state, 'running', 'first keyboard gesture unlocks audio');
  p.contexts[0].state = 'suspended';
  p.notify(p.active(), [{ role: 'peer', text: 'background arrival', number: 2 }]); await flushed();
  assert.equal(p.contexts[0].state, 'running'); assert.equal(p.played.length, 2);
  p.contexts[0].state = 'suspended'; p.failAudio();
  p.notify(p.active(), [{ role: 'peer', text: 'resume refused', number: 3 }]); await flushed();
  assert.equal(p.played.length, 2, 'autoplay refusal is contained, not falsely reported as sound');
});

test('blocked permission never requests silently or produces fake desktop alerts', async () => {
  const p = page({ snapshots: { legacy: snapshot() }, permission: 'denied' }); await flushed();
  p.notify(p.active(), [{ role: 'peer', sender: 'peer', text: '@JACK', number: 1 }]);
  assert.equal(p.notices.length, 0); assert.equal(p.permissionRequests(), 0);
  assert.equal(p.element('#notification-toggle').textContent, 'alerts blocked');
});
