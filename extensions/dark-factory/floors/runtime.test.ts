import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createFloor, openFloor, listFloors, adoptFloor, selectOssFloor, ossStatus, claimOss, releaseOss, ROUTES } from './runtime.mjs';
import { tickFloor } from './supervisor.mjs';
import { openBoard, configuration } from '../../bf2-swarm/board.mjs';
import { installWorker } from '../../bf2-swarm/worker.mjs';

const node = '11111111-1111-4111-8111-111111111111';
const sol = id => ({ id, provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high', role: '', contextWarning: 80 });
const oss = id => ({ id, provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh', role: '', contextWarning: 90 });
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-floors-'))), root = join(dir, 'floors'), cwd = join(dir, 'repo'), agent = join(dir, 'agent');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(agent);
  writeFileSync(join(agent, 'settings.shared.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { name: 'Fixture floor', cwd, roots: [node], instructions: node, voteCondition: node, slots: [sol('a'), sol('b')],
    bootstrap: 'Offline fixture bootstrap', warningText: 'Fixture warning {percent}', wrapupText: 'Fixture drain {reason} {status}' };
  const create = (id, patch = {}) => {
    createFloor({ ...settings, ...patch }, { root, id });
    const floor = openFloor(id, { root }); t.after(() => floor.close());
    // Launcher infrastructure is not part of user editable floor settings.
    const db = new DatabaseSync(floor.database);
    const config = { ...floor.board.lifecycle.status().config, agentDir: agent };
    db.prepare('UPDATE swarm_run SET config=?').run(JSON.stringify(config)); db.close();
    floor.board.lifecycle.controllerSetup(() => `$${id === 'one' ? 0 : 100}`);
    return floor;
  };
  let next = 1;
  const panes = new Map(), tags = new Map(), calls = [];
  const execute = args => {
    calls.push(args); const target = args[args.indexOf('-t') + 1]; let stdout = '';
    if (args[0] === 'new-session') {
      const child = `$${next}`, pane = `%${next++}`; panes.set(pane, { child, live: true }); stdout = `${child} ${pane}`;
    }
    if (args[0] === 'display-message') { const p = panes.get(target); stdout = p ? `${p.live ? 0 : 1} ${p.child}` : ''; }
    if (args[0] === 'set-option') tags.set(`${target}:${args.at(-2)}`, args.at(-1));
    if (args[0] === 'show-options') stdout = args.at(-1) === '@bf2_swarm_run' ? (target === '$0' ? 'one' : 'two') : tags.get(`${target}:${args.at(-1)}`) ?? '';
    if (args[0] === 'list-sessions') stdout = ['$0','$100', ...[...panes.values()].map(p => p.child)].join('\n');
    if (args[0] === 'list-panes') stdout = [...panes].find(([, p]) => p.child === target)?.[0] ?? '';
    if (args[0] === 'kill-pane') panes.delete(target);
    return { status: 0, stdout, stderr: '' };
  };
  const peer = (floor, w) => { const b = openBoard({ ...floor.config, session: w.session, sender: w.sender }); t.after(() => b.close()); return b; };
  const boot = floor => { floor.command(`start-${next}`, 'start'); tickFloor(floor, execute); for (const w of floor.board.lifecycle.status().workers.filter(w => w.state === 'launching')) peer(floor, w).lifecycle.ready(); return floor.board.lifecycle.status().workers.filter(w => !w.cleaned); };
  return { dir, root, settings, create, execute, peer, boot, panes, calls };
}

test('two floors: isolated owner messages, peer identities, durable pending USER input, ballot and dynamic discovery', t => {
  const h = fixture(t), one = h.create('one'), two = h.create('two');
  assert.equal(one.snapshot().status, 'stopped');
  const pendingDir = join(h.root, 'initializing'); mkdirSync(pendingDir);
  const pending = openBoard({ database: join(pendingDir, 'floor.sqlite'), run: 'initializing', session: 'controller', sender: '00000000' });
  pending.lifecycle.initialize({}); pending.close();
  assert.deepEqual(listFloors({ root: h.root }).map(f => f.id), ['one','two'], 'simultaneous discovery ignores incomplete creation');
  const a = h.boot(one), b = h.boot(two), p = h.peer(one, a[0]), q = h.peer(two, b[0]);
  p.finishStartup(p.history().highwater); q.finishStartup(q.history().highwater);
  const command = one.command('owner', 'message', 'Fixture owner question');
  assert.deepEqual(one.command('owner', 'message', 'Fixture owner question'), command);
  assert.throws(() => one.command('owner', 'message', 'Other text'), /different/);
  assert.match(p.pending().text, /JACK \[FACTORY OWNER\].*Fixture owner question/);
  assert.equal(q.pending(), null);
  assert.throws(() => openBoard({ ...one.config, session: b[0].session, sender: b[0].sender }), /not registered/);
  assert.throws(() => openBoard({ ...one.config, floor: 'two' }), /another floor/);
  assert.throws(() => configuration({ FACTORY_FLOOR: 'one' }), /identity/);
  assert.throws(() => configuration({ FACTORY_FLOOR: 'one', FACTORY_DB: one.database, FACTORY_SESSION: a[0].session, FACTORY_SENDER: a[0].sender, BF2_BOARD_DB: two.database }), /conflicting/);
  const env = { FACTORY_FLOOR: 'one', FACTORY_DB: one.database, FACTORY_SESSION: a[0].session, FACTORY_SENDER: a[0].sender };
  assert.equal(configuration(env).database, one.database);
  assert.equal(one.snapshot().vote, undefined, 'readiness opens no ballot');
  const beforeReady = one.snapshot();
  p.lifecycle.ready(); q.lifecycle.ready();
  assert.deepEqual(one.snapshot(), beforeReady, 'repeated readiness is silent');
  assert.throws(() => p.lifecycle.pause('arbitrary', 'Peer-redefined question'), /only the owner/);
  const ballot = p.lifecycle.pause('first', one.settings().voteCondition);
  assert.equal(ballot.reason, h.settings.voteCondition); assert.equal(ballot.electorate.length, 2);
  assert.ok(ballot.electorate.every(v => v.answer === null), 'requesting a round is not a vote');
  const tally = p.lifecycle.vote(ballot.number, 'yes');
  assert.equal(tally.result, 'open'); assert.equal(tally.electorate.filter(v => v.answer === 'yes').length, 1);
  one.configure({ voteCondition: '22222222-2222-4222-8222-222222222222' });
  assert.equal(one.snapshot().vote, undefined, 'configuration cancels but opens no ballot');
  assert.throws(() => h.peer(one, a[1]).lifecycle.vote(ballot.number, 'yes'), /cancelled/);
  const fresh = p.lifecycle.pause('revised', one.settings().voteCondition); assert.notEqual(fresh.number, ballot.number);
  p.lifecycle.vote(fresh.number, 'yes');
  assert.equal(h.peer(one, a[1]).lifecycle.vote(fresh.number, 'yes').result, 'agreed');
  assert.equal(one.snapshot().status, 'waiting'); assert.equal(two.snapshot().status, 'running');
  const launches = h.calls.filter(c => c[0] === 'new-session'); tickFloor(one, h.execute);
  assert.equal(h.calls.filter(c => c[0] === 'new-session').length, launches.length);
  for (const [floor, workers] of [[one, a], [two, b]]) for (const w of workers) {
    const launch = h.calls.find(c => c[0] === 'new-session' && c.at(-1).includes(`BF2_BOARD_SESSION=${w.session}`)).at(-1);
    assert.ok(launch.includes(`FACTORY_FLOOR=${floor.id}`)); assert.ok(launch.includes(`FACTORY_DB=${floor.database}`));
    assert.equal(readFileSync(join(h.root, floor.id, `${w.session}.boot.txt`), 'utf8'), 'Offline fixture bootstrap');
  }
});

test('floor chat persists without starting, reversing Stop or changing an explicit queued Start', t => {
  const h = fixture(t), floor = h.create('one');
  const saved = floor.command('chat-stopped', 'message', 'Fixture chat before Start');
  assert.deepEqual(floor.command('chat-stopped', 'message', 'Fixture chat before Start'), saved);
  assert.equal(floor.board.lifecycle.status().reconvene, 0);
  tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().status, 'stopped');
  assert.equal(floor.snapshot().workers.length, 0);
  assert.ok(floor.snapshot().posts.some(p => p.number === saved.number && p.text === 'Fixture chat before Start'));

  const workers = h.boot(floor);
  floor.command('stop', 'stop');
  floor.command('chat-draining', 'message', 'Fixture chat during Stop');
  assert.equal(floor.snapshot().status, 'stopping');
  assert.equal(floor.board.lifecycle.status().reconvene, 0);
  for (const w of workers) h.panes.get(w.pane).live = false;
  tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().status, 'stopped');
  assert.equal(floor.snapshot().workers.length, workers.length, 'chat cannot schedule replacements');

  const next = h.boot(floor);
  floor.command('stop-next', 'stop');
  floor.command('explicit-start', 'start');
  floor.command('chat-queued', 'message', 'Fixture chat with explicit Start pending');
  assert.equal(floor.board.lifecycle.status().reconvene, 1, 'chat preserves an explicit queued Start');
  for (const w of next) h.panes.get(w.pane).live = false;
  tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().status, 'running');
});

test('2–10 next-occupant slots, invalid patches atomic, model/role edits do not mutate current workers; removal safely drains', t => {
  const h = fixture(t), floor = h.create('one'), workers = h.boot(floor);
  for (const slots of [[sol('a')], Array.from({ length: 11 }, (_, i) => sol(String(i))), [sol('a'), sol('a')], [sol('a'), { ...sol('b'), model: 'unapproved' }], [sol('a'), { ...sol('b'), thinking: 'low' }]]) assert.throws(() => floor.configure({ slots }));
  for (const patch of [null, [], { roots: [[node]] }, { instructions: [node] }, ...['', 'Fixture condition', [node], 1, {}].map(voteCondition => ({ voteCondition })), { bootstrap: ' ' }, { warningText: '' }, { slots: [sol('a'), { ...sol('b'), provider: ['openai-codex-fixture'] }] }]) assert.throws(() => floor.configure(patch));
  assert.equal(floor.settings().slots.length, 2);
  const slots = Array.from({ length: 10 }, (_, i) => sol(i === 0 ? 'a' : i === 1 ? 'b' : `s${i}`));
  slots[0] = { ...slots[0], model: 'gpt-6-luna', role: 'Fixture specialization', contextWarning: 60 };
  floor.configure({ slots }); tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().workers.filter(w => !w.cleaned).length, 10);
  assert.equal(floor.snapshot().workers[0].launch_config.model, 'gpt-6.1-sol');
  assert.equal(floor.snapshot().slots[0].model, 'gpt-6-luna');
  const p = h.peer(floor, workers[0]); p.lifecycle.done('Fixture final message'); p.lifecycle.settled(); tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().workers.length, 10, 'settlement cannot release a still-live child');
  h.panes.get(workers[0].pane).live = false; tickFloor(floor, h.execute);
  const replacement = floor.snapshot().workers.at(-1);
  assert.equal(replacement.launch_config.model, 'gpt-6-luna'); assert.equal(replacement.launch_config.contextWarning, 60);
  assert.match(readFileSync(join(h.root, floor.id, `${replacement.session}.boot.txt`), 'utf8'), /Fixture specialization/);
  floor.configure({ slots: slots.slice(0, 2) });
  const removed = floor.snapshot().workers.filter(w => !w.cleaned && w.slot !== 'a' && w.slot !== 'b');
  assert.ok(removed.every(w => w.retire_requested === 'slot removed'));
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.filter(w => !w.cleaned).length, 10);
  for (const w of removed) h.panes.get(w.pane).live = false;
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.filter(w => !w.cleaned).length, 2);
  floor.command('stop', 'stop'); tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().status, 'stopping');
  for (const w of floor.snapshot().workers.filter(w => !w.cleaned)) h.panes.get(w.pane).live = false;
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().status, 'stopped');
});

