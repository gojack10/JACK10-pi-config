import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openBoard } from './board.mjs';
import { tick, workerCommand, bootMission, validateLaunch, settingsFor, quote, openRun, main, parentSession } from './controller.mjs';
import { installWorker, handoffTool, wrapup, warningType } from './worker.mjs';
import { receiver } from './receiver.mjs';

const executable = resolve('bin/board');
const root = '11111111-1111-4111-8111-111111111111';
const instructions = '22222222-2222-4222-8222-222222222222';
function fixture(t, controller = true) {
  const dir = mkdtempSync(join(tmpdir(), 'bf2-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "BF2 repo's checkout"), agentDir = join(dir, 'agent');
  mkdirSync(cwd); mkdirSync(join(cwd, '.git')); mkdirSync(agentDir); mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(agentDir, 'settings.shared.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  const settings = { cwd, agentDir, code: process.cwd(), root, instructions, provider: 'openai-codex-test', model: 'gpt-6.1-sol', thinking: 'high' };
  const config = { database: join(dir, 'board.sqlite'), run: 'isolated-run', session: 'controller', sender: '00000000' };
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run: config.run }));
  const board = openBoard(config); board.lifecycle.initialize(settings);
  t.after(() => board.close());
  if (controller) board.lifecycle.controllerSetup(() => '$0');
  const calls = [], panes = new Map(), children = new Map(), options = new Map([['$0:@bf2_swarm_run', config.run]]); let failNext = false, nextPane = 1;
  const execute = args => {
    calls.push(args);
    const target = args[args.indexOf('-t') + 1];
    let stdout = '';
    if (args[0] === 'new-session') {
      if (failNext) { failNext = false; return { status: 1, stdout: '', stderr: 'synthetic launch error' }; }
      assert.ok(args.includes('-P')); assert.equal(args[args.indexOf('-F') + 1], '#{session_id} #{pane_id}');
      const paneId = `%${nextPane}`, child = `$${nextPane++}`;
      panes.set(paneId, true); children.set(child, paneId);
      stdout = `${child} ${paneId}\n`;
    }
    if (args[0] === 'display-message') {
      const owner = [...children].find(([, pane]) => pane === target)?.[0];
      stdout = owner ? `${panes.get(target) ? '0' : '1'} ${owner}\n` : '';
    }
    if (args[0] === 'set-option') options.set(`${target}:${args.at(-2)}`, args.at(-1));
    if (args[0] === 'show-options') stdout = options.get(`${target}:${args.at(-1)}`) ?? '';
    if (args[0] === 'list-sessions') stdout = ['$0', ...children.keys()].join('\n');
    if (args[0] === 'list-panes') stdout = children.get(target) ?? '';
    if (args[0] === 'kill-pane') {
      panes.delete(target);
      for (const [id, pane] of children) if (pane === target) children.delete(id);
    }
    if (args[0] === 'kill-session') { panes.delete(children.get(target)); children.delete(target); }
    return { status: 0, stdout, stderr: '' };
  };
  const workerBoard = worker => {
    const w = openBoard({ ...config, session: worker.session, sender: worker.sender });
    t.after(() => w.close()); return w;
  };
  const boot = () => {
    tick(board, config, execute);
    const workers = board.lifecycle.status().workers.filter(w => w.state === 'launching');
    for (const worker of workers) workerBoard(worker).lifecycle.ready();
    return workers;
  };
  const envFor = worker => ({ ...process.env, BF2_SWARM_WORKER: '1', BF2_BOARD_DB: config.database,
    BF2_BOARD_RUN: config.run, BF2_BOARD_SESSION: worker.session, BF2_BOARD_SENDER: worker.sender });
  return { dir, config, settings, board, calls, panes, execute, boot, workerBoard, envFor, fail: () => { failNext = true; } };
}
function fakePi(t, h, worker) {
  const handlers = new Map(), messages = [], entries = []; let percent, shuts = 0, drained = true;
  const file = join(h.dir, 'sessions', `${worker.session}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'session', id: worker.session }) + '\n');
  const ctx = { sessionManager: { getSessionId: () => worker.session, getSessionFile: () => file,
    getEntries: () => entries, getBranch: () => entries }, getContextUsage: () => ({ percent }),
    shutdown: () => { shuts++; } };
  const pi = { on: (event, fn) => handlers.set(event, fn), getSettings: () => ({ steeringMode: 'all', followUpMode: 'all' }),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    async sendUserMessage(text, options) {
      if (options.admissionGuard && !options.admissionGuard()) return { status: 'rejected', reason: 'guard' };
      const handled = handlers.get('input')?.({ source: 'extension', text }, ctx);
      messages.push({ text, options, handled });
      return { status: 'admitted', delivery: handled ? 'custom' : 'steer' };
    } };
  const api = installWorker(pi, h.envFor(worker), () => drained);
  t.after(() => handlers.get('session_shutdown')?.({}, ctx));
  return { pi, ctx, handlers, messages, entries, api, shuts: () => shuts,
    usage: value => { percent = value; }, draining: value => { drained = !value; } };
}

test('three fake tmux boots have normal route/env, unique durable sessions, minimal USER @files', t => {
  const h = fixture(t), workers = h.boot();
  assert.equal(workers.length, 3);
  assert.equal(new Set(workers.map(w => w.session)).size, 3);
  assert.equal(new Set(workers.map(w => w.sender)).size, 3);
  for (const worker of workers) {
    assert.match(worker.sender, /^[a-f0-9]{8}$/);
    assert.match(worker.pane, /^%\d+$/);
    const name = `bf2-${h.config.run}-${worker.sender}`;
    const call = h.calls.find(a => a[0] === 'new-session' && a.includes(name));
    assert.equal(call[call.indexOf('-s') + 1], name);
    assert.match(worker.tmux_session, /^\$\d+$/);
    assert.ok(h.calls.some(a => a[0] === 'set-option' && a.at(-2) === '@pi_subagent_parent_id' && a.at(-1) === '$0' && a[a.indexOf('-t') + 1] === worker.tmux_session));
    assert.ok(h.calls.some(a => a[0] === 'pipe-pane' && a[a.indexOf('-t') + 1] === worker.pane));
    assert.equal(call[call.indexOf('-c') + 1], h.settings.cwd);
    const command = call.at(-1);
    assert.match(command, /^tmux wait-for 'bf2-boot-.*' && tmux set-option -w -t "\$TMUX_PANE" remain-on-exit on && exec /);
    assert.ok(command.includes(`'--name' ${quote(name)}`));
    assert.ok(command.includes("'--provider' 'openai-codex-test' '--model' 'gpt-6.1-sol' '--thinking' 'high'"));
    assert.ok(command.includes(`'BF2_BOARD_SESSION=${worker.session}'`));
    assert.ok(command.includes(`'BF2_BOARD_SENDER=${worker.sender}'`));
    assert.ok(command.includes(`'BF2_BOARD_DB=${h.config.database}'`));
    assert.ok(command.includes(`'BF2_BOARD_RUN=${h.config.run}'`));
    assert.match(command, /PATH=.*\/bin:/);
    assert.ok(command.includes(quote(join(h.dir, 'sessions'))));
    assert.match(command, /bf2-swarm\.ts/); assert.match(command, /bf2-board\.ts/);
    for (const prohibited of ['--no-extensions', '--no-session', '--print', 'rlm-friendly-stop', 'report.md']) assert.ok(!command.includes(prohibited));
    const mission = readFileSync(join(h.dir, `${worker.session}.boot.txt`), 'utf8');
    assert.equal(mission, bootMission(h.settings));
    assert.ok(mission.indexOf('5c2f91e4') < mission.indexOf(root));
    assert.ok(mission.indexOf(root) < mission.indexOf(instructions));
  }
  const scrubbed = workerCommand(h.settings, { ...h.config, ...workers[0] }, workers[0].pane, '/tmp/mission', {
    PATH: '/bin', PI_SUBAGENT_MANIFEST: '/old/task', PI_RLM_FRIENDLY_STOP: 'yes', BF2_BOARD_RUN: 'old-run', TMUX_PANE: '%old',
  });
  assert.match(scrubbed, /'-u' 'PI_SUBAGENT_MANIFEST'/);
  assert.match(scrubbed, /'-u' 'PI_RLM_FRIENDLY_STOP'/);
  assert.ok(!scrubbed.includes('/old/task'));
});

test('capture failure is diagnostic and still registers the launch pane ID', t => {
  const h = fixture(t), errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  tick(h.board, h.config, args => args[0] === 'pipe-pane' ? { status: 1, stdout: '', stderr: 'synthetic capture failure' } : h.execute(args));
  assert.equal(errors.length, 3);
  assert.ok(errors.every(e => /BF2 swarm pane capture: synthetic capture failure/.test(e)));
  assert.ok(h.board.lifecycle.status().workers.every(w => w.state === 'launching' && /^%\d+$/.test(w.pane)));
  tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers.length, 3);
  assert.ok(h.calls.filter(a => a[0] === 'display-message').every(a => /^%\d+$/.test(a[a.indexOf('-t') + 1])));
});

test('missing pane receipts fail registration; legacy names never probe a selected window', t => {
  const h = fixture(t);
  tick(h.board, h.config, args => args[0] === 'new-session' ? { status: 0, stdout: '', stderr: '' } : h.execute(args));
  assert.ok(h.board.lifecycle.status().workers.every(w => w.state === 'launch-failed' && !w.cleaned));
  assert.deepEqual(h.calls.map(a => a[0]), ['has-session', 'show-options'], 'no empty-target capture or health commands');
  assert.throws(() => tick(h.board, h.config, h.execute), /stable tmux IDs.*fresh run/);
  const legacy = fixture(t);
  legacy.board.lifecycle.addWorker('legacy-session', 'eeeeeeee', 'legacy-name');
  assert.throws(() => tick(legacy.board, legacy.config, legacy.execute), /stable tmux IDs.*fresh run/);
  assert.deepEqual(legacy.calls, []);
});

test('controller health and recovery retain a stable pane ID, not the selected window', async t => {
  const h = fixture(t, false), calls = []; let paneId, dead = false;
  const execute = args => {
    calls.push(args);
    const result = { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'has-session') result.status = paneId ? 0 : 1;
    if (args[0] === 'show-options') result.stdout = args.at(-1) === '@bf2_swarm_run' ? h.config.run : paneId;
    if (args[0] === 'display-message') {
      assert.equal(args[args.indexOf('-t') + 1], paneId ?? '%41');
      result.stdout = args.at(-1) === '#{session_id}' ? '$0' : `${dead ? '1' : '0'} $0`;
    }
    if (['new-session', 'new-window'].includes(args[0])) {
      assert.ok(args.includes('-P')); assert.equal(args[args.indexOf('-F') + 1], '#{pane_id}');
      result.stdout = dead ? '%42' : '%41';
    }
    if (args[0] === 'set-option' && args.at(-2) === '@bf2_controller_pane') paneId = args.at(-1);
    return result;
  };
  const resume = () => main(['resume', '--run-dir', h.dir], {}, execute);
  await resume(); assert.equal(paneId, '%41');
  await resume(); assert.equal(calls.filter(a => a[0] === 'new-session').length, 1);
  dead = true; await resume(); assert.equal(paneId, '%41');
  assert.equal(calls.filter(a => a[0] === 'new-window').length, 0);
  assert.equal(calls.filter(a => a[0] === 'respawn-pane').length, 1);
  assert.deepEqual(calls.filter(a => a[0] === 'has-session').map(a => a.at(-1)), [`=${parentSession(h.config)}`, '$0', '$0']);
});

test('isolated real tmux: controller + three nested children, cleanup/replacement/recovery/wait/stop', async t => {
  const h = fixture(t, false), tmuxDir = mkdtempSync(join(tmpdir(), 'bf2-tmux-'));
  const socket = join(tmuxDir, 'tmux.sock'), conf = join(tmuxDir, 'tmux.conf');
  writeFileSync(conf, 'set -g base-index 1\nset -g pane-base-index 1\n');
  const live = args => spawnSync('tmux', ['-S', socket, '-f', conf, ...args], { encoding: 'utf8' });
  t.after(() => {
    try {
      live(['kill-server']); // Only this unique test socket, even after a failed assertion.
      assert.notEqual(live(['list-sessions']).status, 0);
      console.log(`isolated tmux cleaned: ${socket}; no server remains`);
    } finally { rmSync(tmuxDir, { recursive: true, force: true }); }
  });
  const checked = args => { const r = live(args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const calls = [];
  const execute = args => {
    calls.push(args);
    if (args[0] === 'new-session' && args[args.indexOf('-F') + 1] === '#{session_id} #{pane_id}') {
      // Preserve the real boot barrier and prove tags already exist at shell startup.
      const id = args.at(-1).match(/'BF2_BOARD_SESSION=([^']+)'/)[1];
      const parent = h.board.lifecycle.status().tmux_parent;
      args = [...args.slice(0, -1), args.at(-1).split(' && exec ')[0] +
        ` && test "$(tmux show-options -qv -t "$TMUX_PANE" @pi_subagent_parent_id)" = ${quote(parent)}` +
        ` && test "$(tmux show-options -qv -t "$TMUX_PANE" @bf2_swarm_session)" = ${quote(id)}` +
        ` && printf tagged > ${quote(join(h.dir, `${id}.booted`))} && exec /bin/sh`];
    } else if (['new-session', 'new-window', 'respawn-pane'].includes(args[0])) {
      // Controller is also just a harmless shell, never Pi or models.
      args = [...args.slice(0, -1), `tmux -S ${quote(socket)} set-option -w -t "$TMUX_PANE" remain-on-exit on && exec /bin/sh`];
    }
    return live(args);
  };
  const eventually = async check => {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
    assert.fail('isolated tmux did not reach expected shell state');
  };
  let parent, target;
  const recover = async () => {
    await main(['run', '--run-dir', h.dir], {}, execute);
    parent = target = h.board.lifecycle.status().tmux_parent;
  };
  const unrelated = checked(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'unrelated', '/bin/sh']);
  const windows = () => checked(['list-windows', '-t', target, '-F', '#{window_name}']).split('\n');
  const sessions = () => checked(['list-sessions', '-F', '#{session_name}']).split('\n');
  const exit = async pane => {
    checked(['send-keys', '-t', pane, 'exit', 'Enter']);
    await eventually(() => checked(['display-message', '-p', '-t', pane, '#{pane_dead}']) === '1');
  };
  await recover();
  let controller = checked(['show-options', '-v', '-t', parent, '@bf2_controller_pane']);
  assert.equal(checked(['display-message', '-p', '-t', controller, '#{window_index}.#{pane_index}']), '1.1');
  tick(h.board, h.config, execute);
  const workers = h.board.lifecycle.status().workers;
  assert.equal(workers.length, 3); assert.equal(windows().length, 1); assert.equal(sessions().length, 5);
  for (const worker of workers) {
    h.workerBoard(worker).lifecycle.ready();
    await eventually(() => existsSync(join(h.dir, `${worker.session}.booted`)));
    assert.equal(checked(['display-message', '-p', '-t', worker.pane, '#{session_id} #{window_index}.#{pane_index}']), `${worker.tmux_session} 1.1`);
    assert.equal(checked(['show-options', '-qv', '-t', worker.tmux_session, '@pi_subagent_parent_id']), parent);
  }
  // Selection changes never affect worker health, capture or controller recovery.
  checked(['select-window', '-t', workers[2].pane]);
  checked(['rename-session', '-t', parent, 'renamed-controller']);
  checked(['rename-session', '-t', workers[0].tmux_session, 'renamed-peer']);
  await recover(); assert.equal(calls.filter(a => a[0] === 'new-session' && a.includes('controller')).length, 1);
  const oilCheck = join(h.dir, 'oil.lua');
  writeFileSync(oilCheck, `local s = tmux_oil.snapshot()\n` + workers.map(w =>
    `assert(s.parent_by_id[${JSON.stringify(w.tmux_session)}] == ${JSON.stringify(parent)})\nassert(s.tree_prefix_by_id[${JSON.stringify(w.tmux_session)}] ~= '')\n`).join('') +
    `assert(s.parent_by_id[${JSON.stringify(unrelated)}] == nil)\nprint('installed tmux-oil model groups all three peers by native parent ID')\n`);
  const oil = spawnSync('/Users/jack/.local/bin/tmux-oil', [], { env: { ...process.env, TMUX: `${socket},0,0`, TMUX_OIL_TEST_LUA: oilCheck }, encoding: 'utf8' });
  assert.equal(oil.status, 0, oil.stderr);
  console.log('installed tmux-oil model verified native-ID nesting after parent/peer renames');
  const inspection = checked(['new-window', '-P', '-F', '#{pane_id}', '-t', `${target}:`, '-n', 'inspection', '/bin/sh']);
  await exit(controller); await recover();
  assert.equal(checked(['show-options', '-v', '-t', parent, '@bf2_controller_pane']), controller);
  assert.equal(calls.filter(a => a[0] === 'respawn-pane').length, 1);
  assert.equal(windows().length, 2, 'controller reuses its window, not selected inspection shell');
  assert.equal(checked(['display-message', '-p', '-t', inspection, '#{pane_dead}']), '0');
  const worker = workers[0], peer = h.workerBoard(worker);
  checked(['send-keys', '-t', inspection, 'printf "inspection-only\\n"', 'Enter']);
  checked(['send-keys', '-t', worker.pane, 'printf "stable-worker-output\\n"', 'Enter']);
  const log = join(h.dir, `${worker.session}.pane.log`);
  await eventually(() => existsSync(log) && readFileSync(log, 'utf8').includes('stable-worker-output'));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /inspection-only/);
  peer.lifecycle.done('Final tree handoff'); tick(h.board, h.config, execute);
  peer.lifecycle.settled(); tick(h.board, h.config, execute);
  assert.equal(h.board.lifecycle.status().workers.length, 3, 'SAFE marker cannot kill a still-live process');
  assert.throws(() => h.board.lifecycle.resume(), /finish\/exit/);
  checked(['send-keys', '-t', worker.pane, `printf orderly-completion > ${quote(join(h.dir, 'preserved'))}`, 'Enter']);
  await exit(worker.pane); tick(h.board, h.config, execute);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retired');
  assert.equal(h.board.lifecycle.status().workers[0].cleaned, 1);
  assert.equal(live(['display-message', '-p', '-t', worker.pane, '#{pane_dead}']).stdout.trim(), '');
  assert.equal(readFileSync(join(h.dir, 'preserved'), 'utf8'), 'orderly-completion');
  assert.ok(existsSync(log)); assert.equal(windows().length, 2); assert.equal(sessions().length, 5);
  assert.equal(live(['has-session', '-t', worker.tmux_session]).status, 1);
  assert.equal(h.board.lifecycle.status().workers.length, 4);
  // Retained dead panes and already-removed panes both produce exactly one accurate notice.
  process.kill(Number(checked(['display-message', '-p', '-t', workers[1].pane, '#{pane_pid}'])), 'SIGKILL');
  await eventually(() => checked(['display-message', '-p', '-t', workers[1].pane, '#{pane_dead}']) === '1');
  tick(h.board, h.config, execute);
  checked(['kill-pane', '-t', workers[2].pane]); tick(h.board, h.config, execute);
  tick(h.board, h.config, execute); tick(h.board, h.config, execute);
  assert.equal(windows().length, 2); assert.equal(sessions().length, 5); assert.equal(h.board.lifecycle.status().workers.length, 6);
  for (const old of workers.slice(1)) {
    assert.equal(h.board.history({ limit: 100 }).posts.filter(p => p.text === `${old.sender} exited without a retirement message.`).length, 1);
    assert.equal(live(['display-message', '-p', '-t', old.pane, '#{pane_dead}']).stdout.trim(), '');
  }
  // Keep inspection alive while removing controller: tmux destroys a session's last pane.
  checked(['select-window', '-t', h.board.lifecycle.status().workers.at(-1).pane]);
  checked(['kill-pane', '-t', controller]); await recover();
  controller = checked(['show-options', '-v', '-t', parent, '@bf2_controller_pane']);
  checked(['kill-pane', '-t', inspection]);
  assert.equal(windows().length, 1, 'vanished controller restored within existing parent');
  const current = h.board.lifecycle.status().workers.filter(w => !w.cleaned), peers = current.map(h.workerBoard);
  peers.forEach(p => p.lifecycle.ready());
  const request = peers[0].post('One waiting request / tree pointer');
  peers.forEach(p => p.lifecycle.vote(request, 'same request'));
  assert.equal(h.board.lifecycle.status().status, 'waiting');
  await exit(controller); await recover(); tick(h.board, h.config, execute);
  assert.equal(h.board.lifecycle.status().status, 'waiting'); assert.equal(windows().length, 1);
  for (let i = 0; i < peers.length; i++) {
    peers[i].lifecycle.done('Waiting tree checkpoint'); peers[i].lifecycle.settled();
    tick(h.board, h.config, execute); // Live SAFE peer stays until real shell exit.
    await exit(current[i].pane); tick(h.board, h.config, execute);
  }
  tick(h.board, h.config, execute); assert.deepEqual(windows(), ['controller']);
  assert.equal(sessions().length, 2, 'unanimity drains to parent plus unrelated session');
  assert.equal(h.board.lifecycle.status().workers.length, 6);
  await exit(controller); await recover(); assert.deepEqual(windows(), ['controller']);
  await main(['resume', '--run-dir', h.dir], {}, execute);
  // A human stop starts while new-session is still inside the allocation transaction.
  // It may win between allocations, but every released shell must be registered.
  let stopper;
  const attempted = join(h.dir, 'stop-attempted');
  tick(h.board, h.config, args => {
    if (args[0] === 'new-session' && !stopper) {
      stopper = spawn(process.execPath, ['--input-type=module', '-e', `
        import { writeFileSync } from 'node:fs';
        import { openBoard } from ${JSON.stringify(new URL('./board.mjs', import.meta.url).href)};
        writeFileSync(${JSON.stringify(attempted)}, 'stop requested');
        const b = openBoard(${JSON.stringify(h.config)});
        try { b.lifecycle.stop(); } finally { b.close(); }
      `], { stdio: 'pipe' });
      t.after(() => { if (stopper.exitCode === null) stopper.kill(); });
      const deadline = Date.now() + 2000;
      while (!existsSync(attempted) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      assert.ok(existsSync(attempted));
    }
    return execute(args);
  });
  await new Promise((resolve, reject) => {
    stopper.once('error', reject); stopper.once('exit', code => code === 0 ? resolve() : reject(new Error(`stop child exit ${code}`)));
  });
  const released = h.board.lifecycle.status().workers.filter(w => !w.cleaned);
  assert.ok(released.length >= 1 && released.length <= 3);
  assert.equal(windows().length, 1);
  assert.equal(sessions().length, released.length + 2, 'every released child has one registered capacity row');
  tick(h.board, h.config, execute);
  assert.equal(h.board.lifecycle.status().workers.filter(w => !w.cleaned).length, released.length);
  const stopping = h.board.lifecycle.status().workers.filter(w => !w.cleaned);
  stopping.forEach(w => h.workerBoard(w).lifecycle.ready());
  await main(['stop', '--run-dir', h.dir], {}, execute);
  await exit(controller); await recover(); // Recovery respects persisted human stop.
  for (const w of stopping) {
    const p = h.workerBoard(w); p.lifecycle.done('Human stop handoff'); p.lifecycle.settled();
    tick(h.board, h.config, execute); await exit(w.pane); tick(h.board, h.config, execute);
  }
  tick(h.board, h.config, execute); tick(h.board, h.config, execute);
  assert.equal(h.board.lifecycle.status().status, 'stopped');
  assert.ok(h.board.lifecycle.status().workers.every(w => w.cleaned));
  assert.deepEqual(windows(), ['controller']); assert.equal(calls.filter(a => a[0] === 'new-session' && a.includes('controller')).length, 1);
  // Exercise the real controller's final drain path (no workers/model calls).
  await main(['run', '--run-dir', h.dir], { BF2_SWARM_CONTROLLER: '1' }, execute);
  assert.equal(checked(['show-options', '-w', '-v', '-t', controller, 'remain-on-exit']), 'off');
  checked(['send-keys', '-t', controller, 'exit', 'Enter']);
  await eventually(() => live(['has-session', '-t', target]).status !== 0);
  assert.deepEqual(sessions(), ['unrelated'], 'explicit stop leaves no parent or worker residue, preserves unrelated');
  checked(['kill-session', '-t', unrelated]);
  // A new server can reuse %pane numbers: historical rows must not block fresh capacity.
  await main(['resume', '--run-dir', h.dir], {}, execute);
  parent = target = h.board.lifecycle.status().tmux_parent;
  tick(h.board, h.config, execute);
  assert.equal(windows().length, 1); assert.equal(sessions().length, 4);
  assert.equal(h.board.lifecycle.status().workers.filter(w => !w.cleaned).length, 3);
  // Repeated clean retirements never accumulate terminal child sessions.
  for (let i = 0; i < 3; i++) {
    const w = h.board.lifecycle.status().workers.find(w => !w.cleaned);
    await eventually(() => existsSync(join(h.dir, `${w.session}.booted`)));
    const p = h.workerBoard(w); p.lifecycle.ready(); p.lifecycle.done('repeat checkpoint'); p.lifecycle.settled();
    await exit(w.pane); tick(h.board, h.config, execute);
    assert.equal(live(['has-session', '-t', w.tmux_session]).status, 1);
    assert.equal(sessions().length, 4);
  }
  // Foreign windows and extra panes survive as roots, without trapping capacity.
  const modified = h.board.lifecycle.status().workers.filter(w => !w.cleaned).slice(0, 2);
  const foreign = [
    checked(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${modified[0].tmux_session}:`, '-n', 'user-window', '/bin/sh']),
    checked(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', modified[1].pane, '/bin/sh']),
  ];
  for (let i = 0; i < modified.length; i++) {
    const w = modified[i];
    await eventually(() => existsSync(join(h.dir, `${w.session}.booted`)));
    const p = h.workerBoard(w); p.lifecycle.ready(); p.lifecycle.done('modified child checkpoint'); p.lifecycle.settled();
    await exit(w.pane); tick(h.board, h.config, execute); tick(h.board, h.config, execute);
    assert.equal(checked(['display-message', '-p', '-t', foreign[i], '#{pane_dead}']), '0');
    assert.equal(checked(['show-options', '-qv', '-t', w.tmux_session, '@pi_subagent_parent_id']), '');
    assert.equal(h.board.lifecycle.status().workers.filter(w => !w.cleaned).length, 3);
    checked(['kill-pane', '-t', foreign[i]]); // Explicitly test-owned; production never kills it.
    assert.equal(sessions().length, 4);
  }
  h.board.lifecycle.stop();
  for (const w of h.board.lifecycle.status().workers.filter(w => !w.cleaned)) {
    await eventually(() => existsSync(join(h.dir, `${w.session}.booted`)));
    await exit(w.pane);
  }
  tick(h.board, h.config, execute);
  controller = checked(['show-options', '-v', '-t', parent, '@bf2_controller_pane']);
  await main(['run', '--run-dir', h.dir], { BF2_SWARM_CONTROLLER: '1' }, execute);
  checked(['send-keys', '-t', controller, 'exit', 'Enter']);
  await eventually(() => live(['has-session', '-t', target]).status !== 0);
  assert.notEqual(live(['list-sessions']).status, 0);
});

