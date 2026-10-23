import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard } from './board.mjs';
import { PATHFINDER_SLOT, pathfinderMission } from './pathfinder.mjs';

const code = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const checkPath = (path, label) => {
  if (!path || !isAbsolute(path) || /[\0\n\r]/.test(path)) throw new Error(`${label} must be an explicit absolute path`);
  return path;
};
export function settingsFor(agentDir, cwd) {
  let settings = {};
  const extensions = [];
  for (const dir of [agentDir, join(cwd, '.pi')]) {
    for (const name of ['settings.shared.json', 'settings.json', 'settings.local.json']) {
      const path = join(dir, name);
      if (existsSync(path)) {
        const layer = json(path);
        extensions.push(...(layer.extensions ?? [])); // Resource arrays combine in Pi.
        settings = { ...settings, ...layer };
      }
    }
  }
  return { ...settings, extensions };
}
export function validateLaunch(options, env = process.env) {
  const cwd = realpathSync(checkPath(options.cwd ?? env.BF2_REPO, 'BF2 repo cwd'));
  if (!statSync(cwd).isDirectory() || !existsSync(join(cwd, '.git'))) throw new Error('cwd must be an existing BF2 Git checkout; launcher never creates it');
  const agentDir = realpathSync(checkPath(env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'), 'Pi agent dir'));
  const settings = settingsFor(agentDir, cwd);
  if (settings.steeringMode !== 'all' || settings.followUpMode !== 'all') throw new Error('NEW swarm sessions require native steeringMode=all and followUpMode=all in current Pi settings');
  if ((settings.extensions ?? []).some(e => String(e).includes('rlm-friendly-stop') && !String(e).startsWith('-'))) throw new Error('remove global friendly-stop from swarm launch settings; it must not load here');
  for (const key of ['root', 'instructions']) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options[key] ?? '')) throw new Error(`${key} must be a configured tree node UUID`);
  }
  if (!/^openai-codex(?:-[a-z0-9-]+)?$/.test(options.provider ?? '')) throw new Error('--provider must be the explicitly authorized Codex provider (not inferred from a registry)');
  if (options.model !== undefined && options.model !== 'gpt-6.1-sol') throw new Error('this experiment uses gpt-6.1-sol only');
  if (options.thinking !== undefined && options.thinking !== 'high') throw new Error('this experiment uses high thinking only');
  return { cwd, agentDir, root: options.root, instructions: options.instructions,
    provider: options.provider, model: 'gpt-6.1-sol', thinking: 'high', code };
}

// No inherited task contract, old board namespace, or global friendly-stop flags.
export function launchEnvironment(env = process.env) {
  const remove = Object.keys(env).filter(key => /^(BF2_|FACTORY_|PI_SUBAGENT|PI_RLM_)/.test(key) ||
    ['TMUX', 'TMUX_PANE', 'PI_SESSION_FILE', 'PI_SESSION_ID'].includes(key));
  return ['env', ...remove.flatMap(key => ['-u', key])];
}
export function workerCommand(settings, config, pane, mission, env = process.env) {
  const args = [...launchEnvironment(env),
    `PI_CODING_AGENT_DIR=${settings.agentDir}`, `BF2_BOARD_DB=${config.database}`, `BF2_BOARD_RUN=${config.run}`,
    `BF2_BOARD_SESSION=${config.session}`, `BF2_BOARD_SENDER=${config.sender}`, 'BF2_SWARM_WORKER=1',
    ...(settings.floorId ? [`FACTORY_FLOOR=${settings.floorId}`, `FACTORY_ROOT=${settings.floorRoot}`, `FACTORY_DB=${config.database}`, `FACTORY_SESSION=${config.session}`, `FACTORY_SENDER=${config.sender}`] : []),
    `PATH=${join(settings.code, 'bin')}:${env.PATH ?? ''}`, 'pi',
    '--provider', settings.provider, '--model', settings.model, '--thinking', settings.thinking,
    '--session-id', config.session, '--session-dir', settings.sessionDir ?? join(dirname(config.database), 'sessions'), '--name', pane,
    '-e', join(settings.code, 'optional-extensions/bf2-swarm.ts'), '-e', join(settings.code, 'optional-extensions/bf2-board.ts'),
    `@${mission}`];
  return `tmux set-option -w -t "$TMUX_PANE" remain-on-exit on && exec ${args.map(quote).join(' ')}`;
}
export const bootMission = settings => `Use local file reads at /Users/jack/sifttext/nodes/<UUID>/node.md for knowledge nodes and required links; no hosted SiftText tools. Read SiftText Read node 5c2f91e4-9bd5-4b45-bbc4-e69c15c1d14d first. Then read BF2 root ${settings.root}, then experiment instruction node ${settings.instructions}. Follow that node as an equal peer; it owns the work/policy. Do not launch nested workers. Use board -h for the CLI interface, then board read once after those tree reads.\n`;