test('unavailable independent-job evidence cannot block real worker cleanup or imply job cancellation', t => {
  const h = fixture(t), floor = h.create('one'), workers = h.boot(floor), p = h.peer(floor, workers[0]), errors = [];
  p.lifecycle.done('Fixture continuing job locators'); p.lifecycle.settled();
  floor.board.jobs.observe = () => { throw new Error('Fixture process evidence unavailable'); };
  t.mock.method(console, 'error', text => errors.push(text));
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.length, 2, 'safe but live worker still owns its slot');
  h.panes.get(workers[0].pane).live = false; tickFloor(floor, h.execute);
  assert.equal(floor.snapshot().workers[0].cleaned, 1); assert.equal(floor.snapshot().workers.length, 3);
  assert.ok(errors.every(text => text.includes('remain uncertain')));
  assert.ok(h.calls.filter(c => c[0] === 'kill-pane').every(c => c.at(-1) === workers[0].pane));
});

test('unfinished ballots invalidate on slot and actual membership change; no is not controller judgment', t => {
  const h = fixture(t), floor = h.create('one'), workers = h.boot(floor), p = h.peer(floor, workers[0]);
  assert.equal(floor.snapshot().vote, undefined);
  const first = p.lifecycle.pause('first', floor.settings().voteCondition);
  p.lifecycle.vote(first.number, 'yes');
  floor.configure({ slots: [...floor.settings().slots, sol('c')] });
  assert.equal(floor.snapshot().vote, undefined);
  tickFloor(floor, h.execute); const third = floor.snapshot().workers.at(-1); h.peer(floor, third).lifecycle.ready();
  assert.equal(floor.snapshot().vote, undefined, 'new slot readiness opens no ballot');
  assert.throws(() => h.peer(floor, third).lifecycle.vote(first.number, 'yes'), /fixed electorate/);
  assert.throws(() => h.peer(floor, workers[1]).lifecycle.vote(first.number, 'yes'), /cancelled/);
  const round = p.lifecycle.pause('expanded', floor.settings().voteCondition);
  assert.equal(round.electorate.length, 3); assert.ok(round.electorate.every(v => v.answer === null));
  h.peer(floor, workers[0]).lifecycle.vote(round.number, 'yes');
  h.panes.get(third.pane).live = false; tickFloor(floor, h.execute); assert.equal(floor.snapshot().vote, undefined);
  const next = floor.snapshot().workers.at(-1); h.peer(floor, next).lifecycle.ready();
  assert.equal(floor.snapshot().vote, undefined, 'replacement readiness opens no ballot');
  h.peer(floor, next).lifecycle.ready();
  assert.equal(floor.snapshot().vote, undefined, 'repeated replacement readiness opens no ballot');
  assert.throws(() => h.peer(floor, workers[1]).lifecycle.vote(round.number, 'yes'), /cancelled/);
  const current = p.lifecycle.pause('replacement', floor.settings().voteCondition); assert.notEqual(current.number, round.number);
  assert.ok(current.electorate.every(v => v.answer === null)); assert.ok(!current.electorate.some(v => v.session === third.session));
  assert.equal(p.lifecycle.vote(current.number, 'no').result, 'rejected');
  assert.equal(floor.snapshot().status, 'running'); assert.equal(floor.snapshot().vote, undefined);
  assert.throws(() => h.peer(floor, workers[1]).lifecycle.vote(current.number, 'yes'), /rejected/);
  floor.configure({ name: 'Renamed fixture' });
  assert.equal(floor.snapshot().vote, undefined, 'configuration after rejection opens no ballot');
  const again = h.peer(floor, workers[0]).lifecycle.pause('retry', floor.settings().voteCondition);
  assert.equal(again.reason, h.settings.voteCondition); assert.ok(again.electorate.every(v => v.answer === null));
});