test('boot setup failure removes gated child before capacity release; parent loss never creates a second parent', async t => {
  const h = fixture(t);
  tick(h.board, h.config, args => args[0] === 'set-option' && args.at(-2) === '@pi_subagent_parent_id' ?
    { status: 1, stderr: 'synthetic metadata failure' } : h.execute(args));
  assert.equal(h.panes.size, 0);
  assert.ok(h.board.lifecycle.status().workers.every(w => w.state === 'launch-failed' && w.cleaned));
  assert.equal(h.calls.some(a => a[0] === 'wait-for'), false, 'failed metadata never releases a process');
  tick(h.board, h.config, h.execute);
  const before = h.calls.length;
  await assert.rejects(main(['run', '--run-dir', h.dir], {}, args => args[0] === 'has-session' ? { status: 1 } : h.execute(args)), /undrained children.*second parent/);
  assert.equal(h.calls.length, before);
});

test('first activation broadcasts one system join; repeated session_start and reconstruction never repost', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const workers = h.board.lifecycle.status().workers, peers = workers.slice(1).map(h.workerBoard);
  for (const peer of peers) { peer.lifecycle.ready(); peer.finishStartup(peer.history().highwater); }
  const worker = workers[0], f = fakePi(t, h, worker);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'active');
  const joined = `${worker.sender} joined.`;
  const posts = () => h.board.history({ limit: 100 }).posts.filter(p => p.text === joined);
  assert.equal(posts().length, 1); assert.equal(posts()[0].sender, '[system]');
  for (const peer of peers) {
    const batch = peer.pending();
    assert.match(batch.text, /\[system\]/);
    assert.ok(batch.text.includes(JSON.stringify(joined)));
    assert.equal(batch.through, posts()[0].number);
  }
  await f.handlers.get('session_start')({}, f.ctx);
  f.handlers.get('session_shutdown')({}, f.ctx);
  const reloaded = fakePi(t, h, worker); await reloaded.handlers.get('session_start')({}, reloaded.ctx);
  const reopened = h.workerBoard(worker); reopened.lifecycle.ready();
  assert.equal(posts().length, 1);
  reopened.lifecycle.done('final handoff'); reopened.lifecycle.settled();
  assert.equal(h.board.history({ limit: 100 }).posts.length, 4, 'normal retirement needs no redundant system post');
});

