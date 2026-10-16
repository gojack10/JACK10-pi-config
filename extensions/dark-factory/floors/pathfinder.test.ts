import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFloor, openFloor, selectOssFloor, ossStatus, validateSettings } from './runtime.mjs';
import { tickFloor } from './supervisor.mjs';
import { openBoard, configuration } from '../../bf2-swarm/board.mjs';
import { installWorker } from '../../bf2-swarm/worker.mjs';
import { ABSENCE_MS, PATHFINDER_SLOT, PATHFINDER_ENTRY, PATHFINDER_AGENT, pathfinderMission } from '../../bf2-swarm/pathfinder.mjs';
import { publicSnapshot, serveFloors } from './room.mjs';
import { textMarkup } from '../room/markup.mjs';

const node = '11111111-1111-4111-8111-111111111111';
const route = { provider: 'openai-codex-fixture', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80 };
function fixture(t, pathfinderRoute = route) {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-pathfinder-'))), root = join(dir, 'floors'), cwd = join(dir, 'repo'), agent = join(dir, 'agent');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(agent);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pathfinder = { ...pathfinderRoute, continuation: node };
  createFloor({ name: 'Fixture floor', cwd, roots: [node], instructions: node, voteCondition: node,
    slots: ['a','b'].map(id => ({ ...route, id })), pathfinder,
    bootstrap: 'Fixture peer entry', warningText: 'Fixture threshold {percent}', wrapupText: 'Fixture retirement {reason}' }, { id: 'one', root });
  const floor = openFloor('one', { root }); t.after(() => floor.close());
  const db = new DatabaseSync(floor.database);
  db.prepare('UPDATE swarm_run SET config=?').run(JSON.stringify({ ...floor.board.lifecycle.status().config, agentDir: agent })); db.close();
  floor.board.lifecycle.controllerSetup(() => '$0');
  let next = 1, fault;
  const panes = new Map(), tags = new Map(), calls = [];
  const execute = args => {
    calls.push(args); const target = args[args.indexOf('-t') + 1]; let stdout = '';
    if (args[0] === 'new-session') {
      if (fault) { const error = fault; fault = null; throw error; }
      const child = `$${next}`, pane = `%${next++}`; panes.set(pane, { child, live: true }); stdout = `${child} ${pane}`;
    }
    if (args[0] === 'display-message') { const p = panes.get(target); stdout = p ? `${p.live ? 0 : 1} ${p.child}` : ''; }
    if (args[0] === 'set-option') tags.set(`${target}:${args.at(-2)}`, args.at(-1));
    if (args[0] === 'show-options') stdout = args.at(-1) === '@bf2_swarm_run' ? 'one' : tags.get(`${target}:${args.at(-1)}`) ?? '';
    if (args[0] === 'list-sessions') stdout = ['$0', ...[...panes.values()].map(p => p.child)].join('\n');
    if (args[0] === 'list-panes') stdout = [...panes].find(([, p]) => p.child === target)?.[0] ?? '';
    if (args[0] === 'kill-pane') panes.delete(target);
    return { status: 0, stdout, stderr: '' };
  };
  const state = () => floor.board.lifecycle.status();
  const peers = () => state().workers.filter(w => !w.cleaned && w.slot !== PATHFINDER_SLOT);
  const current = () => state().workers.find(w => !w.cleaned && w.slot === PATHFINDER_SLOT);
  const board = w => { const b = openBoard({ ...floor.config, session: w.session, sender: w.sender }); t.after(() => b.close()); return b; };
  const tick = () => tickFloor(floor, execute);
  const ready = w => { const b = board(w); b.lifecycle.ready(); return b; };
  const startup = b => { const history = b.history(); b.finishStartup(history.highwater); return history; };
  const start = () => { floor.command(`start-${now}`, 'start'); tick(); peers().filter(w => w.state === 'launching').forEach(ready); };
  const retire = (w, b = board(w)) => { b.lifecycle.done('Fixture pass complete; continuation retained at owner'); b.lifecycle.settled(); };
  return { root, floor, pathfinder, state, peers, current, board, ready, startup, start, tick, retire, panes, calls,
    advance: ms => { now += ms; }, now: () => now, fail: error => { fault = error; } };
}

