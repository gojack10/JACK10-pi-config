import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { main as jobCli } from '../dark-factory/floors/job-cli.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createFloor, openFloor } from '../dark-factory/floors/runtime.mjs';
import { openBoard } from './board.mjs';
import { installWorker, budgetType, goalCheck, goalCheckType, GOAL_CHECK_MS } from './worker.mjs';
import { receiver } from './receiver.mjs';
import { launchJob, cancelJob } from './jobs.mjs';

const node = '11111111-1111-4111-8111-111111111111';
const eventually = async check => {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('isolated job did not produce expected evidence');
};
function fixture(t, contextWarning = 70, specialist = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-retirement-'))), cwd = join(dir, 'repo'), root = join(dir, 'floors');
  mkdirSync(cwd);
  for (const args of [['init'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Fixture']]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(cwd, 'draft.txt'), 'unfinished draft\n');
  const slots = ['a','b'].map(id => ({ id, provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high', contextWarning }));
  const pathfinder = specialist ? { provider: slots[0].provider, model: slots[0].model, thinking: slots[0].thinking, contextWarning } : null;
  createFloor({ name: 'Fixture', cwd, roots: [node], instructions: node, voteCondition: node, slots, pathfinder,
    bootstrap: 'Fixture bootstrap', warningText: `Context stop: {percent}% on floor {floor}. Read node ${node} now.`, wrapupText: `Retirement requested: {reason}; {status}; {floor}. Read node ${node} now.` }, { id: 'fixture', root });
  const floor = openFloor('fixture', { root }); floor.command('start', 'start');
  const session = randomUUID(), sender = 'aaaaaaaa';
  if (specialist) floor.command('review', 'message', '@PATHFINDER fixture review');
  floor.board.lifecycle.addWorker(session, sender, '%1', undefined, { slot: specialist ? '@PATHFINDER' : 'a',
    launchConfig: { ...floor.board.lifecycle.status().config, ...(specialist ? floor.settings().pathfinder : floor.settings().slots[0]) } });
  const config = { ...floor.config, session, sender }, board = openBoard(config); board.lifecycle.ready();
  const env = { FACTORY_FLOOR: floor.id, FACTORY_ROOT: root, FACTORY_DB: floor.database, FACTORY_SESSION: session, FACTORY_SENDER: sender };
  t.after(async () => {
    for (const row of floor.board.jobs.list()) if (!row.terminal?.drained && existsSync(join(row.manifest.dir, 'control.json'))) {
      // Test-only cleanup, never a live floor or user process.
      try { await cancelJob(row); } catch { /* Missing-runner test explicitly drains its test group below. */ }
    }
    board.close(); floor.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cwd, root, floor, board, config, env, session };
}
function fake(t, h, drained = () => true) {
  const handlers = new Map(), entries = [], sent = [], deliveries = []; let percent = 0, shuts = 0;
  const file = join(h.dir, 'session.jsonl'); writeFileSync(file, '{}\n');
  const ctx = { sessionManager: { getSessionId: () => h.session, getSessionFile: () => file, getEntries: () => entries, getBranch: () => entries }, getContextUsage: () => ({ percent }), shutdown: () => shuts++ };
  const pi = { on: (event, fn) => handlers.set(event, fn), getSettings: () => ({ steeringMode: 'all', followUpMode: 'all' }), appendEntry: (type, data) => entries.push({ type: 'custom', customType: type, data }),
    async sendUserMessage(text, options) {
      if (!options.admissionGuard()) return { status: 'rejected' };
      const handled = handlers.get('input')({ source: 'extension', text }, ctx);
      sent.push(text); deliveries.push({ options, handled }); return { status: 'admitted', delivery: handled ? 'custom' : 'steer' };
    } };
  const api = installWorker(pi, h.env, drained);
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  return { handlers, ctx, pi, sent, deliveries, entries, api, usage: n => percent = n, shuts: () => shuts };
}

test('threshold transitions durably before next tool; locator expands; native capture/drain/final tools survive', async t => {
  const h = fixture(t); let drained = false; const f = fake(t, h, () => drained);
  await f.handlers.get('session_start')({}, f.ctx);
  for (const n of [NaN, undefined, 69.9]) { f.usage(n); await f.handlers.get('turn_end')({}, f.ctx); }
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /^Context budget: 60% used\./);
  f.usage(70);
  const blocked = await f.handlers.get('tool_call')({ toolName: 'subagent_launch' }, f.ctx);
  assert.ok(blocked.block); assert.match(blocked.reason, /Context stop: 70% on floor fixture/);
  assert.equal(h.board.lifecycle.status().workers[0].retire_requested, 'context threshold');
  assert.equal(h.board.lifecycle.acceptsInput(), false);
  for (const toolName of ['sifttext_get_node','sifttext_edit_crystallization','read','edit','write','bash','codemode','bash_jobs','bash_tail','bash_kill','messaged_outcome']) {
    assert.equal(await f.handlers.get('tool_call')({ toolName }, f.ctx), undefined, toolName);
  }
  assert.ok((await f.handlers.get('tool_call')({ toolName: 'bash_bg' }, f.ctx)).block);
  assert.throws(() => launchJob(h.board, h.config, { id: randomUUID(), command: 'true', cwd: h.cwd }), /working active peer/);
  assert.throws(() => h.board.lifecycle.pause('pause', node), /retirement/);
  await f.handlers.get('turn_end')({}, f.ctx); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1], `Context stop: 70% on floor fixture. Read node ${node} now.\n\n${goalCheck(h.board.lifecycle.status())}`);
  assert.deepEqual(f.handlers.get('input')({ source: 'extension', text: 'ordinary peer message' }, f.ctx), { action: 'handled' });
  assert.equal(h.board.lifecycle.acceptsInput(), false, 'ordinary input cannot clear the durable transition');
  assert.equal(f.handlers.get('input')({ source: 'interactive', text: 'Human scoped instruction' }, f.ctx), undefined);
  assert.equal(f.handlers.get('input')({ source: 'rpc', text: 'Human RPC instruction' }, f.ctx), undefined);
  assert.equal(f.handlers.get('input')({ source: 'extension', text: 'SYSTEM (background-jobs): All 1 background job(s) in this batch finished.' }, f.ctx), undefined);
  assert.deepEqual(f.handlers.get('cache_warming_decision')({}, f.ctx), { action: 'stop' });
  f.api.done('Draft retained; job responsibility in final message', f.ctx);
  f.handlers.get('agent_settled')({}, f.ctx); assert.equal(f.shuts(), 0);
  drained = true; f.handlers.get('agent_settled')({ interruption: { kind: 'context' } }, f.ctx); assert.equal(f.shuts(), 0);
  f.handlers.get('agent_settled')({}, f.ctx); assert.equal(f.shuts(), 1);
  assert.equal(h.floor.snapshot().workers[0].state, 'retired'); assert.equal(h.floor.snapshot().workers[0].cleaned, 0, 'safe settlement is not real Pi exit/cleanup');
  assert.equal(readFileSync(join(h.cwd, 'draft.txt'), 'utf8'), 'unfinished draft\n');
});

test('budget steers reference the current floor goal without project IDs; threshold retirement stays unchanged', async t => {
  const h = fixture(t, 100), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const observe = async n => { f.usage(n); await f.handlers.get('turn_end')({}, f.ctx); };
  for (const n of [undefined, null, NaN, Infinity, -10, '20', 0, 9.9]) await observe(n);
  assert.equal(f.sent.length, 0);
  for (let bucket = 10; bucket <= 90; bucket += 10) {
    await observe(bucket); await observe(bucket + 0.1); await observe(bucket + 9.9);
    assert.equal(f.sent.length, bucket / 10);
    assert.equal(f.sent.at(-1), `Context budget: ${bucket}% used. ${goalCheck(h.board.lifecycle.status())}`);
    const { options, handled } = f.deliveries.at(-1);
    assert.equal(options.deliverAs, 'steer'); assert.equal(options.expandPromptTemplates, false);
    assert.equal(options.admissionKey, `factory-context-budget:${h.session}:${bucket}`);
    assert.equal(handled, undefined, 'actual USER input must not be swallowed');
    assert.equal(h.board.lifecycle.status().workers[0].retire_requested, null);
  }
  assert.deepEqual(f.entries.filter(e => e.customType === budgetType), Array.from({ length: 9 }, (_, i) => ({ type: 'custom', customType: budgetType, data: { bucket: (i + 1) * 10 } })));
  assert.equal(h.board.lifecycle.status().workers[0].context_percent, 99.9);
  f.handlers.get('session_shutdown')({}, f.ctx); await f.handlers.get('session_start')({}, f.ctx);
  await observe(99.9); await observe(10); await observe(90);
  assert.equal(f.sent.length, 9, 'restart and context decreases must not replay old buckets');
  await observe(100); await observe(101);
  assert.equal(f.sent.length, 10);
  assert.equal(f.sent.at(-1), `Context stop: 100% on floor fixture. Read node ${node} now.\n\n${goalCheck(h.board.lifecycle.status())}`);
  assert.equal(h.board.lifecycle.status().workers[0].retire_requested, 'context threshold');
  assert.equal(h.board.lifecycle.acceptsInput(), false);
});

test('budget steer skips crossed buckets, retries rejected admission and ignores unrelated/retiring sessions', async t => {
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const observe = async n => { f.usage(n); await f.handlers.get('turn_end')({}, f.ctx); };
  const send = f.pi.sendUserMessage; let reject = true;
  f.pi.sendUserMessage = (...args) => reject ? Promise.resolve({ status: 'rejected' }) : send(...args);
  await observe(21); assert.equal(f.sent.length, 0); assert.ok(!f.entries.some(e => e.customType === budgetType));
  reject = false; await observe(29); await observe(29.9); await observe(11);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /^Context budget: 20%/);
  await observe(69.9); assert.equal(f.sent.length, 2); assert.match(f.sent[1], /^Context budget: 60%/);
  const id = f.ctx.sessionManager.getSessionId;
  f.ctx.sessionManager.getSessionId = () => randomUUID(); await observe(90);
  assert.equal(f.sent.length, 2); f.ctx.sessionManager.getSessionId = id;
  h.floor.board.lifecycle.requestRetirement(h.session, 'Fixture retirement'); await observe(90);
  assert.equal(f.sent.length, 3); assert.match(f.sent.at(-1), /^Retirement requested:/);
  await observe(90); assert.equal(f.sent.length, 3);
  f.api.done('Fixture done', f.ctx); await observe(90); assert.equal(f.sent.length, 3);
});

test('budget admission guard suppresses a concurrent owner stop without consuming the bucket', async t => {
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const send = f.pi.sendUserMessage;
  f.pi.sendUserMessage = (...args) => { h.floor.command('stop', 'stop'); return send(...args); };
  f.usage(10); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.sent.length, 0); assert.ok(!f.entries.some(e => e.customType === budgetType));
  f.pi.sendUserMessage = send;
  f.usage(60); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /^Retirement requested: stopping/);
  assert.ok(!f.entries.some(e => e.customType === budgetType), 'stopped floors emit retirement, not budget ticks');
});

const flushTimers = () => new Promise(resolve => setImmediate(resolve));
for (const specialist of [false, true]) test(`five-minute USER reminders wake idle and steer busy ${specialist ? 'Pathfinder' : 'peer'} sessions; reload preserves cadence`, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const h = fixture(t, 70, specialist), f = fake(t, h); f.usage(50);
  await f.handlers.get('session_start')({}, f.ctx);
  const initialPosts = h.floor.snapshot().posts.length;
  const advance = async ms => { t.mock.timers.tick(ms); await flushTimers(); };
  await advance(120000);
  f.handlers.get('session_shutdown')({}, f.ctx); await f.handlers.get('session_start')({}, f.ctx);
  await advance(GOAL_CHECK_MS - 120000 - 1); assert.equal(f.sent.length, 0);
  await advance(1); assert.equal(f.sent.length, 1, 'idle worker receives real USER input');
  assert.equal(h.floor.snapshot().posts.length, initialPosts + 1, 'five-minute reminder is visible as a synthetic board post');
  assert.match(h.floor.snapshot().posts.at(-1).text, /^\[Synthetic five-minute check-in\].*\nContext usage: 50%\./);
  const text = goalCheck(h.board.lifecycle.status());
  assert.equal(f.sent[0], `Context usage: 50%.\n\nFive-minute reminder. ${text}`);
  assert.match(text, /current goal node ID resolved through.*11111111/);
  assert.equal(text.split('\n')[1], 'What do I now know? What have I observed? Is anything uncertain? Has any observation changed or contributed to your goal?');
  assert.match(text, /eligible peers.*current ballot condition and vote accordingly\./);
  assert.doesNotMatch(text, /Do not merely acknowledge|Pathfinder reports its assessment|Finishing a reply or assignment|prescribed reasoning method|Stop or context retirement takes precedence/);
  assert.deepEqual(f.deliveries.map(d => d.handled), [undefined]);
  assert.equal(f.deliveries[0].options.deliverAs, 'steer'); assert.equal(f.deliveries[0].options.expandPromptTemplates, false);
  f.handlers.get('agent_start')({}, f.ctx);
  f.usage(10); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.sent.at(-1), `Context budget: 10% used. ${text}`);
  await advance(GOAL_CHECK_MS); assert.equal(f.sent.length, 3, 'busy worker still receives the five-minute steer');
  assert.equal(f.sent.at(-1), `Context usage: 10%.\n\n${f.sent[0].split('\n\n')[1]}`);
  assert.notEqual(f.deliveries[0].options.admissionKey, f.deliveries.at(-1).options.admissionKey);
  f.handlers.get('agent_settled')({}, f.ctx);
  t.mock.timers.setTime(Date.now() + 4 * GOAL_CHECK_MS);
  await advance(1000); assert.equal(f.sent.length, 4, 'missed intervals coalesce, no catch-up burst');
  await advance(1000); assert.equal(f.sent.length, 4);
  assert.equal(h.floor.snapshot().posts.length, initialPosts + 3, 'each admitted reminder creates one visible synthetic post');
  f.handlers.get('session_shutdown')({}, f.ctx);
  await advance(GOAL_CHECK_MS); assert.equal(f.sent.length, 4, 'shutdown releases the timer');
});

