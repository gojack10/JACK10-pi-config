import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const fixtureRoot = join(homedir(), '.local/state/bf2-room-tests');
mkdirSync(fixtureRoot, { recursive: true });
import { join } from 'node:path';
import { configuration, openBoard, BATCH_LIMIT } from './board.mjs';
import { main as boardMain } from './cli.mjs';
import { receiver, installReceiver } from './receiver.mjs';
import boardExtension from '../../optional-extensions/bf2-board.ts';

function loadExtension(pi, env) {
  const keys = ['BF2_BOARD_DB', 'BF2_BOARD_RUN', 'BF2_BOARD_SESSION', 'BF2_BOARD_SENDER'];
  const saved = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; });
    boardExtension(pi);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
}

function fixture(t) {
  const dir = mkdtempSync(join(fixtureRoot, 'bf2-receiver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { BF2_BOARD_DB: join(dir, 'board.sqlite'), BF2_BOARD_RUN: 'test-run',
    BF2_BOARD_SESSION: 'session-a', BF2_BOARD_SENDER: 'aaaaaaaa' };
  const config = configuration(env);
  const board = openBoard(config);
  const peer = openBoard({ ...config, session: 'session-b', sender: 'bbbbbbbb' });
  t.after(() => { board.close(); peer.close(); });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id: config.session }) + '\n');
  const branch = [];
  const calls = [];
  let receipt = { status: 'admitted', delivery: 'steer' };
  const ctx = { sessionManager: {
    getSessionId: () => config.session, getSessionFile: () => file, getBranch: () => branch,
  }, getContextUsage: () => ({ percent: 37 }) };
  const pi = { async sendUserMessage(text, options) {
    calls.push({ message: { role: 'user', content: [{ type: 'text', text }] }, options });
    return receipt;
  } };
  const start = () => { const r = receiver(pi, config, ctx); t.after(() => r.close()); return r; };
  const persist = call => {
    const entry = { type: 'message', id: `entry-${branch.length}`, message: call.message };
    branch.push(entry); appendFileSync(file, JSON.stringify(entry) + '\n');
  };
  const startup = () => board.finishStartup(board.history().highwater);
  return { env, config, board, peer, ctx, pi, calls, branch, start, persist, startup,
    setReceipt: value => { receipt = value; } };
}

test('already-pending peers become one attributed USER input, steer; no self echo', async t => {
  const h = fixture(t);
  h.startup();
  h.peer.post('first'); h.board.post('own'); h.peer.post('second');
  const r = h.start();
  await Promise.all([r.pump(), r.pump()]);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.message.role, 'user');
  assert.match(call.message.content[0].text, /#1 bbbbbbbb .*"first".*\n#3 bbbbbbbb .*"second"/);
  assert.match(call.message.content[0].text, /^Context usage: 37%\.\n\nBF2 board batch/);
  assert.doesNotMatch(call.message.content[0].text, /"own"/);
  assert.equal(call.options.deliverAs, 'steer');
  assert.equal(call.options.expandPromptTemplates, false);
  assert.equal(call.options.admissionGuard(), true);
  assert.ok(h.board.pending(), 'admission alone must not consume SQLite pending');
  await r.pump(); assert.equal(h.calls.length, 1);
  h.persist(call); await r.pump();
  assert.equal(h.board.pending(), null);
  assert.equal(h.calls.length, 1);
});

test('failed admission retries identical durable batch after receiver restart', async t => {
  const h = fixture(t); h.startup(); h.peer.post('pending one'); h.peer.post('pending two');
  h.setReceipt({ status: 'rejected', reason: 'preflight', error: 'busy compacting' });
  const r = h.start(); await r.pump();
  const initial = h.calls[0];
  assert.ok(h.board.pending()); r.close();
  h.peer.post('later');
  h.setReceipt({ status: 'admitted', delivery: 'steer' });
  const next = h.start(); await next.pump();
  assert.deepEqual(h.calls[1].message, initial.message);
  assert.equal(h.calls[1].options.admissionKey, initial.options.admissionKey);
  h.persist(h.calls[1]); await next.pump();
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2].message.content[0].text, /"later"/);
  assert.doesNotMatch(h.calls[2].message.content[0].text, /pending one/);
});