test('optional Pathfinder defaults persist in SQLite and launch on personal Sol high, with route overrides preserved', t => {
  const h = fixture(t, {}), settings = h.floor.settings();
  const expected = { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80 };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(settings.pathfinder[key], value); assert.equal(h.state().config.pathfinder[key], value);
  }
  const reopened = openFloor('one', { root: h.root });
  assert.deepEqual(reopened.settings().pathfinder, settings.pathfinder); reopened.close();
  const { pathfinder, ...disabled } = settings;
  assert.equal(validateSettings(disabled).pathfinder, null);
  assert.equal(validateSettings({ ...disabled, pathfinder: null }).pathfinder, null);
  for (const patch of [{ provider: 'openai-codex-fixture' }, { model: 'gpt-6-luna' }]) {
    const configured = validateSettings({ ...settings, pathfinder: { ...h.pathfinder, ...patch } }).pathfinder;
    for (const [key, value] of Object.entries({ ...expected, ...patch })) assert.equal(configured[key], value);
  }
  h.start(); floorMessage(h, 'defaults', '@PATHFINDER fixture review'); h.tick();
  for (const [key, value] of Object.entries(expected)) assert.equal(h.current().launch_config[key], value);
  const launch = h.calls.find(args => args[0] === 'new-session' && args.includes(`bf2-one-${h.current().sender}`));
  assert.ok(launch.at(-1).includes("'--provider' 'openai-codex-personal' '--model' 'gpt-6.1-sol' '--thinking' 'high'"));
});

test('30-minute absence, one non-worker session, inspectable assignment, settlement and real cleanup reset', t => {
  const h = fixture(t); h.start(); assert.equal(h.current(), undefined);
  h.advance(ABSENCE_MS - 1); h.tick(); assert.equal(h.current(), undefined);
  const reopened = openFloor('one', { root: h.root });
  assert.equal(reopened.board.lifecycle.status().pathfinder.absent_since, h.state().pathfinder.absent_since); reopened.close();
  h.advance(1); h.tick(); const w = h.current(), b = h.ready(w);
  assert.ok(w); assert.equal(h.peers().length, 2); assert.equal(h.state().pathfinder.absent_since, null);
  const mission = readFileSync(join(h.root, 'one', `${w.session}.boot.txt`), 'utf8');
  assert.equal(mission, pathfinderMission(h.state().config));
  assert.ok(mission.includes('Common floor launch instructions:\nFixture peer entry\n'));
  assert.match(mission, /current goal resolved through that same project entry/);
  assert.match(mission, /discovering another path grants no write authority/);
  const assignment = JSON.parse(mission.split('Factory Pathfinder assignment:\n')[1]);
  assert.deepEqual(assignment, { identity: '@PATHFINDER', floor: 'one', cwd: h.floor.settings().cwd, roots: [node],
    instructions: node, entry: PATHFINDER_ENTRY, agent: PATHFINDER_AGENT, continuation: node });
  h.startup(b); b.post('@PATHFINDER fixture self-reference');
  h.advance(5 * ABSENCE_MS); h.tick(); assert.equal(h.current().session, w.session);
  h.retire(w, b); h.tick(); assert.equal(h.state().pathfinder.absent_since, null, 'settlement leaves a live pane occupied');
  h.panes.get(w.pane).live = false; h.tick(); assert.equal(h.current(), undefined);
  assert.equal(h.state().pathfinder.absent_since, h.now());
  h.advance(ABSENCE_MS - 1); h.tick(); assert.equal(h.current(), undefined);
  h.advance(1); h.tick(); assert.notEqual(h.current().session, w.session);
});