test('five-minute admission retries rejection, does not count handled input, and serializes slow sends', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const send = f.pi.sendUserMessage;
  f.pi.sendUserMessage = async () => ({ status: 'rejected' });
  t.mock.timers.tick(GOAL_CHECK_MS); await flushTimers();
  assert.equal(f.entries.filter(e => e.customType === goalCheckType).length, 1);
  f.pi.sendUserMessage = async () => ({ status: 'admitted', delivery: 'custom' });
  t.mock.timers.tick(1000); await flushTimers();
  assert.equal(f.entries.filter(e => e.customType === goalCheckType).length, 1);
  let release, sends = 0;
  f.pi.sendUserMessage = async (...args) => { sends++; await new Promise(resolve => { release = resolve; }); return send(...args); };
  t.mock.timers.tick(1000); await flushTimers();
  t.mock.timers.tick(10000); await flushTimers(); assert.equal(sends, 1);
  release(); await flushTimers(); assert.equal(f.sent.length, 1);
  assert.equal(f.entries.filter(e => e.customType === goalCheckType).length, 2);
  t.mock.timers.tick(1000); await flushTimers(); assert.equal(sends, 1);
});

test('five-minute admission rechecks concurrent Stop and never consumes a rejected tick', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const send = f.pi.sendUserMessage;
  f.pi.sendUserMessage = (...args) => { h.floor.command('stop', 'stop'); return send(...args); };
  t.mock.timers.tick(GOAL_CHECK_MS); await flushTimers();
  assert.equal(f.sent.length, 0); assert.equal(f.entries.filter(e => e.customType === goalCheckType).length, 1);
  t.mock.timers.tick(1000); await flushTimers();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /^Retirement requested:/);
});