test('startup waits for plain read boundary; history overlaps do not eat pending', async t => {
  const h = fixture(t); h.peer.post('startup history');
  const r = h.start(); await r.pump();
  assert.equal(h.calls.length, 0);
  await boardMain(['read'], h.env, { write(text, callback) {
    assert.match(text, /startup history/);
    h.peer.post('after snapshot');
    callback();
  } });
  await r.pump();
  assert.doesNotMatch(h.calls[0].message.content[0].text, /startup history/);
  assert.match(h.calls[0].message.content[0].text, /after snapshot/);
  h.board.history({ before: 3, limit: 100 });
  assert.ok(h.board.pending());
  h.persist(h.calls[0]); await r.pump();
  assert.equal(h.calls.length, 1);
  h.board.history(); await r.pump();
  assert.equal(h.calls.length, 1);
});

test('admitted but unpersisted batch survives restart; persisted pending reconciles without resending', async t => {
  const h = fixture(t); h.startup(); h.peer.post('recover');
  let r = h.start(); await r.pump(); r.close();
  r = h.start(); await r.pump();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].message, h.calls[0].message);
  assert.equal(h.calls[1].options.admissionKey, h.calls[0].options.admissionKey);
  h.persist(h.calls[1]); r.close();
  r = h.start(); await r.pump();
  assert.equal(h.calls.length, 2);
  assert.equal(h.board.pending(), null);
});

test('torn and blank JSONL lines do not block persisted pending reconciliation after reconstruction', async t => {
  const h = fixture(t); h.startup(); h.peer.post('first');
  let r = h.start(); await r.pump();
  const first = h.board.pending();
  appendFileSync(h.ctx.sessionManager.getSessionFile(), '{"type":"message"\n\n   \n');
  h.persist(h.calls[0]); h.peer.post('second');
  r.close(); r = h.start(); await r.pump();
  assert.equal(h.calls.length, 2, 'persisted first batch must not resend; second must be admitted');
  assert.notEqual(h.board.pending().key, first.key);
  assert.match(h.calls[1].message.content[0].text, /"second"/);
  assert.doesNotMatch(h.calls[1].message.content[0].text, /"first"/);
  h.persist(h.calls[1]); await r.pump();
  assert.equal(h.board.pending(), null);
});

test('native Pi resumes a torn tail and receiver reconciles later USER persistence', { skip: !process.env.PI_PACKAGE_DIR }, async t => {
  const h = fixture(t);
  const { SessionManager } = await import(`${process.env.PI_PACKAGE_DIR}/dist/core/session-manager.js`);
  const file = h.ctx.sessionManager.getSessionFile();
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: h.config.session,
    timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n{"type":"message"');
  h.ctx.sessionManager = SessionManager.open(file);
  h.pi.sendUserMessage = async text => {
    h.calls.push(text);
    h.ctx.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
    return { status: 'admitted', delivery: 'turn' };
  };
  h.startup(); h.peer.post('first');
  let r = h.start(); await r.pump();
  const first = h.board.pending();
  assert.ok(h.ctx.sessionManager.getBranch().at(-1).message.content[0].text.startsWith('Context usage: 37%.\n\n'));
  assert.ok(h.ctx.sessionManager.getBranch().at(-1).message.content[0].text.endsWith(first.text));
  h.peer.post('second'); r.close();
  h.ctx.sessionManager = SessionManager.open(file);
  r = h.start(); await r.pump();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1], /"second"/);
  assert.doesNotMatch(h.calls[1], /"first"/);
  await r.pump(); assert.equal(h.board.pending(), null);
});

test('in-memory branch entry is insufficient if Pi file append did not succeed', async t => {
  const h = fixture(t); h.startup(); h.peer.post('must persist');
  const r = h.start(); await r.pump();
  const entry = { type: 'message', id: 'failed-write', message: h.calls[0].message };
  h.branch.push(entry);
  await r.pump(); assert.ok(h.board.pending());
  r.close(); const next = h.start(); await next.pump();
  assert.equal(h.calls.length, 2);
});