test('single global OSS lease: move waits for real exit and cleanup across floors, no overlap', t => {
  const h = fixture(t), one = h.create('one', { slots: [sol('a'), oss('q')] }), two = h.create('two', { slots: [sol('a'), oss('q')] });
  selectOssFloor('one', { root: h.root }); const a = h.boot(one); h.boot(two);
  assert.equal(one.snapshot().workers.filter(w => !w.cleaned).length, 2); assert.equal(two.snapshot().workers.filter(w => !w.cleaned).length, 1);
  const old = a.find(w => w.slot === 'q'); selectOssFloor('two', { root: h.root });
  assert.equal(one.snapshot().workers.find(w => w.session === old.session).retire_requested, 'OSS floor selection changed');
  const p = h.peer(one, old); p.lifecycle.done('Fixture OSS transfer'); p.lifecycle.settled();
  tickFloor(one, h.execute); tickFloor(two, h.execute);
  assert.equal(ossStatus({ root: h.root }).session, old.session); assert.equal(two.snapshot().workers.length, 1);
  h.panes.get(old.pane).live = false; tickFloor(one, h.execute); tickFloor(two, h.execute);
  const lease = ossStatus({ root: h.root }); assert.equal(lease.floor, 'two'); assert.notEqual(lease.session, old.session);
  assert.equal(one.snapshot().workers.filter(w => !w.cleaned).length, 1); assert.equal(two.snapshot().workers.filter(w => !w.cleaned).length, 2);
  selectOssFloor(null, { root: h.root }); assert.ok(two.snapshot().workers.find(w => w.session === lease.session).retire_requested);
});