for (const boundary of ['context', 'slot removed', 'done', 'stop', 'waiting', 'human interruption', 'other session']) {
  test(`five-minute reminder respects ${boundary}`, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
    const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
    if (boundary === 'context') f.usage(70);
    if (boundary === 'slot removed') h.floor.board.lifecycle.requestRetirement(h.session, boundary);
    if (boundary === 'done') f.api.done('Fixture done', f.ctx);
    if (boundary === 'stop') h.floor.command('stop', 'stop');
    if (boundary === 'waiting') {
      h.floor.configure({ slots: [h.floor.settings().slots[0]] });
      const vote = h.board.lifecycle.pause('ready', node); h.board.lifecycle.vote(vote.number, 'yes');
    }
    if (boundary === 'human interruption') f.handlers.get('agent_settled')({ interruption: { kind: 'human' } }, f.ctx);
    if (boundary === 'other session') f.ctx.sessionManager.getSessionId = () => 'other';
    t.mock.timers.tick(GOAL_CHECK_MS); await flushTimers();
    assert.ok(!f.sent.some(text => text.startsWith('Five-minute reminder.')));
    if (boundary === 'context') {
      assert.equal(h.board.lifecycle.status().workers[0].retire_requested, 'context threshold');
      assert.equal(f.sent[0], `Context stop: 70% on floor fixture. Read node ${node} now.\n\n${goalCheck(h.board.lifecycle.status())}`);
    }
    if (boundary === 'human interruption') {
      f.handlers.get('agent_start')({}, f.ctx);
      t.mock.timers.tick(1000); await flushTimers(); assert.equal(f.sent.length, 1, 'explicit continuation permits reminders again');
    }
  });
}