test('authenticated directed requests wake early; retained startup, active delivery and successor preserve requests', t => {
  const h = fixture(t); h.start(); const peer = h.board(h.peers()[0]);
  peer.post('`@PATHFINDER` example and @PATHFINDER-extra are literals'); h.tick(); assert.equal(h.current(), undefined);
  const request = peer.post('@PATHFINDER inspect the fixture bottleneck');
  for (let i = 0; i < 40; i++) peer.post(`Fixture ordinary post ${i}`);
  h.tick(); const w = h.current(), b = h.ready(w);
  const history = h.startup(b); assert.ok(history.wake.some(p => p.number === request));
  assert.equal(h.state().pathfinder.delivered, history.highwater);
  floorMessage(h, 'active', '@PATHFINDER apply this fixture priority');
  h.tick(); assert.equal(h.current().session, w.session);
  const batch = b.pending(); assert.match(batch.text, /apply this fixture priority/);
  b.confirmPersisted(batch.key);
  const alias = b.post('Fixture Pathfinder result');
  assert.equal(h.floor.snapshot().posts.find(p => p.number === alias).sender, 'PATHFINDER');
  assert.ok(h.floor.snapshot().members.includes('PATHFINDER'));
  assert.equal(publicSnapshot(h.floor.snapshot()).workers.find(p => p.slotId === PATHFINDER_SLOT).sender, 'PATHFINDER');
  assert.match(textMarkup('@PATHFINDER', new Set(h.floor.snapshot().known)), /data-mention="PATHFINDER"/);
  assert.throws(() => openBoard({ ...h.floor.config, session: w.session, sender: 'PATHFINDER' }), /another sender/);
  assert.throws(() => configuration({ FACTORY_FLOOR: 'one', FACTORY_DB: h.floor.database, FACTORY_SESSION: w.session, FACTORY_SENDER: 'PATHFINDER' }), /8-character/);
  // A request that never entered the retiring session remains recoverable.
  floorMessage(h, 'late', '@PATHFINDER continue the unfinished fixture review');
  h.retire(w, b); h.tick(); assert.equal(h.current().session, w.session);
  h.panes.get(w.pane).live = false; h.tick(); const successor = h.current(); assert.notEqual(successor.session, w.session);
  assert.ok(h.startup(h.ready(successor)).wake.some(p => p.text.includes('unfinished fixture review')));
});
function floorMessage(h, key, text) { return h.floor.command(key, 'message', text); }

test('Pathfinder cannot gate peers; ballot membership is unchanged across its launch and retirement', t => {
  const h = fixture(t); h.start(); const p = h.board(h.peers()[0]), q = h.board(h.peers()[1]);
  const vote = p.lifecycle.pause('fixture', node);
  floorMessage(h, 'request', '@PATHFINDER fixture review'); h.tick(); const w = h.current(), b = h.ready(w); h.startup(b);
  assert.equal(h.state().vote.number, vote.number); assert.equal(h.state().vote.electorate.length, 2);
  assert.throws(() => b.lifecycle.pause('specialist', node), /outside peer ballot/);
  assert.throws(() => b.lifecycle.vote(vote.number, 'yes'), /fixed electorate/);
  h.retire(w, b); assert.equal(h.state().vote.number, vote.number);
  p.lifecycle.vote(vote.number, 'yes'); q.lifecycle.vote(vote.number, 'yes'); assert.equal(h.state().status, 'waiting');
  h.advance(ABSENCE_MS); h.tick(); assert.equal(h.current().session, w.session, 'waiting does not replace the retiring occupant');
});

