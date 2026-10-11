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
  return `tmux set-option -w -t ${quote(`${pane}:0`)} remain-on-exit on; exec ${args.map(quote).join(' ')}`;
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
export function tick(board, config, execute = tmux, env = process.env) {
  let state = board.lifecycle.status();
  for (const worker of state.workers.filter(w => ['launching', 'active', 'retiring'].includes(w.state))) {
    const result = execute(['display-message', '-p', '-t', `${worker.pane}:0.0`, '#{pane_dead}']);
    if (result.status !== 0 || result.stdout.trim() === '1') board.lifecycle.lost(worker.session);
  }
  state = board.lifecycle.status();
  if (state.status !== 'running') return state;
  validateLaunch(state.config, { ...env, PI_CODING_AGENT_DIR: state.config.agentDir });
  const occupied = state.workers.filter(w => ['launching', 'active', 'retiring'].includes(w.state)).length;
  for (let i = occupied; i < 3; i++) {
    // SQLite uniqueness checks make collisions a rejected allocation, never reuse.
    const session = randomUUID(), sender = randomBytes(4).toString('hex');
    const pane = `bf2-${config.run}-${sender}`;
    const mission = join(dirname(config.database), `${session}.boot.txt`);
    writeFileSync(mission, bootMission(state.config), { flag: 'wx', mode: 0o600 });
    board.lifecycle.addWorker(session, sender, pane, () => {
      checked(execute, ['new-session', '-d', '-s', pane, '-c', state.config.cwd,
        workerCommand(state.config, { ...config, session, sender }, pane, mission, env)]);
      // Capture terminal evidence without redirecting Pi out of ordinary TUI mode.
      // Failure is diagnostic only: the already-launched worker remains registered.
      try { checked(execute, ['pipe-pane', '-o', '-t', `${pane}:0.0`, `cat >> ${quote(join(dirname(config.database), `${session}.pane.log`))}`]); }
      catch (error) { console.error(`BF2 swarm pane capture: ${error.message}`); }
    });
  }
  return board.lifecycle.status();
}

export const HELP = `bf2-swarm — separate opt-in three-peer experiment, no dispatcher
  bf2-swarm start --cwd /durable/BF2/repo --root UUID --instructions UUID --provider PROVIDER [--run-dir /durable/new/run]
  bf2-swarm status --run-dir /durable/run
  bf2-swarm stop --run-dir /durable/run       Deliberate no-respawn; workers wrap up
  bf2-swarm resume --run-dir /durable/run     After old workers drain; clear votes
  bf2-swarm run --run-dir /durable/run        Foreground recovery controller
  bf2-swarm -h
Start defaults run dir to ~/.local/state/bf2-swarm/<new UUID>. Cwd may use BF2_REPO.
Uses gpt-6.1-sol/high and your explicit authorized Codex provider. Preflight is
--offline --list-models, never a model call. Requires native all/all settings.
Normal extensions autoload; global optional friendly-stop must not be configured.
Start/resume launches named tmux controller; inspect its waiting/stopped state and
configured experiment node there or with status. Waiting is NOT BF2 success.
No forced termination, cleanup, task contract, reports, tree writes, or PATH install.
`;
function startController(config, settings, execute, env) {
  const pane = `bf2-${config.run}-controller`;
  const probe = execute(['has-session', '-t', pane]);
  const alive = probe.status === 0 && execute(['display-message', '-p', '-t', pane, '#{pane_dead}']).stdout?.trim() === '0';
  if (alive) return pane;
  const command = `exec ${[...launchEnvironment(env), `PI_CODING_AGENT_DIR=${settings.agentDir}`,
    join(settings.code, 'bin/bf2-swarm'), 'run', '--run-dir', dirname(config.database)].map(quote).join(' ')}`;
  checked(execute, probe.status === 0 ? ['new-window', '-t', pane, '-n', 'recovery', '-c', settings.code, command] :
    ['new-session', '-d', '-s', pane, '-c', settings.code, command]);
  return pane;
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
      const pane = startController(config, settings, execute, env);
      console.log(`Run ${runDir}\nController: tmux attach -t ${pane}\nExperiment node: ${settings.instructions}`);
    } finally { board.close(); }
    return;
  }
  const { config, board } = openRun(runDir);
  try {
    if (command === 'status') { console.log(JSON.stringify(board.lifecycle.status(), null, 2)); return; }
    if (command === 'stop') { board.lifecycle.stop(); console.log('stopped; no replacements; workers finish safely'); return; }
    if (command === 'resume') {
      const settings = board.lifecycle.status().config;
      validateLaunch(settings, { ...env, PI_CODING_AGENT_DIR: settings.agentDir });
      board.lifecycle.resume();
      console.log(`running; controller ${startController(config, board.lifecycle.status().config, execute, env)}`); return;
    }
    // One controller per run; an atomic DB claim refuses PID reuse, never kills.
    board.lifecycle.claimController(process.pid);
    let timer, previous;
    const inspect = () => {
      try {
        const state = tick(board, config, execute, env);
        const text = `${state.status}: experiment node ${state.config.instructions}; ` + state.workers.filter(w => ['active', 'launching', 'retiring'].includes(w.state)).map(w => `${w.sender}=${w.state}`).join(', ');
        if (text !== previous) { console.log(text); previous = text; }
      } catch (error) { console.error(`BF2 swarm controller: ${error.message}; retrying after ordinary delay`); }
    };
    await new Promise(resolveStop => {
      const stop = () => { clearInterval(timer); board.lifecycle.releaseController(process.pid); process.off('SIGTERM', stop); process.off('SIGINT', stop); resolveStop(); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      inspect(); timer = setInterval(inspect, 2000);
    });
  } finally { board.close(); }
}