test('rejected routing retries without losing the durable context stop', async t => {
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  const send = f.pi.sendUserMessage; let reject = true;
  f.pi.sendUserMessage = (...args) => reject ? Promise.resolve({ status: 'rejected' }) : send(...args);
  f.usage(70); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(h.board.lifecycle.acceptsInput(), false); assert.equal(f.sent.length, 0);
  reject = false; await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0], /Read node/);
});

test('retirement preserves ordinary backlog without owner replay; context override cannot undo Stop/done', async t => {
  const h = fixture(t), f = fake(t, h); await f.handlers.get('session_start')({}, f.ctx);
  h.board.finishStartup(h.board.history().highwater);
  h.floor.command('before', 'message', 'Old human input'); const ordinary = h.board.pending();
  f.usage(70); await f.handlers.get('turn_end')({}, f.ctx);
  const r = receiver(f.pi, h.config, f.ctx); t.after(() => r.close());
  const sent = f.sent.length;
  h.floor.command('override', 'message', 'New explicit human question'); await r.pump();
  assert.equal(f.sent.length, sent, 'retiring workers have no separate owner-input replay queue');
  assert.equal(h.board.pending(), null);
  assert.equal(h.board.ownerInputAllowed(ordinary.text), false);
  h.floor.board.lifecycle.overrideContextStop(h.session, 'Human authorized safe continuation of this occupant');
  assert.equal(h.board.lifecycle.acceptsInput(), true); assert.deepEqual(h.board.pending(), ordinary);
  await f.handlers.get('turn_end')({}, f.ctx); assert.equal(h.board.lifecycle.acceptsInput(), true, 'override survives another high usage observation');
  h.floor.command('stop', 'stop'); await f.handlers.get('turn_end')({}, f.ctx);
  assert.match(f.sent.at(-1), /stopping/); assert.equal(h.board.lifecycle.acceptsInput(), false);
  assert.throws(() => h.floor.board.lifecycle.overrideContextStop(h.session, 'Cannot undo owner Stop'), /not a stopped floor/);
  f.api.done('Final done', f.ctx);
  assert.equal(h.board.lifecycle.canReceiveOwner(), false);
  assert.throws(() => h.floor.board.lifecycle.overrideContextStop(h.session, 'Cannot undo final done'), /not a stopped floor/);
});