export function tmux(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
const checked = (execute, args) => {
  const result = execute(args);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `tmux ${args[0]} failed`);
  return result.stdout?.trim();
};
export function openRun(runDir) {
  checkPath(runDir, 'run dir');
  const run = json(join(runDir, 'run.json')).run;
  const database = join(runDir, 'board.sqlite');
  if (!existsSync(database)) throw new Error('run database is missing; refusing to create one during recovery');
  const config = { database, run, session: 'controller', sender: '00000000' };
  return { config, board: openBoard(config) };
}
export const parentSession = config => `bf2-${config.run}`;
export function tick(board, config, execute = tmux, env = process.env, hooks = {}) {
  let state = board.lifecycle.status();
  const parent = state.tmux_parent;
  if (!/^\$\d+$/.test(parent)) throw new Error('controller lacks a native tmux parent ID; recover controller first');
  for (const worker of state.workers.filter(w => !w.cleaned)) {
    // Old name-only registrations cannot safely identify a pane after selection changes.
    if (!/^%\d+$/.test(worker.pane) || !/^\$\d+$/.test(worker.tmux_session)) throw new Error('worker lacks stable tmux IDs; start a fresh run');
    const result = execute(['display-message', '-p', '-t', worker.pane, '#{pane_dead} #{session_id}']);
    if (result.status !== 0) throw new Error(result.stderr?.trim() || 'worker health unavailable; refusing to release capacity');
    const [dead, owner] = result.stdout?.trim().split(' ') ?? [];
    if (owner && owner !== worker.tmux_session) throw new Error('worker pane is outside its owned child; refusing cleanup');
    const sessions = checked(execute, ['list-sessions', '-F', '#{session_id}']).split('\n');
    if (sessions.includes(worker.tmux_session)) {
      const identity = checked(execute, ['show-options', '-qv', '-t', worker.tmux_session, '@bf2_swarm_session']);
      const tag = checked(execute, ['show-options', '-qv', '-t', worker.tmux_session, '@pi_subagent_parent_id']);
      if (identity !== worker.session || tag !== parent) throw new Error('worker child ownership tags changed; refusing cleanup');
      if (dead === '0') continue; // SAFE retirement does not mean Pi has exited.
      if (dead && dead !== '1') throw new Error('unknown worker process state; refusing cleanup');
      board.lifecycle.lost(worker.session);
      const panes = checked(execute, ['list-panes', '-s', '-t', worker.tmux_session, '-F', '#{pane_id}']).split('\n');
      if (panes.includes(worker.pane)) checked(execute, ['kill-pane', '-t', worker.pane]);
      if (checked(execute, ['list-sessions', '-F', '#{session_id}']).split('\n').includes(worker.tmux_session)) {
        // Removing only the exact dead pane preserves even concurrently added user
        // windows. Detach any survivor so it neither stays nested nor consumes capacity.
        checked(execute, ['set-option', '-u', '-t', worker.tmux_session, '@pi_subagent_parent_id']);
        console.error(`BF2 swarm preserved user panes in ${worker.tmux_session}; detached from controller`);
      }
    } else board.lifecycle.lost(worker.session);
    // Release capacity only after the child is removed (or user-owned panes detached).
    board.lifecycle.cleaned(worker.session);
    hooks.cleaned?.(worker);
  }
  state = board.lifecycle.advanceDrain();
  if (state.status !== 'running') return state;
  (hooks.validate ?? validateLaunch)(state.config, { ...env, PI_CODING_AGENT_DIR: state.config.agentDir });
  checked(execute, ['has-session', '-t', parent]);
  if (checked(execute, ['show-options', '-qv', '-t', parent, '@bf2_swarm_run']) !== config.run) throw new Error('parent ownership tag changed; refusing launch');
  const occupied = state.workers.filter(w => !w.cleaned).length;
  const vacancies = state.floor ? state.floor.slots.filter(s => !state.workers.some(w => !w.cleaned && w.slot === s.id)) : Array.from({ length: 3 - occupied }, () => null);
  if (state.floor?.pathfinder) vacancies.push({ id: PATHFINDER_SLOT, ...state.floor.pathfinder });
  for (const slot of vacancies) {
    // SQLite uniqueness checks make collisions a rejected allocation, never reuse.
    const session = randomUUID(), sender = randomBytes(4).toString('hex');
    const pane = `bf2-${config.run}-${sender}`;
    const settings = slot ? { ...state.config, ...slot } : state.config;
    const specialist = slot?.id === PATHFINDER_SLOT;
    const mission = join(settings.runDir ?? dirname(config.database), `${session}.boot.txt`);
    const allocate = () => board.lifecycle.addWorker(session, sender, pane, register => {
      writeFileSync(mission, specialist ? pathfinderMission(state.config) : slot ? `${settings.bootstrap}${settings.role ? `\n${settings.role}\n` : ''}` : bootMission(settings), { flag: 'wx', mode: 0o600 });
      const barrier = `bf2-boot-${session}`;
      const receipt = checked(execute, ['new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-s', pane, '-n', 'peer', '-c', settings.cwd,
        `tmux wait-for ${quote(barrier)} && ${workerCommand(settings, { ...config, session, sender }, pane, mission, env)}`]);
      const [child, paneId] = (receipt ?? '').split(' ');
      if (!/^\$\d+$/.test(child) || !/^%\d+$/.test(paneId)) {
        // Creation succeeded but no safe cleanup handle exists. Hold capacity;
        // never release the boot or duplicate an unidentifiable child on retry.
        throw Object.assign(new Error('tmux launch did not return stable session/pane IDs; inspect gated child'), { ownedChild: true });
      }
      try {
        register({ session: child, pane: paneId });
        checked(execute, ['set-option', '-t', child, '@bf2_swarm_session', session]);
        checked(execute, ['set-option', '-t', child, '@pi_subagent_parent_id', parent]);
        // Capture terminal evidence without redirecting Pi out of ordinary TUI mode.
        try { checked(execute, ['pipe-pane', '-o', '-t', paneId, `cat >> ${quote(join(settings.runDir ?? dirname(config.database), `${session}.pane.log`))}`]); }
        catch (error) { console.error(`BF2 swarm pane capture: ${error.message}`); }
        // Metadata and registration precede Pi startup; stop cannot interleave here.
        checked(execute, ['wait-for', '-S', barrier]);
      } catch (error) {
        try {
          checked(execute, ['kill-pane', '-t', paneId]); // Unreleased boot, never a running Pi.
          if (checked(execute, ['list-sessions', '-F', '#{session_id}']).split('\n').includes(child)) checked(execute, ['set-option', '-u', '-t', child, '@pi_subagent_parent_id']);
        } catch { error.ownedChild = true; }
        throw error;
      }
    }, slot ? { slot: slot.id, launchConfig: settings } : {});
    if (hooks.allocate) hooks.allocate(slot, session, allocate);
    else allocate();
  }
  return board.lifecycle.status();
}