test('disk confirmation still requires current-branch ID, USER role and exact payload; read failure retains pending', async t => {
  const h = fixture(t); h.startup(); h.peer.post('exact evidence');
  const r = h.start(); await r.pump();
  const pending = h.board.pending(), file = h.ctx.sessionManager.getSessionFile();
  const entry = { type: 'message', id: 'selected', message: h.calls[0].message };
  h.branch.push(entry);
  for (const other of [
    { ...entry, id: 'other-branch' },
    { ...entry, message: { ...entry.message, role: 'assistant' } },
    { ...entry, message: { role: 'user', content: `prefix ${pending.text} suffix` } },
  ]) {
    writeFileSync(file, JSON.stringify(other) + '\n');
    await r.pump(); assert.deepEqual(h.board.pending(), pending);
  }
  rmSync(file); await r.pump(); assert.deepEqual(h.board.pending(), pending);
  assert.equal(h.calls.length, 1);
  writeFileSync(file, JSON.stringify(entry) + '\n'); await r.pump();
  assert.equal(h.board.pending(), null);
});

test('bounded batches drain in order, never skip newly posted messages', async t => {
  const h = fixture(t); h.startup();
  for (let i = 1; i <= BATCH_LIMIT + 2; i++) h.peer.post(`message ${i}`);
  const r = h.start(); await r.pump();
  assert.equal(h.calls[0].message.content[0].text.match(/^#/gm).length, BATCH_LIMIT);
  h.peer.post('new during admission');
  h.persist(h.calls[0]); await r.pump();
  assert.match(h.calls[1].message.content[0].text, /#101 .*\n#102 .*\n#103 /);
  h.persist(h.calls[1]); await r.pump();
  assert.equal(h.board.pending(), null);
});

test('large post backlogs respect text budget without cursor skips', async t => {
  const h = fixture(t); h.startup();
  for (let i = 1; i <= 6; i++) h.peer.post(`${i}:` + 'x'.repeat(16000));
  const r = h.start(); await r.pump();
  assert.equal(h.calls[0].message.content[0].text.match(/^#/gm).length, 4);
  assert.ok(Buffer.byteLength(h.calls[0].message.content[0].text) < 65536);
  h.persist(h.calls[0]); await r.pump();
  assert.equal(h.calls[1].message.content[0].text.match(/^#/gm).length, 2);
  assert.match(h.calls[1].message.content[0].text, /#5 .*\n#6 /);
  h.persist(h.calls[1]); await r.pump();
  assert.equal(h.board.pending(), null);
});

test('consumed input is not delivered; no cursor advancement or repeat loop', async t => {
  const h = fixture(t); h.startup(); h.peer.post('consumed');
  h.setReceipt({ status: 'admitted', delivery: 'custom' });
  const r = h.start(); await r.pump(); await r.pump();
  assert.equal(h.calls.length, 1);
  assert.ok(h.board.pending());
});

test('default optional extension is inert; partial env and mismatched/nonpersistent sessions refuse', t => {
  const h = fixture(t);
  loadExtension({ on() { assert.fail('no env must register nothing'); } }, {});
  assert.throws(() => installReceiver({}, { BF2_BOARD_DB: h.config.database }), /BF2_BOARD_RUN/);
  const missingDB = join(h.config.database, 'not-created.sqlite');
  assert.throws(() => receiver(h.pi, { ...h.config, database: missingDB, session: 'another-session' }, h.ctx), /persistent Pi session matching/);
  assert.equal(existsSync(missingDB), false);
  assert.throws(() => receiver(h.pi, h.config, { sessionManager: { getSessionId: () => h.config.session, getSessionFile: () => undefined } }), /persistent/);
});

test('optional extension batches pending USER input at session_start; shutdown fences admission', async t => {
  const h = fixture(t); h.startup(); h.peer.post('pending one'); h.peer.post('pending two');
  const handlers = new Map();
  let release;
  const pi = { on(event, handler) { handlers.set(event, handler); },
    sendUserMessage(text, options) { h.calls.push({ text, options }); return new Promise(resolve => { release = resolve; }); } };
  loadExtension(pi, h.env);
  assert.equal(h.calls.length, 0);
  const started = handlers.get('session_start')({}, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].text, /#1 bbbbbbbb .*"pending one"\n#2 bbbbbbbb .*"pending two"/);
  assert.equal(h.calls[0].options.deliverAs, 'steer');
  handlers.get('session_shutdown')();
  assert.equal(h.calls[0].options.admissionGuard(), false);
  release({ status: 'rejected', reason: 'finality', error: 'closed' });
  await started;
  assert.ok(h.board.pending());
});