test('native independent command survives launcher exit, final done and worker cleanup; one global terminal event survives stopped/no peers and startup truncation', async t => {
  const h = fixture(t), id = randomUUID(), command = join(h.dir, 'command.sh');
  writeFileSync(command, 'sleep 1; printf "retained output\\n"; exit 7\n');
  const launch = spawnSync(resolve('bin/factory-job'), ['launch','--key',id,'--command-file',command,'--owner',node], { env: { ...process.env, ...h.env }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  const row = h.board.jobs.list()[0]; assert.equal(row.id, id); assert.equal(row.manifest.origin, h.session);
  h.board.lifecycle.done(`Job ${id}; owner ${node}; output/receipt ${row.manifest.dir}; result interpretation remains with swarm`);
  h.board.lifecycle.settled(); h.floor.board.lifecycle.cleaned(h.session); h.floor.command('stop', 'stop');
  assert.equal(h.floor.snapshot().status, 'stopped');
  const terminal = await eventually(() => h.floor.board.jobs.list()[0].terminal);
  assert.equal(terminal.state, 'exited'); assert.equal(terminal.code, 7); assert.equal(terminal.drained, true);
  const receipt = JSON.parse(readFileSync(row.manifest.receipt, 'utf8')); assert.equal(receipt.id, id); assert.equal(receipt.code, 7);
  assert.match(readFileSync(row.manifest.log, 'utf8'), /retained output/);
  for (let i = 0; i < 3; i++) h.floor.board.jobs.observe();
  assert.equal(h.floor.board.history({ limit: 100 }).posts.filter(p => p.text.startsWith(`Independent job ${id}:`)).length, 1);
  assert.equal(h.floor.snapshot().status, 'stopped'); assert.equal(h.floor.snapshot().workers.length, 1, 'completion never revives peers');
  assert.equal(readFileSync(join(h.cwd, 'draft.txt'), 'utf8'), 'unfinished draft\n');
  for (let i = 0; i < 45; i++) h.floor.command(`later-${i}`, 'message', `Unrelated retained owner input ${i}`);
  h.floor.command('cancel-queued-start', 'stop');
  h.floor.command('next-start', 'start');
  const session = randomUUID(); h.floor.board.lifecycle.addWorker(session, 'bbbbbbbb', '%2', undefined, { slot: 'b', launchConfig: { ...h.floor.board.lifecycle.status().config, ...h.floor.settings().slots[1] } });
  const next = openBoard({ ...h.floor.config, session, sender: 'bbbbbbbb' }); t.after(() => next.close()); next.lifecycle.ready();
  const history = next.history(); assert.ok(!history.posts.some(p => p.text.startsWith(`Independent job ${id}:`)));
  assert.ok(history.wake.every(p => p.role === 'system'), 'only terminal job notices bypass the startup history limit');
  assert.ok(history.wake.some(p => p.text.startsWith(`Independent job ${id}:`)), 'durable terminal event is retained beyond latest-30 history');
  next.finishStartup(history.highwater); assert.match(next.pending().text, new RegExp(`Independent job ${id}:`));
  assert.doesNotMatch(next.pending().text, /Unrelated retained owner input/);
});

test('global handling shrinks compact startup replay without losing failures, history or receipts', async t => {
  const h = fixture(t), ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    h.board.jobs.register({ id, dir: h.dir, owner: node }, () => {});
    assert.throws(() => h.board.jobs.handle(id, 'not done'), /no terminal result/);
    h.board.jobs.terminal(id, { id, state: 'exited', code: id === ids[0] ? 7 : 0, signal: null, drained: true });
  }
  assert.throws(() => h.board.jobs.handle(ids[0], ' '), /nonempty/);
  const initial = h.board.history();
  assert.equal(initial.wake.length, 2);
  assert.ok(initial.wake.every(p => !p.text.includes('Artifacts:') && !p.text.includes('receipt:')));
  assert.ok(initial.wake.some(p => p.text.includes('exit 7')));
  assert.ok(!initial.posts.some(p => p.text.startsWith('Independent job ')), 'plain startup does not repeat full receipts');
  h.board.finishStartup(initial.highwater);
  const delivered = h.board.pending(); h.board.confirmPersisted(delivered.key);
  assert.equal(h.board.jobs.pending().length, 2, 'delivery is not handling');
  const before = h.board.jobs.list().map(j => ({ id: j.id, receipt: j.terminal, post: j.terminal_number }));
  const handled = await jobCli(['handled', '--key', ids[0], '--reason', 'Fixture failure inspected; repair recorded in owning node'], h.env);
  assert.equal(handled.session, h.session);
  assert.deepEqual(h.floor.board.jobs.handle(ids[0], 'duplicate handling'), handled, 'first handling wins across sessions');
  assert.equal(h.board.jobs.pending().length, 1);
  const session = randomUUID();
  h.floor.board.lifecycle.addWorker(session, 'bbbbbbbb', '%2', undefined, { slot: 'b', launchConfig: { ...h.floor.board.lifecycle.status().config, ...h.floor.settings().slots[1] } });
  const next = openBoard({ ...h.floor.config, session, sender: 'bbbbbbbb' }); t.after(() => next.close()); next.lifecycle.ready();
  const snapshot = next.history();
  assert.equal(snapshot.wake.length, 1); assert.ok(snapshot.wake[0].text.includes(ids[1]));
  next.finishStartup(snapshot.highwater);
  assert.ok(!next.pending().text.includes(ids[0]), 'handled failure is not replayed to replacements');
  assert.ok(next.pending().text.includes('factory-job handled'));
  assert.equal(next.history({ limit: 100 }).posts.filter(p => p.text.startsWith('Independent job ')).length, 2, 'full history is retained');
  assert.deepEqual(next.jobs.list().map(j => ({ id: j.id, receipt: j.terminal, post: j.terminal_number })), before);
  assert.equal((await jobCli(['pending'], h.env)).length, 1);
});

test('legacy job tables migrate without marking historical results handled', t => {
  const h = fixture(t), id = randomUUID(), db = new DatabaseSync(h.floor.database);
  db.exec('CREATE TABLE factory_jobs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, terminal TEXT, terminal_number INTEGER UNIQUE)');
  db.prepare('INSERT INTO factory_jobs VALUES (?,?,?,?)').run(id, JSON.stringify({ id, dir: h.dir }), JSON.stringify({ id, state: 'exited', code: 1, signal: null, drained: true }), 999);
  db.close();
  const migrated = openBoard(h.config); t.after(() => migrated.close());
  assert.equal(migrated.jobs.list()[0].handled, null);
  assert.equal(migrated.jobs.pending().length, 1);
  assert.equal(migrated.jobs.list()[0].terminal.code, 1);
});

test('explicit outside stopped operation preserves Stop, worker refusal, authorization and immutable job custody', async t => {
  const h = fixture(t), reason = 'Human approved this disposable stopped-floor cancellation fixture';
  const input = { id: randomUUID(), command: 'printf "ready\\n"; sleep 20', cwd: h.cwd, owner: node, stoppedOperation: reason };
  assert.throws(() => launchJob(h.board, h.config, input), /outside authorized operator/);
  assert.throws(() => launchJob(h.floor.board, h.floor.config, input), /stopped, drained floor/);
  const command = join(h.dir, 'stopped-command.sh'); writeFileSync(command, input.command);
  const args = ['launch','--floor','fixture','--key',input.id,'--command-file',command,'--cwd',h.cwd,'--owner',node,'--stopped-operation',reason];
  for (const name of ['FACTORY_FLOOR','FACTORY_DB','FACTORY_SESSION','FACTORY_SENDER','BF2_BOARD_SESSION','BF2_BOARD_SENDER','BF2_SWARM_WORKER']) {
    await assert.rejects(jobCli(args, { FACTORY_ROOT: h.root, [name]: '' }), /outside authorized operator/);
  }
  h.floor.command('stop', 'stop');
  assert.throws(() => launchJob(h.floor.board, h.floor.config, input), /stopped, drained floor/);
  h.board.lifecycle.done('Fixture drained'); h.board.lifecycle.settled(); h.floor.board.lifecycle.cleaned(h.session); h.floor.board.lifecycle.advanceDrain();
  assert.equal(h.floor.snapshot().status, 'stopped');
  assert.throws(() => launchJob(h.floor.board, h.floor.config, { ...input, stoppedOperation: undefined }), /running floor/);
  for (const bad of [{ stoppedOperation: '' }, { stoppedOperation: 'x'.repeat(4097) }, { owner: null }]) {
    assert.throws(() => launchJob(h.floor.board, h.floor.config, { ...input, ...bad }), /owner and bounded explicit authorization/);
  }
  assert.equal(h.floor.board.jobs.list().length, 0);
  const launch = spawnSync(resolve('bin/factory-job'), args, { env: { ...process.env, FACTORY_ROOT: h.root }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  const row = h.floor.board.jobs.list()[0]; assert.equal(row.manifest.stoppedOperation, reason); assert.equal(row.manifest.owner, node);
  assert.equal(row.manifest.origin, h.floor.config.session);
  await eventually(() => existsSync(row.manifest.log) && readFileSync(row.manifest.log, 'utf8').includes('ready'));
  assert.equal(launchJob(h.floor.board, h.floor.config, input).id, input.id);
  assert.throws(() => launchJob(h.floor.board, h.floor.config, { ...input, stoppedOperation: 'other grant' }), /different input/);
  const cancel = spawnSync(resolve('bin/factory-job'), ['cancel','--floor','fixture','--key',input.id], { env: { ...process.env, FACTORY_ROOT: h.root }, encoding: 'utf8' });
  assert.equal(cancel.status, 0, cancel.stderr);
  const terminal = JSON.parse(cancel.stdout); assert.equal(terminal.state, 'cancelled'); assert.equal(terminal.drained, true);
  assert.equal(h.floor.board.jobs.list().length, 1);
  assert.equal(h.floor.snapshot().status, 'stopped'); assert.equal(h.floor.snapshot().workers.filter(w => !w.cleaned).length, 0);
  assert.equal(readFileSync(join(h.cwd, 'draft.txt'), 'utf8'), 'unfinished draft\n');
});

test('explicit cancellation is separately identified, drains the native group, retains output and deduplicates its event', async t => {
  const h = fixture(t), row = launchJob(h.board, h.config, { id: randomUUID(), command: 'printf "draft output\\n"; sleep 20', cwd: h.cwd });
  await eventually(() => existsSync(join(row.manifest.dir, 'process.json')) && existsSync(row.manifest.log));
  h.floor.command('stop', 'stop'); assert.equal(h.board.jobs.list()[0].terminal, null, 'worker Stop is not cancellation');
  const command = spawnSync(resolve('bin/factory-job'), ['cancel','--key',row.id], { env: { ...process.env, ...h.env }, encoding: 'utf8' });
  assert.equal(command.status, 1); assert.match(command.stderr, /outside authorized operator/);
  const receipt = await cancelJob(row); assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.drained, true);
  await eventually(() => h.board.jobs.list()[0].terminal);
  assert.equal((await cancelJob(h.board.jobs.list()[0])).id, row.id, 'cancel terminal retry never signals another process');
  h.board.jobs.observe(); assert.equal(h.floor.board.history({ limit: 100 }).posts.filter(p => p.text.startsWith(`Independent job ${row.id}:`)).length, 1);
  assert.match(readFileSync(row.manifest.log, 'utf8'), /draft output/);
});

test('wrong cancellation identity cannot signal a running job; an immutable key cannot change command or duplicate launch', async t => {
  const h = fixture(t), id = randomUUID(), row = launchJob(h.board, h.config, { id, command: 'sleep 20', cwd: h.cwd });
  await eventually(() => existsSync(join(row.manifest.dir, 'process.json')));
  await assert.rejects(cancelJob({ ...row, id: randomUUID() }), /identity mismatch/);
  assert.equal(h.board.jobs.list()[0].terminal, null);
  assert.equal(launchJob(h.board, h.config, { id, command: 'sleep 20', cwd: h.cwd }).id, id);
  assert.equal(h.board.jobs.list().length, 1);
  assert.throws(() => launchJob(h.board, h.config, { id, command: 'echo different', cwd: h.cwd }), /different input/);
  assert.equal((await cancelJob(row)).drained, true);
});

test('missing START and malformed terminal receipts produce retained uncertainty without claiming execution or acceptance', t => {
  const h = fixture(t);
  for (const type of ['missing-start','malformed-terminal']) {
    const id = randomUUID(), dir = join(h.dir, type);
    h.board.jobs.register({ id, dir, owner: null }, () => {
      mkdirSync(dir);
      if (type === 'malformed-terminal') writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ id: 'not-this-job', state: 'exited', code: 0, drained: true }));
    });
  }
  const jobs = h.board.jobs.observe();
  assert.ok(jobs.every(j => j.terminal.state === 'abnormal' && j.terminal.code === null && !j.terminal.drained));
  assert.match(jobs[0].terminal.error, /START receipt missing/); assert.match(jobs[1].terminal.error, /invalid/);
  h.board.jobs.observe();
  assert.equal(h.floor.board.history({ limit: 100 }).posts.filter(p => p.text.startsWith('Independent job ')).length, 2);
});