test('stopped requests stay chat; explicit Start, context retirement, error and settings removal use existing lifecycle', async t => {
  const h = fixture(t);
  floorMessage(h, 'stopped', '@PATHFINDER inspect after explicit Start'); h.advance(ABSENCE_MS); h.tick();
  assert.equal(h.state().status, 'stopped'); assert.equal(h.state().workers.length, 0);
  h.start(); const w = h.current(), path = join(h.root, 'one', 'sessions', `${w.session}.jsonl`);
  writeFileSync(path, '{}\n');
  const handlers = new Map(), sent = [];
  const pi = { on: (name, fn) => handlers.set(name, fn), getSettings: () => ({ steeringMode: 'all', followUpMode: 'all' }),
    async sendUserMessage(text, options) { assert.ok(options.admissionGuard()); sent.push(text); return { status: 'admitted', delivery: 'steer' }; }, appendEntry() {} };
  let shutdown = 0;
  const ctx = { sessionManager: { getSessionId: () => w.session, getSessionFile: () => path, getEntries: () => [], getBranch: () => [] },
    getContextUsage: () => ({ percent: 80 }), shutdown: () => shutdown++ };
  let drained = false;
  const worker = installWorker(pi, { FACTORY_FLOOR: 'one', FACTORY_DB: h.floor.database, FACTORY_SESSION: w.session, FACTORY_SENDER: w.sender }, () => drained);
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  await handlers.get('session_start')({}, ctx); h.startup(h.board(w));
  await handlers.get('tool_call')({ toolName: 'read' }, ctx);
  assert.equal(h.current().retire_requested, 'context threshold'); assert.deepEqual(sent, ['Fixture threshold 80']);
  assert.ok(await handlers.get('tool_call')({ toolName: 'subagent_launch' }, ctx));
  assert.equal(await handlers.get('tool_call')({ toolName: 'write' }, ctx), undefined);
  worker.done('Fixture unfinished review owner retained', ctx);
  handlers.get('agent_settled')({ interruption: { kind: 'human' } }, ctx); assert.equal(shutdown, 0);
  handlers.get('agent_settled')({}, ctx); assert.equal(shutdown, 0, 'session-bound tools must settle');
  drained = true; handlers.get('agent_settled')({}, ctx); assert.equal(shutdown, 1);
  h.tick(); assert.equal(h.current().session, w.session);
  h.panes.get(w.pane).live = false; h.tick(); assert.equal(h.current(), undefined);
  h.advance(ABSENCE_MS); h.tick(); const replacement = h.current(), b = h.ready(replacement); h.startup(b);
  b.lifecycle.registerSessionFile('/fixture/pathfinder.jsonl'); b.lifecycle.recordError('Fixture provider failure'); b.lifecycle.lost(replacement.session, 'Fixture provider failure');
  h.tick(); assert.equal(h.current().session, replacement.session, 'error notice is not cleanup');
  h.panes.get(replacement.pane).live = false; h.tick(); assert.equal(h.current(), undefined);
  assert.ok(h.floor.snapshot().posts.some(p => p.text.includes('/fixture/pathfinder.jsonl')));
  floorMessage(h, 'again', '@PATHFINDER fixture recover'); h.tick(); const last = h.current(); h.ready(last);
  h.floor.configure({ pathfinder: null }); assert.equal(h.current().retire_requested, 'slot removed');
  h.floor.command('stop', 'stop'); floorMessage(h, 'draining', '@PATHFINDER fixture chat during Stop');
  h.advance(ABSENCE_MS); h.tick(); assert.equal(h.current().session, last.session); assert.equal(h.state().reconvene, 0);
  for (const p of h.state().workers.filter(p => !p.cleaned)) h.panes.get(p.pane).live = false;
  h.tick(); assert.equal(h.state().status, 'stopped'); assert.equal(h.current(), undefined);
});

