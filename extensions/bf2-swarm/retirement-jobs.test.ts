import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createFloor, openFloor } from '../dark-factory/floors/runtime.mjs';
import { openBoard } from './board.mjs';
import { installWorker } from './worker.mjs';
import { receiver } from './receiver.mjs';
import { launchJob, cancelJob } from './jobs.mjs';

const node = '11111111-1111-4111-8111-111111111111';
const eventually = async check => {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('isolated job did not produce expected evidence');
};
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-retirement-'))), cwd = join(dir, 'repo'), root = join(dir, 'floors');
  mkdirSync(cwd);
  for (const args of [['init'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Fixture']]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(cwd, 'draft.txt'), 'unfinished draft\n');
  const slots = ['a','b'].map(id => ({ id, provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 70 }));
  createFloor({ name: 'Fixture', cwd, roots: [node], instructions: node, voteCondition: node, slots,
    bootstrap: 'Fixture bootstrap', warningText: `Context stop: {percent}% on floor {floor}. Read node ${node} now.`, wrapupText: `Retirement requested: {reason}; {status}; {floor}. Read node ${node} now.` }, { id: 'fixture', root });
  const floor = openFloor('fixture', { root }); floor.command('start', 'start');
  const session = randomUUID(), sender = 'aaaaaaaa';
  floor.board.lifecycle.addWorker(session, sender, '%1', undefined, { slot: 'a', launchConfig: { ...floor.board.lifecycle.status().config, ...floor.settings().slots[0] } });
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
  const handlers = new Map(), entries = [], sent = []; let percent = 0, shuts = 0;
  const file = join(h.dir, 'session.jsonl'); writeFileSync(file, '{}\n');
  const ctx = { sessionManager: { getSessionId: () => h.session, getSessionFile: () => file, getEntries: () => entries, getBranch: () => entries }, getContextUsage: () => ({ percent }), shutdown: () => shuts++ };
  const pi = { on: (event, fn) => handlers.set(event, fn), getSettings: () => ({ steeringMode: 'all', followUpMode: 'all' }), appendEntry: (type, data) => entries.push({ type: 'custom', customType: type, data }),
    async sendUserMessage(text, options) {
      if (!options.admissionGuard()) return { status: 'rejected' };
      const handled = handlers.get('input')({ source: 'extension', text }, ctx);
      sent.push(text); return { status: 'admitted', delivery: handled ? 'custom' : 'steer' };
    } };
  const api = installWorker(pi, h.env, drained);
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  return { handlers, ctx, pi, sent, api, usage: n => percent = n, shuts: () => shuts };
}

test('threshold transitions durably before next tool; locator expands; native capture/drain/final tools survive', async t => {
  const h = fixture(t); let drained = false; const f = fake(t, h, () => drained);
  await f.handlers.get('session_start')({}, f.ctx);
  for (const n of [NaN, undefined, 69.9]) { f.usage(n); await f.handlers.get('turn_end')({}, f.ctx); }
  assert.equal(f.sent.length, 0);
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
  await f.handlers.get('turn_end')({}, f.ctx); assert.equal(f.sent.length, 1);
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