test('separate native SQLite observers race to one terminal system event, without worker credentials', async t => {
  const h = fixture(t), id = randomUUID(), dir = join(h.dir, 'observed-job');
  h.board.jobs.register({ id, dir, owner: null }, () => {
    mkdirSync(dir); writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ id, state: 'exited', code: 0, signal: null, drained: true }));
  });
  const module = new URL('./board.mjs', import.meta.url).href;
  const source = `import {openBoard} from ${JSON.stringify(module)}; const b=openBoard(${JSON.stringify(h.floor.config)}); console.log(b.jobs.observe()[0].terminal_number); b.close();`;
  const results = await Promise.all([1,2].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',source]); let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  })));
  assert.equal(results[0], results[1]);
  assert.equal(h.floor.board.history({ limit: 100 }).posts.filter(p => p.text.startsWith(`Independent job ${id}:`)).length, 1);
});

test('shell exit does not credit completion before ordinary process-group descendants and output drain', async t => {
  const h = fixture(t), row = launchJob(h.board, h.config, { id: randomUUID(), command: '(sleep 0.5; printf "late descendant output\\n") & exit 3', cwd: h.cwd });
  await eventually(() => existsSync(join(row.manifest.dir, 'process.json')));
  assert.equal(h.board.jobs.list()[0].terminal, null);
  const receipt = await eventually(() => h.board.jobs.list()[0].terminal);
  assert.equal(receipt.code, 3); assert.equal(receipt.drained, true); assert.equal(receipt.drainScope, 'process-group');
  assert.match(readFileSync(row.manifest.log, 'utf8'), /late descendant output/);
});