test('Pathfinder configuration is reduced and atomic, changed route/continuation applies to next occupant', t => {
  const h = fixture(t);
  for (const patch of [{ continuation: [node] }, { continuation: '' }, { provider: '' }, { provider: null }, { model: 'unapproved' }, { model: null }, { thinking: 'low' }, { thinking: null }, { extra: true }]) {
    const before = h.floor.settings(); assert.throws(() => h.floor.configure({ pathfinder: { ...h.pathfinder, ...patch } })); assert.deepEqual(h.floor.settings(), before);
  }
  h.start(); floorMessage(h, 'wake', '@PATHFINDER fixture review'); h.tick(); const w = h.current(), b = h.ready(w); h.startup(b);
  h.floor.configure({ pathfinder: { ...h.pathfinder, model: 'gpt-6-luna', continuation: null } });
  assert.equal(h.current().launch_config.model, 'gpt-6.1-sol');
  h.retire(w, b); h.panes.get(w.pane).live = false; h.tick(); h.advance(ABSENCE_MS); h.tick();
  assert.equal(h.current().launch_config.model, 'gpt-6-luna'); assert.equal(h.current().launch_config.continuation, null);
});

test('empty Pathfinder setup enables defaults; legacy stored setup cannot override common project context', t => {
  const h = fixture(t);
  h.floor.configure({ pathfinder: {} });
  assert.deepEqual(h.floor.settings().pathfinder, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80, continuation: null });
  const legacy = { ...h.pathfinder, bootstrap: 'Obsolete specialist bootstrap', entry: node, agent: node,
    goal: '22222222-2222-4222-8222-222222222222', question: 'Obsolete specialist question', codeRoots: ['/no-longer-present'],
    grant: { tree: 'read-write', board: 'read-write', code: 'read-write' }, resources: 'Obsolete resources', resultDestination: 'Obsolete destination' };
  const db = new DatabaseSync(h.floor.database), settings = { ...h.floor.settings(), pathfinder: legacy };
  db.prepare('UPDATE floor_settings SET settings=?').run(JSON.stringify(settings));
  db.prepare('UPDATE swarm_run SET config=?').run(JSON.stringify({ ...h.state().config, pathfinder: legacy })); db.close();
  const reopened = openFloor('one', { root: h.root }); reopened.close();
  h.start(); floorMessage(h, 'legacy', '@PATHFINDER use the current project goal'); h.tick();
  const w = h.current(), mission = readFileSync(join(h.root, 'one', `${w.session}.boot.txt`), 'utf8');
  assert.ok(mission.includes('Common floor launch instructions:\nFixture peer entry\n'));
  assert.doesNotMatch(mission, /Obsolete|22222222-2222-4222-8222-222222222222|no-longer-present|"goal"|"grant"|"codeRoots"/);
  assert.equal(JSON.parse(mission.split('Factory Pathfinder assignment:\n')[1]).continuation, node);
  h.floor.configure({ slots: h.floor.settings().slots });
  assert.deepEqual(h.floor.settings().pathfinder, { ...route, continuation: node });
  assert.equal(h.current().session, w.session);
});

test('pre-release launch failures retain requests and ownership-ambiguous launch never duplicates', t => {
  const h = fixture(t); h.start(); floorMessage(h, 'request', '@PATHFINDER fixture review');
  h.fail(new Error('Fixture launch refused')); h.tick(); assert.equal(h.current(), undefined);
  assert.equal(h.state().workers.at(-1).state, 'launch-failed'); assert.equal(h.state().workers.at(-1).cleaned, 1);
  h.tick(); assert.ok(h.current());
  const w = h.current(); h.ready(w); h.startup(h.board(w)); h.retire(w); h.panes.get(w.pane).live = false; h.tick();
  h.advance(ABSENCE_MS); h.fail(Object.assign(new Error('Fixture child receipt missing'), { ownedChild: true })); h.tick();
  const held = h.current(); assert.equal(held.state, 'launch-failed'); assert.equal(held.cleaned, 0);
  assert.throws(() => h.tick(), /stable tmux IDs/); assert.equal(h.current().session, held.session);
});