test('join post and activation roll back together on insertion failure', t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const worker = h.board.lifecycle.status().workers[0], peer = h.workerBoard(worker);
  const db = new DatabaseSync(h.config.database); t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_join BEFORE INSERT ON board_posts
    BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;`);
  assert.throws(() => peer.lifecycle.ready(), /synthetic insert failure/);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'launching');
  assert.equal(h.board.history().posts.length, 0);
  db.exec('DROP TRIGGER reject_join'); peer.lifecycle.ready();
  assert.equal(h.board.lifecycle.status().workers[0].state, 'active');
  assert.equal(h.board.history().posts[0].text, `${worker.sender} joined.`);
});

test('real compound bash done stores one handoff; replacement waits agent_settled and background drain', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const worker = h.board.lifecycle.status().workers[0], f = fakePi(t, h, worker);
  await f.handlers.get('session_start')({}, f.ctx);
  const result = spawnSync('/bin/bash', ['-c', `${quote(executable)} done 'final handoff'; printf preserved > ${quote(join(h.dir, 'artifact'))}; ${quote(executable)} read; ${quote(resolve('bin/bf2-swarm'))} status --run-dir ${quote(h.dir)} > ${quote(join(h.dir, 'compound-status.json'))}`], { env: h.envFor(worker), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retirement requested.*\nBoard run/s);
  assert.equal(readFileSync(join(h.dir, 'artifact'), 'utf8'), 'preserved');
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'compound-status.json'), 'utf8')).workers[0].state, 'retiring');
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
  const before = h.calls.filter(a => a[0] === 'new-session').length;
  tick(h.board, h.config, h.execute); assert.equal(h.calls.filter(a => a[0] === 'new-session').length, before);
  await f.handlers.get('turn_end')({}, f.ctx); assert.equal(f.shuts(), 0);
  f.draining(true);
  f.handlers.get('agent_settled')({ type: 'agent_settled' }, f.ctx);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
  assert.equal(f.handlers.get('input')({ source: 'extension', text: 'SYSTEM (background-jobs): All 1 background job(s) in this batch finished.' }, f.ctx), undefined);
  f.draining(false);
  f.handlers.get('agent_settled')({ type: 'agent_settled' }, f.ctx);
  assert.equal(f.shuts(), 1);
  assert.throws(() => h.board.lifecycle.resume(), /finish\/exit/);
  tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers.length, 3, 'SAFE is not shutdown completion');
  assert.equal(h.calls.some(a => a[0] === 'kill-pane'), false);
  h.panes.set(worker.pane, false);
  tick(h.board, h.config, h.execute);
  const state = h.board.lifecycle.status();
  assert.equal(state.workers[0].state, 'retired');
  assert.equal(state.workers.length, 4);
  assert.notEqual(state.workers[3].sender, worker.sender);
  assert.notEqual(state.workers[3].session, worker.session);
  assert.equal(h.board.history({ limit: 100 }).posts.filter(p => p.text === 'final handoff').length, 1);
  assert.ok(existsSync(join(h.dir, 'artifact')));
});

test('ordinary settlement is not retirement; genuine tool alias terminates without report duplication', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const worker = h.board.lifecycle.status().workers[0], f = fakePi(t, h, worker);
  await f.handlers.get('session_start')({}, f.ctx);
  f.handlers.get('agent_settled')({ type: 'agent_settled' }, f.ctx);
  tick(h.board, h.config, h.execute); assert.equal(h.board.lifecycle.status().workers.length, 3);
  const tool = handoffTool(f.api, { type: 'object' });
  assert.equal(tool.name, 'messaged_outcome');
  await assert.rejects(tool.execute('1', { handoff: '' }, undefined, undefined, f.ctx), /nonempty/);
  const result = await tool.execute('1', { handoff: 'Tree node updated; inspect commit.' }, undefined, undefined, f.ctx);
  assert.equal(result.terminate, true); assert.equal(f.shuts(), 0);
  assert.deepEqual(result.details, { number: 2 }); // First activation already posted join #1.
  assert.doesNotMatch(result.content[0].text, /Tree node updated/);
  assert.equal(h.board.history().posts.find(p => p.number === result.details.number).text, 'Tree node updated; inspect commit.');
  for (const [kind, source] of [['cancel', 'escape'], ['context', 'context'], ['maintenance', 'maintenance'], ['lifecycle', 'lifecycle']]) {
    f.handlers.get('agent_settled')({ type: 'agent_settled', interruption: { kind, source, reason: 'interrupted', runId: 1 } }, f.ctx);
    assert.equal(f.shuts(), 0); assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
  }
  f.handlers.get('agent_settled')({ type: 'agent_settled' }, f.ctx); assert.equal(f.shuts(), 1);
});

test('unexpected exit posts accurate system notice and replaces; launch failure retries next tick', t => {
  const h = fixture(t), workers = h.boot();
  h.panes.set(workers[0].pane, false); h.fail();
  tick(h.board, h.config, h.execute);
  let state = h.board.lifecycle.status();
  assert.equal(state.status, 'running'); assert.equal(state.workers[0].state, 'exited');
  assert.equal(state.workers[3].state, 'launch-failed');
  assert.ok(h.board.history({ limit: 100 }).posts.some(p => p.sender === '[system]' && p.text === `${workers[0].sender} exited without a retirement message.`));
  tick(h.board, h.config, h.execute);
  state = h.board.lifecycle.status(); assert.equal(state.workers[4].state, 'launching');
  assert.equal(state.workers.filter(w => ['active', 'launching'].includes(w.state)).length, 3);
  const handoff = h.workerBoard(workers[1]); handoff.lifecycle.done('Saved final progress'); h.panes.set(workers[1].pane, false);
  tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers[1].state, 'exited-with-handoff');
  const posts = h.board.history({ limit: 100 }).posts;
  assert.ok(posts.some(p => p.text.includes('without safe settlement evidence')));
  assert.ok(!posts.some(p => p.text === `${workers[1].sender} exited without a retirement message.`));
});

test('cleanup retry is idempotent, occupies capacity until removal, and never touches a foreign pane', t => {
  const h = fixture(t), workers = h.boot();
  h.panes.set(workers[0].pane, false);
  assert.throws(() => tick(h.board, h.config, args => args[0] === 'kill-pane' ? { status: 1, stderr: 'cleanup failure' } : h.execute(args)), /cleanup failure/);
  assert.equal(h.board.lifecycle.status().workers[0].cleaned, 0);
  assert.throws(() => h.board.lifecycle.resume(), /finish\/exit/);
  tick(h.board, h.config, h.execute); tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers.length, 4);
  assert.equal(h.board.history({ limit: 100 }).posts.filter(p => p.text === `${workers[0].sender} exited without a retirement message.`).length, 1);
  const before = h.calls.length;
  assert.throws(() => tick(h.board, h.config, args => args[0] === 'display-message' ? { status: 1, stderr: 'health unavailable' } : h.execute(args)), /health unavailable/);
  assert.equal(h.board.lifecycle.status().workers.filter(w => !w.cleaned).length, 3, 'transport failure is not process death');
  assert.throws(() => tick(h.board, h.config, args => args[0] === 'display-message' ? { status: 0, stdout: '1 unrelated-session' } : h.execute(args)), /outside.*owned child/);
  assert.equal(h.calls.length, before, 'no foreign cleanup or replacement');
});

test('CLI votes need three current active IDs and same request; withdraw and replacement invalidate old vote', t => {
  const h = fixture(t), workers = h.boot(), peers = workers.map(h.workerBoard);
  const first = peers[0].post('Waiting proposal; node pointer'), second = peers[1].post('Different proposal');
  const cli = (worker, ...args) => spawnSync(executable, args, { env: h.envFor(worker), encoding: 'utf8' });
  assert.equal(cli(workers[0], 'vote', '999', 'no request').status, 1);
  assert.equal(cli({ session: 'forged-session', sender: 'eeeeeeee' }, 'vote', String(first), 'forgery').status, 1);
  assert.equal(cli({ ...workers[0], sender: 'eeeeeeee' }, 'vote', String(first), 'changed identity').status, 1);
  assert.equal(cli(workers[0], 'vote', String(first), 'tree reason').status, 0);
  assert.equal(cli(workers[1], 'vote', String(first), 'same node').status, 0);
  assert.equal(h.board.lifecycle.status().status, 'running');
  assert.equal(cli(workers[1], 'vote', '--withdraw').status, 0);
  assert.equal(peers[2].lifecycle.vote(first, 'agree'), 'running');
  assert.equal(peers[1].lifecycle.vote(second, 'other request'), 'running');
  h.panes.set(workers[2].pane, false); tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers[2].vote, null);
  assert.equal(cli(workers[2], 'vote', String(first), 'stale session').status, 1);
  assert.equal(peers[1].lifecycle.vote(first, 'agree now'), 'running', 'two votes in replacement gap must not pause');
  const replacement = h.board.lifecycle.status().workers[3], next = h.workerBoard(replacement);
  assert.throws(() => next.lifecycle.vote(first, 'not active yet'), /active/);
  next.lifecycle.ready(); assert.equal(h.board.lifecycle.status().status, 'running');
  assert.equal(next.lifecycle.vote(first, 'fresh vote'), 'waiting');
  assert.equal(h.board.lifecycle.status().request, first);
  assert.throws(() => peers[0].lifecycle.withdraw(), /running/);
  const recovered = openRun(h.dir); try { assert.equal(recovered.board.lifecycle.status().status, 'waiting'); } finally { recovered.board.close(); }
  const before = h.calls.filter(a => a[0] === 'new-session').length;
  for (const worker of [workers[0], workers[1], replacement]) {
    const peer = h.workerBoard(worker); peer.lifecycle.done('Waiting state recorded on tree'); peer.lifecycle.settled();
    h.panes.set(worker.pane, false);
  }
  tick(h.board, h.config, h.execute); assert.equal(h.calls.filter(a => a[0] === 'new-session').length, before);
  h.board.lifecycle.resume(); tick(h.board, h.config, h.execute);
  const state = h.board.lifecycle.status();
  assert.equal(state.status, 'running'); assert.equal(state.request, null);
  assert.ok(state.workers.every(w => w.vote === null));
  assert.equal(state.workers.filter(w => w.state === 'launching').length, 3);
});

test('human stop differs from waiting; safe wrapup input only, unfinished board pending retained', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const workers = h.board.lifecycle.status().workers, w = h.workerBoard(workers[0]), peer = h.workerBoard(workers[1]);
  const f = fakePi(t, h, workers[0]); await f.handlers.get('session_start')({}, f.ctx); peer.lifecycle.ready();
  w.finishStartup(0); peer.post('unfinished pending'); const pending = w.pending();
  const r = receiver(f.pi, { ...h.config, session: workers[0].session, sender: workers[0].sender }, f.ctx); t.after(() => r.close());
  h.board.lifecycle.stop();
  await r.pump(); assert.equal(f.messages.length, 0);
  assert.deepEqual(w.pending(), pending);
  await f.handlers.get('turn_end')({}, f.ctx); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].text, wrapup(h.config.run, h.board.lifecycle.status()));
  assert.equal(f.messages[0].handled, undefined);
  assert.deepEqual(f.handlers.get('input')({ source: 'interactive', text: 'new work' }, f.ctx), { action: 'handled' });
  const before = h.board.lifecycle.status().workers.length;
  tick(h.board, h.config, h.execute); assert.equal(h.board.lifecycle.status().workers.length, before);
  assert.throws(() => h.board.lifecycle.resume(), /finish\/exit/);
  w.lifecycle.done('stopped handoff'); f.handlers.get('agent_settled')({ type: 'agent_settled' }, f.ctx);
  assert.deepEqual(f.handlers.get('input')({ source: 'extension', text: 'late input' }, f.ctx), { action: 'handled' });
  assert.deepEqual(w.pending(), pending);
  for (const worker of workers) { h.panes.set(worker.pane, false); }
  tick(h.board, h.config, h.execute); assert.equal(h.board.lifecycle.status().status, 'stopped');
  h.board.lifecycle.resume(); tick(h.board, h.config, h.execute);
  assert.equal(h.board.lifecycle.status().workers.filter(w => w.state === 'launching').length, 3);
});

test('80% warning is once, known usage only, no SiftText/binary/bash blocks or forced continuation', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const worker = h.board.lifecycle.status().workers[0], f = fakePi(t, h, worker);
  await f.handlers.get('session_start')({}, f.ctx);
  for (const usage of [undefined, null, NaN, 79.9]) { f.usage(usage); await f.handlers.get('turn_end')({}, f.ctx); }
  assert.equal(f.messages.length, 0);
  f.usage(80); await f.handlers.get('turn_end')({}, f.ctx);
  f.usage(99); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.messages.length, 1); assert.equal(f.entries[0].customType, warningType);
  assert.equal(f.messages[0].options.deliverAs, 'steer'); assert.equal(f.messages[0].handled, undefined);
  assert.equal(f.shuts(), 0);
  for (const toolName of ['sifttext_get_node', 'sifttext_edit_crystallization', 'binary', 'bash', 'bash_bg']) {
    assert.equal(f.handlers.get('tool_call')?.({ toolName }, f.ctx), undefined);
  }
  assert.equal(f.handlers.has('agent_before_settle'), false);
  f.handlers.get('session_shutdown')({}, f.ctx);
  await f.handlers.get('session_start')({}, f.ctx); await f.handlers.get('turn_end')({}, f.ctx);
  assert.equal(f.messages.length, 1, 'metadata survives extension/session reconstruction');
  assert.equal(installWorker({ on() { assert.fail('inert outside experiment'); } }, {}), undefined);
});

test('installed Pi loader registers the actual opt-in tool and settles it without a task contract', { skip: !process.env.PI_PACKAGE_DIR }, async t => {
  const h = fixture(t); const worker = h.boot()[0];
  const { loadExtensions } = await import(`${process.env.PI_PACKAGE_DIR}/dist/core/extensions/loader.js`);
  const keys = ['BF2_SWARM_WORKER', 'BF2_BOARD_DB', 'BF2_BOARD_RUN', 'BF2_BOARD_SESSION', 'BF2_BOARD_SENDER'];
  const previous = keys.map(key => process.env[key]);
  let loaded;
  try {
    for (const key of keys) process.env[key] = h.envFor(worker)[key];
    loaded = await loadExtensions([resolve('optional-extensions/bf2-swarm.ts')], process.cwd());
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  loaded.runtime.getSettings = () => ({ steeringMode: 'all', followUpMode: 'all' });
  const file = join(h.dir, 'sessions', 'actual-tool.jsonl'); writeFileSync(file, '{}\n');
  let shutdown = 0;
  const ctx = { sessionManager: { getSessionId: () => worker.session, getSessionFile: () => file, getEntries: () => [] },
    shutdown: () => { shutdown++; } };
  const fire = async (event, args = {}) => { for (const handler of extension.handlers.get(event) ?? []) await handler(args, ctx); };
  t.after(() => fire('session_shutdown'));
  await fire('session_start');
  assert.equal(extension.tools.size, 1); assert.equal(extension.handlers.has('tool_call'), false);
  const tool = extension.tools.get('messaged_outcome').definition;
  assert.equal(tool.parameters.properties.handoff.type, 'string');
  const result = await tool.execute('call', { handoff: 'Actual loader handoff' }, undefined, undefined, ctx);
  assert.equal(result.terminate, true); assert.equal(shutdown, 0);
  await fire('agent_settled', { type: 'agent_settled' });
  assert.equal(shutdown, 1);
  assert.equal(h.board.history().posts.find(p => p.number === result.details.number).text, 'Actual loader handoff');
});

// Actual installed AgentSession + optional extension, with a credential-free local stream.
// PI_PACKAGE_DIR enables the same installed-runtime gate as the loader test above.
async function nativePi(t, h, worker) {
  const pkg = process.env.PI_PACKAGE_DIR;
  const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(`${pkg}/dist/index.js`);
  const { loadExtensions } = await import(`${pkg}/dist/core/extensions/loader.js`);
  const { EventStream, getModel } = await import(`${pkg}/../ai/dist/compat.js`);
  const keys = ['BF2_SWARM_WORKER', 'BF2_BOARD_DB', 'BF2_BOARD_RUN', 'BF2_BOARD_SESSION', 'BF2_BOARD_SENDER'];
  const previous = keys.map(key => process.env[key]);
  let loaded;
  try {
    for (const key of keys) process.env[key] = h.envFor(worker)[key];
    loaded = await loadExtensions([resolve('optional-extensions/bf2-swarm.ts'), resolve('extensions/background-jobs.ts')], h.settings.cwd);
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0], settled = [], order = [], errors = [];
  let ctx, shuts = 0, requests = 0;
  extension.handlers.get('session_start').push((_event, context) => { ctx = context; });
  extension.handlers.get('agent_settled').push(event => { settled.push(event); order.push('settled'); });
  const modelRuntime = await ModelRuntime.create({ authPath: join(h.dir, 'auth.json'), modelsPath: join(h.dir, 'models.json') });
  await modelRuntime.setRuntimeApiKey('anthropic', 'offline-fixture-key');
  modelRuntime.streamSimple = () => { assert.fail('native fixture must never reach a real provider'); };
  const { session } = await createAgentSession({
    cwd: h.settings.cwd, agentDir: h.settings.agentDir, modelRuntime,
    model: getModel('anthropic', 'claude-sonnet-4-5'), tools: ['messaged_outcome'],
    sessionManager: SessionManager.create(h.settings.cwd, join(h.dir, 'sessions'), { id: worker.session }),
    settingsManager: SettingsManager.inMemory({ steeringMode: 'all', followUpMode: 'all', compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: {
      getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Offline settlement fixture',
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources() {}, async reload() {},
    },
  });
  t.after(async () => {
    try {
      if (ctx) {
        for (const ext of loaded.extensions) {
          for (const handler of ext.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown' }, ctx);
        }
      }
    } finally { session.dispose(); }
  });
  session.subscribe(event => { if (event.type === 'agent_end') order.push('agent_end'); });
  await session.bindExtensions({ shutdownHandler: () => { shuts++; order.push('shutdown'); }, onError: error => errors.push(error) });
  const respond = next => {
    session.agent.streamFunction = model => {
      requests++;
      assert.ok(requests <= 3, 'offline fixture exceeded its bounded response script');
      const stream = new EventStream(e => e.type === 'done' || e.type === 'error', e => e.message ?? e.error);
      const content = next(requests);
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    };
  };
  return { session, ctx, extension, settled, order, errors, respond, shuts: () => shuts, requests: () => requests,
    bg: (name, args = {}) => loaded.extensions[1].tools.get(name).definition.execute('bg-fixture', args, undefined, undefined, ctx) };
}
const nativeOptions = { skip: !process.env.PI_PACKAGE_DIR, timeout: 10000 };
const nativeHandoff = [{ type: 'toolCall', id: 'handoff', name: 'messaged_outcome', arguments: { handoff: 'Native final tree pointer' } }];
const nativeFinal = [{ type: 'text', text: 'Finished safely.' }];

test('native AgentSession emits no outcome and retires terminate:true only after the tool batch', nativeOptions, async t => {
  const h = fixture(t), worker = h.boot()[0], n = await nativePi(t, h, worker);
  n.respond(() => nativeHandoff);
  await n.session.prompt('Retire');
  assert.deepEqual(n.settled, [{ type: 'agent_settled', interruption: undefined }]);
  assert.deepEqual(n.errors, []);
  assert.equal(n.requests(), 1, 'terminate:true suppresses the automatic model follow-up');
  assert.equal(n.session.messages.at(-1).role, 'toolResult');
  assert.equal(n.shuts(), 1);
  assert.ok(n.order.indexOf('agent_end') < n.order.indexOf('shutdown'));
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retired');
});

test('native AgentSession CLI done keeps compound bash work and final follow-up before retirement', nativeOptions, async t => {
  const h = fixture(t), worker = h.boot()[0], n = await nativePi(t, h, worker);
  const tool = n.extension.tools.get('messaged_outcome').definition;
  tool.execute = async () => {
    const result = spawnSync('/bin/bash', ['-c', `${quote(executable)} done 'Native CLI handoff'; printf kept > ${quote(join(h.dir, 'native-artifact'))}`], { env: h.envFor(worker), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(n.shuts(), 0); assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
    return { content: [{ type: 'text', text: result.stdout }], details: undefined }; // bash has no terminate flag
  };
  n.respond(request => request === 1 ? nativeHandoff : nativeFinal);
  await n.session.prompt('CLI retirement');
  assert.deepEqual(n.errors, []);
  assert.equal(n.requests(), 2); assert.equal(n.shuts(), 1);
  assert.equal(readFileSync(join(h.dir, 'native-artifact'), 'utf8'), 'kept');
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retired');
});

test('native retirement waits actual registered background work and its admitted completion turn', nativeOptions, async t => {
  const h = fixture(t), worker = h.boot()[0], n = await nativePi(t, h, worker);
  const tool = n.extension.tools.get('messaged_outcome').definition, execute = tool.execute;
  let job;
  tool.execute = async (...args) => {
    job = (await n.bg('bash_bg', { command: 'exec sleep 30', label: 'isolated drain fixture' })).details;
    return execute(...args);
  };
  n.respond(request => request === 1 ? nativeHandoff : nativeFinal);
  await n.session.prompt('Retire with background work');
  assert.equal((await n.bg('bash_jobs')).details.jobs[0].exit_code, undefined); assert.equal(n.shuts(), 0);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
  const finished = new Promise(resolve => {
    const off = n.session.subscribe(event => { if (event.type === 'agent_settled') { off(); resolve(); } });
  });
  await n.bg('bash_kill', { job_id: job.job_id });
  await finished;
  assert.deepEqual(n.errors, []);
  const completed = (await n.bg('bash_jobs')).details.jobs[0];
  assert.notEqual(completed.exit_code, undefined); // SIGTERM completion may have a null exit code.
  assert.equal(completed.killed, true); assert.equal(n.requests(), 2); assert.equal(n.shuts(), 1);
  assert.equal(n.session.messages.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('SYSTEM (background-jobs): All ')).length, 1);
  assert.equal(h.board.lifecycle.status().workers[0].state, 'retired');
});

test('native interruption after handoff stays retiring; a later clean run may retire', nativeOptions, async t => {
  const h = fixture(t), worker = h.boot()[0], n = await nativePi(t, h, worker);
  let interrupt = true;
  n.extension.handlers.get('turn_end').push((_event, ctx) => { if (interrupt) ctx.abort(); });
  n.respond(() => nativeHandoff);
  await n.session.prompt('Interrupted retirement');
  assert.deepEqual(n.errors, []);
  assert.equal(n.settled[0].interruption.kind, 'cancel');
  assert.equal(n.settled[0].interruption.source, 'extension');
  assert.equal(Object.hasOwn(n.settled[0], 'outcome'), false);
  assert.equal(n.shuts(), 0); assert.equal(h.board.lifecycle.status().workers[0].state, 'retiring');
  interrupt = false; n.respond(() => nativeFinal);
  // Interactive input is intentionally fenced after done; already-started background results may resume.
  await n.session.sendUserMessage('SYSTEM (background-jobs): All 1 background job(s) in this batch finished.', { deliverAs: 'steer' });
  assert.equal(n.shuts(), 1); assert.equal(h.board.lifecycle.status().workers[0].state, 'retired');
});

test('worker independently refuses native one-at-a-time queues before startup USER mission', async t => {
  const h = fixture(t); tick(h.board, h.config, h.execute);
  const worker = h.board.lifecycle.status().workers[0], f = fakePi(t, h, worker);
  f.pi.getSettings = () => ({ steeringMode: 'one-at-a-time', followUpMode: 'all' });
  await f.handlers.get('session_start')({}, f.ctx);
  assert.deepEqual(f.handlers.get('input')({ source: 'interactive', text: bootMission(h.settings) }, f.ctx), { action: 'handled' });
  assert.equal(h.board.lifecycle.status().workers[0].state, 'launch-failed');
  assert.equal(f.messages.length, 0);
  assert.equal(f.shuts(), 1, 'startup refusal requests orderly shutdown, never a model turn');
});

test('real operator CLI preflight/start/status/stop/resume uses fake Pi/tmux only', t => {
  const h = fixture(t), bin = join(h.dir, 'fake-bin'), log = join(h.dir, 'fake.log'), runDir = join(h.dir, 'new-run');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pi'), `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['pi', ...process.argv.slice(2)]) + '\\n'); console.log('openai-codex-test gpt-6.1-sol fixture');\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'tmux'), `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['tmux', ...process.argv.slice(2)]) + '\\n'); if (process.argv[2] === 'has-session') process.exitCode = 1; if (process.argv[2] === 'new-session') console.log('%1'); if (process.argv[2] === 'display-message') console.log('$0');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, PI_CODING_AGENT_DIR: h.settings.agentDir };
  const run = (...args) => spawnSync(resolve('bin/bf2-swarm'), args, { env, encoding: 'utf8' });
  const start = ['start', '--cwd', h.settings.cwd, '--root', root, '--instructions', instructions, '--provider', h.settings.provider, '--run-dir', runDir];
  assert.equal(run('start', '--cwd', 'relative', '--run-dir', runDir).status, 1);
  assert.equal(existsSync(runDir), false); assert.equal(existsSync(log), false);
  const result = run(...start); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Controller: tmux attach.*\nExperiment node:/);
  assert.equal(run(...start).status, 1, 'start never adopts an existing namespace');
  assert.equal(JSON.parse(run('status', '--run-dir', runDir).stdout).status, 'running');
  assert.equal(run('stop', '--run-dir', runDir).status, 0);
  assert.equal(JSON.parse(run('status', '--run-dir', runDir).stdout).status, 'stopped');
  const recovered = openRun(runDir);
  try {
    recovered.board.lifecycle.claimController(process.pid);
    assert.throws(() => recovered.board.lifecycle.claimController(process.pid), /duplicate loop/);
    recovered.board.lifecycle.releaseController(process.pid);
  } finally { recovered.board.close(); }
  assert.equal(run('resume', '--run-dir', runDir).status, 0);
  assert.equal(JSON.parse(run('status', '--run-dir', runDir).stdout).status, 'running');
  const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(commands.filter(a => a[0] === 'pi').every(a => a[1] === '--offline' && a[2] === '--list-models' && a[3] === 'openai-codex-test/gpt-6.1-sol'));
  assert.equal(commands.filter(a => a[0] === 'tmux' && a[1] === 'new-session').length, 3);
  assert.ok(commands.filter(a => a[0] === 'tmux' && a[1] === 'new-session').every(a => a.at(-1).includes('bf2-swarm') && !a.at(-1).includes("'@")));
  assert.equal(existsSync(join(h.settings.cwd, '.pi')), false, 'no repo settings installation');
});

test('launch validation is before new namespace; old-run identities cannot change another DB', t => {
  const h = fixture(t);
  assert.deepEqual(validateLaunch(h.settings, { PI_CODING_AGENT_DIR: h.settings.agentDir }), { ...h.settings, cwd: realpathSync(h.settings.cwd), agentDir: realpathSync(h.settings.agentDir) });
  for (const changes of [{ cwd: 'relative' }, { cwd: join(h.dir, 'missing') }, { root: 'placeholder' }, { instructions: '' }, { provider: 'other' }, { model: 'other' }, { thinking: 'low' }]) {
    assert.throws(() => validateLaunch({ ...h.settings, ...changes }, { PI_CODING_AGENT_DIR: h.settings.agentDir }));
  }
  writeFileSync(join(h.settings.agentDir, 'settings.local.json'), JSON.stringify({ steeringMode: 'one-at-a-time' }));
  assert.equal(settingsFor(h.settings.agentDir, h.settings.cwd).steeringMode, 'one-at-a-time');
  assert.throws(() => validateLaunch(h.settings, { PI_CODING_AGENT_DIR: h.settings.agentDir }), /native/);
  assert.throws(() => tick(h.board, h.config, h.execute), /native/);
  assert.equal(h.board.lifecycle.status().status, 'running', 'bad current launch settings delay retries, not global pause');
  assert.equal(h.calls.length, 0);
  writeFileSync(join(h.settings.agentDir, 'settings.local.json'), JSON.stringify({ extensions: ['/x/optional-extensions/rlm-friendly-stop.ts'] }));
  assert.throws(() => validateLaunch(h.settings, { PI_CODING_AGENT_DIR: h.settings.agentDir }), /friendly-stop/);
  assert.throws(() => openBoard({ ...h.config, run: 'other-run' }), /another run/);
  assert.equal(h.board.lifecycle.status().status, 'running');
  assert.throws(() => openRun(join(h.dir, 'missing')), /ENOENT/);
});