test('cancellation escalates an ignoring command group without falsely certifying the original command result', async t => {
  const h = fixture(t), row = launchJob(h.board, h.config, { id: randomUUID(), command: "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", cwd: h.cwd });
  await eventually(() => existsSync(row.manifest.log) && readFileSync(row.manifest.log, 'utf8').includes('ready'));
  const receipt = await cancelJob(row);
  assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.code, null); assert.equal(receipt.signal, 'SIGKILL'); assert.equal(receipt.drained, true);
});

test('missing terminal receipt remains abnormal/uncertain, never credits success or automatically relaunches; duplicate observation is one event', async t => {
  const h = fixture(t), row = launchJob(h.board, h.config, { id: randomUUID(), command: 'sleep 20', cwd: h.cwd });
  await eventually(() => existsSync(join(row.manifest.dir, 'process.json')));
  const runner = JSON.parse(readFileSync(join(row.manifest.dir, 'runner.json'), 'utf8'));
  const processReceipt = JSON.parse(readFileSync(join(row.manifest.dir, 'process.json'), 'utf8'));
  process.kill(runner.pid, 'SIGKILL');
  // Only this fixture's recorded command group, not a cancellation inferred from worker lifetime.
  process.kill(-processReceipt.group, 'SIGKILL');
  const abnormal = await eventually(() => h.board.jobs.observe()[0].terminal);
  assert.equal(abnormal.state, 'abnormal'); assert.equal(abnormal.code, null); assert.equal(abnormal.drained, false);
  assert.equal(existsSync(row.manifest.receipt), false); assert.match(abnormal.error, /without a terminal receipt/);
  for (let i = 0; i < 3; i++) h.board.jobs.observe();
  assert.equal(h.floor.board.history({ limit: 100 }).posts.filter(p => p.text.startsWith(`Independent job ${row.id}:`)).length, 1);
  const retry = launchJob(h.board, h.config, { id: row.id, command: 'sleep 20', cwd: h.cwd });
  assert.equal(retry.terminal.state, 'abnormal'); assert.equal(h.board.jobs.list().length, 1);
  await assert.rejects(cancelJob(retry), /ENOENT|ECONNREFUSED/, 'absent live control cannot certify child drain');
});