test('required launch-text gate, per-occupant context-stop threshold and known JSONL failure locators', async t => {
  const h = fixture(t), unapproved = h.create('two', { bootstrap: null });
  assert.throws(() => unapproved.command('start', 'start'), /launch settings: bootstrap/); assert.equal(unapproved.snapshot().status, 'stopped');
  unapproved.command('preapproval-message', 'message', 'Fixture owner input before approval');
  assert.equal(unapproved.snapshot().status, 'stopped');
  assert.ok(unapproved.snapshot().posts.some(p => p.role === 'owner' && p.text === 'Fixture owner input before approval'));
  const floor = h.create('one', { slots: [{ ...sol('a'), contextWarning: 60 }, sol('b')] });
  floor.command('start', 'start'); tickFloor(floor, h.execute);
  const w = floor.snapshot().workers[0], path = join(h.root, floor.id, 'sessions', `${w.session}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'session', id: w.session }) + '\n');
  const handlers = new Map(), sent = [], entries = []; let percent, shutdown = 0;
  const pi = { on: (name, fn) => handlers.set(name, fn), getSettings: () => ({ steeringMode: 'all', followUpMode: 'all' }),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    async sendUserMessage(text, options) { assert.ok(options.admissionGuard()); sent.push(text); return { status: 'admitted', delivery: 'steer' }; } };
  const ctx = { sessionManager: { getSessionId: () => w.session, getSessionFile: () => path, getEntries: () => entries, getBranch: () => entries }, getContextUsage: () => ({ percent }), shutdown: () => shutdown++ };
  const env = { FACTORY_FLOOR: floor.id, FACTORY_DB: floor.database, FACTORY_SESSION: w.session, FACTORY_SENDER: w.sender };
  installWorker(pi, env); t.after(() => handlers.get('session_shutdown')({}, ctx));
  await handlers.get('session_start')({}, ctx);
  for (const value of [undefined, NaN, 59]) { percent = value; await handlers.get('turn_end')({}, ctx); }
  percent = 60; await handlers.get('turn_end')({}, ctx); await handlers.get('turn_end')({}, ctx);
  assert.match(sent[0], /^Context budget: 50% used\./);
  assert.deepEqual(sent.slice(1), ['Fixture warning 60']); assert.equal(shutdown, 0);
  assert.equal(floor.snapshot().workers[0].retire_requested, 'context threshold');
  assert.equal(floor.snapshot().workers[0].session_file, path); assert.equal(floor.snapshot().workers[0].context_percent, 60);
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'Fixture retryable error' } }, ctx);
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop' } }, ctx);
  handlers.get('agent_settled')({ interruption: undefined }, ctx); assert.equal(shutdown, 0);
  assert.ok(floor.snapshot().posts.some(p => p.text.includes('Fixture retryable error') && p.text.includes(path)));
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'Fixture provider error' } }, ctx);
  handlers.get('agent_settled')({ interruption: undefined }, ctx);
  assert.equal(shutdown, 1); assert.ok(floor.snapshot().posts.some(p => p.role === 'system' && p.text.includes(path) && p.text.includes('Fixture provider error')));
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.length, 2);
  h.panes.get(w.pane).live = false; tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.length, 3);
});

test('staged floors refuse Start without side effects, retain chat without launching, then configured Start works', t => {
  for (const key of ['instructions','voteCondition','bootstrap','warningText','wrapupText']) {
    const h = fixture(t), floor = h.create('one', { [key]: null });
    const before = floor.snapshot();
    assert.throws(() => floor.command('start', 'start'), new RegExp(`launch settings: ${key}`));
    assert.deepEqual(floor.snapshot(), before, 'no posts, running state or queue persisted');
    const db = new DatabaseSync(floor.database);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM swarm_commands').get().n, 0); db.close();
    floor.command('chat', 'message', 'Fixture pending input');
    assert.equal(floor.snapshot().status, 'stopped'); assert.equal(floor.snapshot().pending, false);
    tickFloor(floor, h.execute); assert.equal(floor.snapshot().workers.length, 0);
    floor.configure({ [key]: h.settings[key] });
    assert.equal(h.boot(floor).length, 2);
  }
});

test('live, queued and draining floors cannot erase required launch inputs; stopped floor can', t => {
  const h = fixture(t), floor = h.create('one'), workers = h.boot(floor);
  for (const phase of ['running', 'stopping', 'queued']) {
    if (phase === 'stopping') floor.command('stop', 'stop');
    if (phase === 'queued') floor.command('restart', 'start');
    for (const key of ['instructions','voteCondition','bootstrap','warningText','wrapupText']) {
      const before = floor.snapshot();
      assert.throws(() => floor.configure({ [key]: null }), /launch settings/);
      assert.deepEqual(floor.snapshot(), before, 'refusal preserves config, ballots, posts and graceful stop');
    }
  }
  floor.command('cancel-restart', 'stop');
  for (const w of workers) h.panes.get(w.pane).live = false;
  tickFloor(floor, h.execute); assert.equal(floor.snapshot().status, 'stopped');
  assert.equal(floor.configure({ voteCondition: null }).voteCondition, null);
});

test('ordinary additive BF2 adoption preserves original history, IDs and actual session paths', t => {
  const h = fixture(t), runDir = join(h.dir, 'legacy'); mkdirSync(runDir); mkdirSync(join(runDir, 'sessions'));
  const config = { database: join(runDir, 'board.sqlite'), run: 'legacy-run', session: 'controller', sender: '00000000' };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: config.run }));
  const b = openBoard(config); b.lifecycle.initialize({ agentDir: join(h.dir, 'agent') }); b.lifecycle.ownerCommand('history', 'message', 'Legacy owner history'); b.lifecycle.stop(); b.close();
  adoptFloor(runDir, h.settings, { root: h.root, id: 'one' });
  const floor = openFloor('one', { root: h.root }); t.after(() => floor.close());
  assert.equal(floor.config.run, 'legacy-run'); assert.equal(floor.snapshot().posts[0].text, 'Legacy owner history');
  assert.equal(floor.board.lifecycle.status().config.sessionDir, join(runDir, 'sessions'));
  floor.command('new', 'message', 'New owner history');
  const old = openBoard(config); try { assert.ok(old.history({ limit: 100 }).posts.some(p => p.text === 'New owner history')); } finally { old.close(); }
  assert.equal(floor.snapshot().status, 'stopped', 'adopted floor chat does not reconvene');
  floor.command('explicit-restart', 'start');
  assert.throws(() => adoptFloor(runDir, h.settings, { root: h.root, id: 'again' }), /stopped/);
});

test('concurrent OSS claims serialize; ambiguous launch exceptions hold capacity until proven cleanup', async t => {
  const h = fixture(t); h.create('one', { slots: [sol('a'), oss('q')] }); selectOssFloor('one', { root: h.root });
  const module = new URL('./runtime.mjs', import.meta.url).href;
  const results = await Promise.all(['first','second'].map(session => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module','-e', `import {claimOss} from ${JSON.stringify(module)}; console.log(claimOss(${JSON.stringify(h.root)},'one',${JSON.stringify(session)},()=>true));`]);
    let out = '', error = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(error)));
  })));
  assert.deepEqual(results.sort(), ['false','true']);
  const lease = ossStatus({ root: h.root }); releaseOss(h.root, 'one', lease.session);
  assert.throws(() => claimOss(h.root, 'one', 'ambiguous', () => { throw new Error('Fixture receipt lost'); }), /receipt lost/);
  assert.equal(ossStatus({ root: h.root }).session, 'ambiguous');
  assert.equal(claimOss(h.root, 'one', 'replacement', () => assert.fail('must not launch')), false);
});

test('advertised routes use the approved selectors while explicit account routes remain compatible', t => {
  assert.deepEqual(ROUTES.map(({ provider, model, thinking }) => [provider, model, thinking]), [
    ['openrouter', 'xiaomi/mimo-v2.6-pro', 'high'],
    ['openai-codex-personal', 'gpt-6.1-sol', 'high'],
    ['local', 'qwen3.8-flash-next', 'xhigh'],
    ['openai-codex-personal', 'gpt-6-luna', 'high'],
  ]);
  const h = fixture(t);
  for (const [i, r] of ROUTES.entries()) {
    const floor = h.create(`route${i}`, { slots: [sol('a'), { provider: r.providerPattern ? 'openai-codex-fixture' : r.provider, model: r.model, thinking: r.thinking, id: 'b', role: '', contextWarning: 80 }] });
    assert.equal(floor.settings().slots[1].model, r.model);
  }
});
