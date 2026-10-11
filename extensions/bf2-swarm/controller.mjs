import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard } from './board.mjs';

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
  const remove = Object.keys(env).filter(key => /^(BF2_|PI_SUBAGENT|PI_RLM_)/.test(key) ||
    ['TMUX', 'TMUX_PANE', 'PI_SESSION_FILE', 'PI_SESSION_ID'].includes(key));
  return ['env', ...remove.flatMap(key => ['-u', key])];
}
export function workerCommand(settings, config, pane, mission, env = process.env) {
  const args = [...launchEnvironment(env),
    `PI_CODING_AGENT_DIR=${settings.agentDir}`, `BF2_BOARD_DB=${config.database}`, `BF2_BOARD_RUN=${config.run}`,
    `BF2_BOARD_SESSION=${config.session}`, `BF2_BOARD_SENDER=${config.sender}`, 'BF2_SWARM_WORKER=1',
    `PATH=${join(settings.code, 'bin')}:${env.PATH ?? ''}`, 'pi',
    '--provider', settings.provider, '--model', settings.model, '--thinking', settings.thinking,
    '--session-id', config.session, '--session-dir', join(dirname(config.database), 'sessions'), '--name', pane,
    '-e', join(settings.code, 'optional-extensions/bf2-swarm.ts'), '-e', join(settings.code, 'optional-extensions/bf2-board.ts'),
    `@${mission}`];
  return `tmux set-option -w -t "$TMUX_PANE" remain-on-exit on && exec ${args.map(quote).join(' ')}`;
}
export const bootMission = settings => `Read SiftText Read node 5c2f91e4-9bd5-4b45-bbc4-e69c15c1d14d first. Then read BF2 root ${settings.root}, then experiment instruction node ${settings.instructions}. Follow that node as an equal peer; it owns the work/policy. Do not launch nested workers. Use board -h for the CLI interface, then board read once after those tree reads.\n`;

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
export function tick(board, config, execute = tmux, env = process.env) {
  const parent = parentSession(config);
  let state = board.lifecycle.status();
  for (const worker of state.workers.filter(w => !w.cleaned)) {
    // Old name-only registrations cannot safely identify a pane after selection changes.
    if (!/^%\d+$/.test(worker.pane)) throw new Error('worker lacks a stable tmux pane ID; start a fresh run');
    const result = execute(['display-message', '-p', '-t', worker.pane, '#{pane_dead} #{session_name}']);
    if (result.status !== 0) throw new Error(result.stderr?.trim() || 'worker health unavailable; refusing to release capacity');
    if (result.stdout?.trim()) {
      const [dead, owner] = result.stdout.trim().split(' ');
      if (owner !== parent) throw new Error('worker pane is outside its owned parent; refusing cleanup');
      if (dead === '0') continue; // Even a SAFE retired marker does not mean Pi has exited.
      if (dead !== '1') throw new Error('unknown worker process state; refusing cleanup');
      board.lifecycle.lost(worker.session);
      checked(execute, ['kill-pane', '-t', worker.pane]);
    } else board.lifecycle.lost(worker.session);
    // Capacity is released only after the owned pane is gone, including unexpected exits.
    board.lifecycle.cleaned(worker.session);
  }
  state = board.lifecycle.status();
  if (state.status !== 'running') return state;
  validateLaunch(state.config, { ...env, PI_CODING_AGENT_DIR: state.config.agentDir });
  checked(execute, ['has-session', '-t', `=${parent}`]);
  const occupied = state.workers.filter(w => !w.cleaned).length;
  for (let i = occupied; i < 3; i++) {
    // SQLite uniqueness checks make collisions a rejected allocation, never reuse.
    const session = randomUUID(), sender = randomBytes(4).toString('hex');
    const pane = `bf2-${config.run}-${sender}`;
    const mission = join(dirname(config.database), `${session}.boot.txt`);
    writeFileSync(mission, bootMission(state.config), { flag: 'wx', mode: 0o600 });
    board.lifecycle.addWorker(session, sender, pane, () => {
      const paneId = checked(execute, ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `=${parent}:`, '-n', pane, '-c', state.config.cwd,
        workerCommand(state.config, { ...config, session, sender }, pane, mission, env)]);
      if (!/^%\d+$/.test(paneId)) throw new Error('tmux launch did not return a stable pane ID');
      // Capture terminal evidence without redirecting Pi out of ordinary TUI mode.
      // Failure is diagnostic only: the already-launched worker remains registered.
      try { checked(execute, ['pipe-pane', '-o', '-t', paneId, `cat >> ${quote(join(dirname(config.database), `${session}.pane.log`))}`]); }
      catch (error) { console.error(`BF2 swarm pane capture: ${error.message}`); }
      return paneId;
    });
  }
  return board.lifecycle.status();
}