test('room configuration uses SQLite for Pathfinder defaults, atomic edits and graceful removal without Start', async t => {
  const h = fixture(t, {});
  h.floor.configure({ pathfinder: null });
  let recoveries = 0;
  const room = await serveFloors({ root: h.root, ensureController() { recoveries++; } });
  t.after(() => new Promise<void>(resolve => room.server.close(() => resolve())));
  const auth = { Authorization: `Bearer ${room.token}` };
  const read = () => fetch(`${room.origin}/api/floors/one/state`, { headers: auth }).then(r => r.json());
  const post = body => fetch(`${room.origin}/api/floors/one/configuration`, { method: 'POST', headers: { ...auth, Origin: room.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const discovery = await fetch(`${room.origin}/api/floors`, { headers: auth }).then(r => r.json());
  assert.deepEqual(discovery.pathfinderDefaults, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80 });
  assert.equal((await read()).settings.pathfinder, null);
  assert.equal((await post({ pathfinder: {} })).status, 200);
  assert.deepEqual((await read()).settings.pathfinder, { provider: 'openai-codex-personal', model: 'gpt-6.1-sol', thinking: 'high', contextWarning: 80, continuation: null });
  assert.equal((await post({ pathfinder: h.pathfinder })).status, 200);
  const configured = await read();
  assert.equal(configured.status, 'stopped'); assert.equal(recoveries, 0);
  assert.equal(configured.settings.pathfinder.provider, 'openai-codex-personal');
  assert.equal(configured.settings.pathfinder.continuation, node);
  const reopened = openFloor('one', { root: h.root });
  assert.deepEqual(reopened.settings().pathfinder, configured.settings.pathfinder); reopened.close();
  const prior = h.floor.settings();
  for (const body of [{}, { pathfinder: false }, { pathfinder: { ...h.pathfinder, continuation: 'invalid' } },
    { pathfinder: { ...h.pathfinder, model: 'unapproved' } }, { pathfinder: null, slots: null }, { pathfinder: null, command: '/bin/sh' }]) {
    assert.equal((await post(body)).status, 400); assert.deepEqual(h.floor.settings(), prior);
  }
  h.start(); floorMessage(h, 'room-wake', '@PATHFINDER fixture'); h.tick(); h.ready(h.current());
  const occupant = h.current();
  const peers = h.peers().map(w => w.session);
  assert.equal((await post({ pathfinder: { ...h.pathfinder, provider: 'openai-codex-fixture', model: 'gpt-6-luna', continuation: null } })).status, 200);
  assert.equal(h.current().launch_config.model, 'gpt-6.1-sol');
  assert.equal((await read()).settings.pathfinder.model, 'gpt-6-luna');
  assert.deepEqual(h.peers().map(w => w.session), peers);
  assert.equal((await post({ pathfinder: null })).status, 200);
  assert.equal((await read()).settings.pathfinder, null);
  assert.equal(h.current().session, occupant.session); assert.equal(h.current().retire_requested, 'slot removed');
  assert.ok(h.peers().every(w => !w.retire_requested));
});

test('an explicitly configured local Pathfinder uses the same global OSS lease and cleanup barrier', t => {
  const h = fixture(t);
  const local = { ...h.pathfinder, provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' };
  h.floor.configure({ pathfinder: local });
  assert.throws(() => h.floor.configure({ slots: [{ ...route, id: 'a', provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' }, { ...route, id: 'b' }] }), /one OSS/);
  h.start(); floorMessage(h, 'request', '@PATHFINDER fixture review'); h.tick(); assert.equal(h.current(), undefined);
  selectOssFloor('one', { root: h.root }); h.tick(); const w = h.current(), b = h.ready(w); h.startup(b);
  assert.equal(ossStatus({ root: h.root }).session, w.session);
  selectOssFloor(null, { root: h.root }); assert.equal(h.current().retire_requested, 'OSS floor selection changed');
  h.retire(w, b); h.tick(); assert.equal(ossStatus({ root: h.root }).session, w.session);
  h.panes.get(w.pane).live = false; h.tick(); assert.equal(ossStatus({ root: h.root }).session, null);
  assert.equal(h.current(), undefined);
});