export const HELP = `bf2-swarm — separate opt-in three-peer experiment, no dispatcher
  bf2-swarm start --cwd /durable/BF2/repo --root UUID --instructions UUID --provider PROVIDER [--run-dir /durable/new/run]
  bf2-swarm status --run-dir /durable/run
  bf2-swarm stop --run-dir /durable/run       Deliberate no-respawn; workers wrap up
  bf2-swarm resume --run-dir /durable/run     After old workers drain; clear votes
  bf2-swarm run --run-dir /durable/run        Recover controller in owned parent
  bf2-swarm room --run-dir /durable/run       Reopen the persistent localhost room
  bf2-swarm room-close --run-dir /durable/run Close room service only
  bf2-swarm -h
Start opens Chrome once; --no-open starts service without opening a browser.
Room survives controller stop; room reopens it without starting peers.
Start defaults run dir to ~/.local/state/bf2-swarm/<new UUID>. Cwd may use BF2_REPO.
Uses gpt-6.1-sol/high and your explicit authorized Codex provider. Preflight is
--offline --list-models, never a model call. Requires native all/all settings.
Normal extensions autoload; global optional friendly-stop must not be configured.
Start creates ONE controller session with THREE nested child sessions in tmux-oil.
Run recovers only the controller inside that parent, preserving running/waiting/stop.
Retired/dead child sessions close only after actual process exit; logs are retained.
Waiting drains to the visible controller; stop drains children then exits the parent.
User-added child panes/windows are preserved and detached, never killed.
Status is saved JSON; stopped/waiting may still have draining peers.
No forced worker termination, task contract, reports, tree writes, or PATH install.
Waiting is NOT BF2 success.
`;
function startController(config, settings, execute, env, savedParent, occupied = false) {
  const target = savedParent ?? `=${parentSession(config)}`;
  const probe = execute(['has-session', '-t', target]);
  if (probe.status !== 0 && occupied) throw new Error('owned parent missing with undrained children; refusing a second parent');
  if (probe.status === 0 && (!savedParent || checked(execute, ['show-options', '-qv', '-t', target, '@bf2_swarm_run']) !== config.run)) throw new Error('parent session is not owned by this run; refusing recovery');
  const paneId = probe.status === 0 ? checked(execute, ['show-options', '-v', '-t', target, '@bf2_controller_pane']) : undefined;
  const result = /^%\d+$/.test(paneId) ? execute(['display-message', '-p', '-t', paneId, '#{pane_dead} #{session_id}']) : undefined;
  if (result && result.status !== 0) throw new Error(result.stderr?.trim() || 'controller health unavailable; refusing recovery');
  const health = result?.stdout?.trim() ? result : undefined; // tmux emits empty formats for a vanished %pane.
  if (health?.status === 0 && health.stdout?.trim() === `0 ${savedParent}`) return savedParent;
  if (health?.status === 0 && health.stdout?.trim() !== `1 ${savedParent}`) throw new Error('controller pane is outside its owned parent; refusing recovery');
  // Publish our own handle before the loop starts; never infer it from selection.
  const command = `tmux set-option -w -t "$TMUX_PANE" remain-on-exit on && tmux set-option -t "$TMUX_PANE" @bf2_swarm_run ${quote(config.run)} && tmux set-option -t "$TMUX_PANE" @bf2_controller_pane "$TMUX_PANE" && exec ${[...launchEnvironment(env), `PI_CODING_AGENT_DIR=${settings.agentDir}`, 'BF2_SWARM_CONTROLLER=1',
    ...(settings.floorId ? [`FACTORY_FLOOR=${settings.floorId}`, `FACTORY_ROOT=${settings.floorRoot}`, process.execPath, join(settings.code, 'extensions/dark-factory/floors/supervisor.mjs')] : [join(settings.code, 'bin/bf2-swarm'), 'run', '--run-dir', dirname(config.database)])].map(quote).join(' ')}`;
  let launched;
  if (health?.status === 0) {
    checked(execute, ['respawn-pane', '-t', paneId, '-c', settings.code, command]); // No -k: a live process is never killed.
    launched = paneId;
  } else {
    launched = checked(execute, probe.status === 0 ? ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${target}:`, '-n', 'controller', '-c', settings.code, command] :
      ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', parentSession(config), '-n', 'controller', '-c', settings.code, command]);
  }
  if (!/^%\d+$/.test(launched)) throw new Error('tmux controller launch did not return a stable pane ID');
  const parent = checked(execute, ['display-message', '-p', '-t', launched, '#{session_id}']);
  if (!/^\$\d+$/.test(parent)) throw new Error('controller lacks a native session ID');
  checked(execute, ['set-option', '-t', parent, '@bf2_swarm_run', config.run]);
  checked(execute, ['set-option', '-t', parent, '@bf2_controller_pane', launched]);
  return parent;
}
export function ensureController(board, config, execute = tmux, env = process.env) {
  return board.lifecycle.controllerSetup(parent => {
    const state = board.lifecycle.status();
    return startController(config, state.config, execute, env, parent, state.workers.some(w => !w.cleaned));
  });
}
export async function main(args = process.argv.slice(2), env = process.env, execute = tmux) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'no-open': { type: 'boolean' }, 'run-dir': { type: 'string' }, cwd: { type: 'string' },
    root: { type: 'string' }, instructions: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['start', 'status', 'stop', 'resume', 'run', 'room', 'room-close'].includes(command)) throw new Error('expected start/status/stop/resume; use bf2-swarm -h');
  if (command !== 'start' && Object.keys(values).some(k => !['run-dir', 'help', ...(command === 'room' ? ['no-open'] : [])].includes(k))) throw new Error('launch options require start');
  let runDir = values['run-dir'];
  if (command === 'start') {
    const settings = validateLaunch(values, env);
    runDir ??= join(homedir(), '.local/state/bf2-swarm', randomUUID());
    checkPath(runDir, 'run dir');
    const route = spawnSync('pi', ['--offline', '--list-models', `${settings.provider}/${settings.model}`], { env: { ...env, PI_CODING_AGENT_DIR: settings.agentDir }, encoding: 'utf8' });
    if (route.error || route.status !== 0 || !route.stdout.split('\n').some(line => line.trim().split(/\s+/).slice(0, 2).join('/') === `${settings.provider}/${settings.model}`)) throw new Error('authorized provider/model is unavailable in Pi preflight');
    mkdirSync(dirname(runDir), { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { mode: 0o700 }); // Existing namespace is never adopted by start.
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: randomUUID() }) + '\n', { flag: 'wx', mode: 0o600 });
    mkdirSync(join(runDir, 'sessions'), { mode: 0o700 });
    const config = { database: join(runDir, 'board.sqlite'), run: json(join(runDir, 'run.json')).run, session: 'controller', sender: '00000000' };
    const board = openBoard(config);
    try {
      board.lifecycle.initialize(settings);
      const pane = board.lifecycle.controllerSetup(parent => startController(config, settings, execute, env, parent));
      console.log(`Run ${runDir}\nController: tmux attach -t ${pane}\nExperiment node: ${settings.instructions}`);
    } finally { board.close(); }
    const { ensureRoom } = await import('./room.mjs');
    await ensureRoom(runDir, !values['no-open']);
    return;
  }
  if (command === 'room' || command === 'room-close') {
    const { ensureRoom, closeRoom } = await import('./room.mjs');
    if (command === 'room') await ensureRoom(runDir, !values['no-open']);
    else await closeRoom(runDir);
    return;
  }
  const { config, board } = openRun(runDir);
  try {
    const controller = () => ensureController(board, config, execute, env);
    if (command === 'status') { console.log(JSON.stringify(board.lifecycle.status(), null, 2)); return; }
    if (command === 'stop') {
      board.lifecycle.stop();
      controller();
      console.log('stop requested; no replacements; workers finish safely; stopped only after actual cleanup'); return;
    }
    if (command === 'resume') {
      const settings = board.lifecycle.status().config;
      validateLaunch(settings, { ...env, PI_CODING_AGENT_DIR: settings.agentDir });
      board.lifecycle.resume();
      console.log(`running; controller ${controller()}`); return;
    }
    if (env.BF2_SWARM_CONTROLLER !== '1') {
      console.log(`controller ${controller()}`); return;
    }
    // One controller per run; an atomic DB claim refuses PID reuse, never kills.
    board.lifecycle.claimController(process.pid);
    let timer, previous, finish;
    const inspect = () => {
      try {
        const state = tick(board, config, execute, env);
        const text = `${state.status}: experiment node ${state.config.instructions}; ` + state.workers.filter(w => !w.cleaned).map(w => `${w.sender}=${w.state}`).join(', ');
        if (text !== previous) { console.log(text); previous = text; }
        if (state.status === 'stopped' && state.workers.every(w => w.cleaned)) {
          const paneId = checked(execute, ['show-options', '-v', '-t', state.tmux_parent, '@bf2_controller_pane']);
          // Natural controller exit removes its last window, not any inspection shell.
          if (checked(execute, ['display-message', '-p', '-t', paneId, '#{session_id}']) !== state.tmux_parent) throw new Error('controller pane moved outside owned parent; refusing stop cleanup');
          checked(execute, ['set-option', '-w', '-t', paneId, 'remain-on-exit', 'off']);
          finish();
        }
      } catch (error) { console.error(`BF2 swarm controller: ${error.message}; retrying after ordinary delay`); }
    };
    await new Promise(resolveStop => {
      const stop = () => { clearInterval(timer); board.lifecycle.releaseController(process.pid); process.off('SIGTERM', stop); process.off('SIGINT', stop); resolveStop(); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      finish = stop;
      timer = setInterval(inspect, 2000); inspect();
    });
  } finally { board.close(); }
}