export const HELP = `bf2-swarm — separate opt-in three-peer experiment, no dispatcher
  bf2-swarm start --cwd /durable/BF2/repo --root UUID --instructions UUID --provider PROVIDER [--run-dir /durable/new/run]
  bf2-swarm status --run-dir /durable/run
  bf2-swarm stop --run-dir /durable/run       Deliberate no-respawn; workers wrap up
  bf2-swarm resume --run-dir /durable/run     After old workers drain; clear votes
  bf2-swarm run --run-dir /durable/run        Recover controller in owned parent
  bf2-swarm -h
Start defaults run dir to ~/.local/state/bf2-swarm/<new UUID>. Cwd may use BF2_REPO.
Uses gpt-6.1-sol/high and your explicit authorized Codex provider. Preflight is
--offline --list-models, never a model call. Requires native all/all settings.
Normal extensions autoload; global optional friendly-stop must not be configured.
Start creates ONE named tmux parent with controller and three worker windows.
Run recovers only the controller inside that parent, preserving running/waiting/stop.
Retired/dead worker panes close only after actual process exit; logs are retained.
Waiting leaves a controller/status window; stop drains workers then exits the parent.
No forced worker termination, task contract, reports, tree writes, or PATH install.
Waiting is NOT BF2 success.
`;
function startController(config, settings, execute, env) {
  const parent = parentSession(config), target = `=${parent}`;
  const probe = execute(['has-session', '-t', target]);
  const paneId = probe.status === 0 ? execute(['show-options', '-v', '-t', parent, '@bf2_controller_pane']).stdout?.trim() : undefined;
  const result = /^%\d+$/.test(paneId) ? execute(['display-message', '-p', '-t', paneId, '#{pane_dead} #{session_name}']) : undefined;
  if (result && result.status !== 0) throw new Error(result.stderr?.trim() || 'controller health unavailable; refusing recovery');
  const health = result?.stdout?.trim() ? result : undefined; // tmux emits empty formats for a vanished %pane.
  if (health?.status === 0 && health.stdout?.trim() === `0 ${parent}`) return parent;
  if (health?.status === 0 && health.stdout?.trim() !== `1 ${parent}`) throw new Error('controller pane is outside its owned parent; refusing recovery');
  // Publish our own handle before the loop starts; never infer it from selection.
  const command = `tmux set-option -w -t "$TMUX_PANE" remain-on-exit on && tmux set-option -t ${quote(parent)} @bf2_controller_pane "$TMUX_PANE" && exec ${[...launchEnvironment(env), `PI_CODING_AGENT_DIR=${settings.agentDir}`, 'BF2_SWARM_CONTROLLER=1',
    join(settings.code, 'bin/bf2-swarm'), 'run', '--run-dir', dirname(config.database)].map(quote).join(' ')}`;
  let launched;
  if (health?.status === 0) {
    checked(execute, ['respawn-pane', '-t', paneId, '-c', settings.code, command]); // No -k: a live process is never killed.
    launched = paneId;
  } else {
    launched = checked(execute, probe.status === 0 ? ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${target}:`, '-n', 'controller', '-c', settings.code, command] :
      ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', parent, '-n', 'controller', '-c', settings.code, command]);
  }
  if (!/^%\d+$/.test(launched)) throw new Error('tmux controller launch did not return a stable pane ID');
  checked(execute, ['set-option', '-t', parent, '@bf2_controller_pane', launched]);
  return parent;
}
export async function main(args = process.argv.slice(2), env = process.env, execute = tmux) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'run-dir': { type: 'string' }, cwd: { type: 'string' },
    root: { type: 'string' }, instructions: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['start', 'status', 'stop', 'resume', 'run'].includes(command)) throw new Error('expected start/status/stop/resume; use bf2-swarm -h');
  if (command !== 'start' && Object.keys(values).some(k => !['run-dir', 'help'].includes(k))) throw new Error('launch options require start');
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
      const pane = board.lifecycle.controllerSetup(() => startController(config, settings, execute, env));
      console.log(`Run ${runDir}\nController: tmux attach -t ${pane}\nExperiment node: ${settings.instructions}`);
    } finally { board.close(); }
    return;
  }
  const { config, board } = openRun(runDir);
  try {
    const controller = () => board.lifecycle.controllerSetup(() => startController(config, board.lifecycle.status().config, execute, env));
    if (command === 'status') { console.log(JSON.stringify(board.lifecycle.status(), null, 2)); return; }
    if (command === 'stop') {
      board.lifecycle.stop();
      controller();
      console.log('stopped; no replacements; workers finish safely; parent exits after drain'); return;
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
          const paneId = checked(execute, ['show-options', '-v', '-t', parentSession(config), '@bf2_controller_pane']);
          // Natural controller exit removes its last window, not any inspection shell.
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
