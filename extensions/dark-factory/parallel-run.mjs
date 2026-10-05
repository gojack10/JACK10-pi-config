#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildConfig, isNodeId, parseRunNode, running } from './parallel-core.mjs';
import { save } from './parallel-controller.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = join(homedir(), '.pi/agent');
const root = join(home, 'factory-runs', 'parallel');
const SIFTTEXT = join(homedir(), '.local/bin/sifttext');
const [command, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const quote = x => `'${x.replaceAll("'", "'\\''")}'`;
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
const lines = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
  catch { return []; }
};
const usage = 'Usage: node parallel-run.mjs <start-parallel --run <RUN node> [--config overrides.json] | status | wake [--note text] | stop [--now] | resume> [--run <RUN node>]';

function runDirectory() {
  const run = flag('--run');
  if (run && !isNodeId(run)) throw Error('--run must be a RUN node UUID');
  const pointer = run ? join(root, `${run}.LAST`) : join(root, 'LAST');
  if (!existsSync(pointer)) throw Error(`No parallel run found${run ? ` for ${run}` : ''}.`);
  return readFileSync(pointer, 'utf8').trim();
}
function controllerAlive(directory) {
  const controller = readJson(join(directory, 'controller.json'));
  if (!controller?.pid) return false;
  try { process.kill(controller.pid, 0); } catch { return false; }
  return lines('ps', ['-o', 'command=', '-p', String(controller.pid)]).some(line => line.includes('parallel-run.mjs controller') && line.includes(directory));
}
const lockPath = config => join(root, `${config.run_node}.LOCK`);
function takeLock(config, directory) {
  const lock = lockPath(config);
  try { mkdirSync(lock); }
  catch {
    const holder = readFileSync(join(lock, 'run'), 'utf8').trim();
    if (controllerAlive(holder)) throw Error(`RUN ${config.run_node} already has a live controller: ${holder}`);
  }
  writeFileSync(join(lock, 'run'), directory + '\n');
}
function releaseLock(config, directory) {
  const lock = lockPath(config);
  if (existsSync(join(lock, 'run')) && readFileSync(join(lock, 'run'), 'utf8').trim() === directory) {
    unlinkSync(join(lock, 'run')); rmdirSync(lock);
  }
}
function launchController(directory, config) {
  const label = `pf-${config.run_node.slice(0, 8)}-ctl-${Date.now().toString(36)}`;
  const clean = ['env', '-u', 'PI_SUBAGENT_MANIFEST', '-u', 'SIFTWORKS_SEAT', '-u', 'PI_RLM_FRIENDLY_STOP_TOKENS', '-u', 'PI_RLM_FRIENDLY_STOP_MODEL',
    '-u', 'PI_RLM_FRIENDLY_STOP_PERCENT', '-u', 'PI_RLM_ROLLOVER_DIR'];
  const boot = [...clean, process.execPath, fileURLToPath(import.meta.url), 'controller', directory].map(quote).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-s', label, '-c', home, `${boot} >> ${quote(join(directory, 'controller.log'))} 2>&1`]);
  return label;
}
function fenceHeads(repos) {
  const heads = {};
  for (const repo of repos) {
    const porcelain = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    if (porcelain.trim()) throw Error(`read-only repository is not clean; refusing to start: ${repo}\n${porcelain}`);
    heads[repo] = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  return heads;
}
function summary(directory) {
  const config = readJson(join(directory, 'config.json'));
  const state = readJson(join(directory, 'state.json'));
  const sessions = lines('tmux', ['list-sessions', '-F', '#{session_name}']).filter(name => name.startsWith(`pf-${config.run_node.slice(0, 8)}-`));
  if (!state) return { directory, run_node: config.run_node, controller_alive: controllerAlive(directory), status: 'not_started', sessions };
  const now = Date.now();
  const count = status => Object.values(state.tasks).filter(task => task.status === status).length;
  return {
    directory, run_node: config.run_node, owner: config.owner,
    status: state.status, controller_alive: controllerAlive(directory), attention: state.attention ?? undefined,
    dispatcher: { configured_engine: config.dispatcher.engine ?? 'claude', route: config.dispatcher.fallback,
      running: state.dispatcher.attempt ? state.attempts[state.dispatcher.attempt].engine : null, wakes: state.dispatcher.wakes,
      last: state.dispatcher.last, claude_resting_until: state.dispatcher.claude_resting_until && new Date(state.dispatcher.claude_resting_until).toISOString() },
    pending_events: state.pending_events.map(event => event.type),
    seats: Object.fromEntries(config.seats.map(seat => {
      const entry = state.seats[seat.id];
      const attempt = entry.attempt && state.attempts[entry.attempt];
      return [seat.id, { route: `${seat.route.provider}/${seat.route.model}:${seat.route.thinking}`,
        task: attempt?.task ?? null, session: attempt?.receipt?.session_label ?? null,
        resting_until: entry.resting_until && entry.resting_until > now ? new Date(entry.resting_until).toISOString() : null }];
    })),
    tasks: Object.fromEntries(['queued', 'running', 'worked', 'blocked', 'errored', 'needs_split', 'stopped'].map(status => [status, count(status)])),
    in_flight: running(state).map(attempt => ({ attempt: attempt.id, kind: attempt.kind, engine: attempt.engine, seat: attempt.seat, task: attempt.task })),
    sessions,
    history: join(directory, 'history.jsonl'),
  };
}
const inbox = (directory, value) => {
  mkdirSync(join(directory, 'inbox'), { recursive: true });
  save(join(directory, 'inbox', `${Date.now()}-${randomUUID().slice(0, 8)}.json`), value);
};
function resume(directory) {
  const config = readJson(join(directory, 'config.json'));
  if (controllerAlive(directory)) throw Error(`Controller already running for ${directory}`);
  takeLock(config, directory);
  for (const name of ['finished.json', 'controller.json']) if (existsSync(join(directory, name))) unlinkSync(join(directory, name));
  try { return launchController(directory, config); }
  catch (error) { releaseLock(config, directory); throw error; }
}

if (command === 'controller') {
  const directory = resolve(rest[0]);
  const config = readJson(join(directory, 'config.json'));
  const caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  const session = lines('tmux', ['display-message', '-p', '#S'])[0];
  save(join(directory, 'controller.json'), { pid: process.pid, session, started_at: new Date().toISOString() });
  let agent;
  try {
    const sdk = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/index.js')).href);
    // Register custom providers for launch-route validation. The controller session makes no model requests.
    const services = await sdk.createAgentSessionServices({ cwd: home, agentDir: home,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [join(here, '../codex-workspaces.ts'), join(here, 'parallel-host.ts')] } });
    const errors = [...services.resourceLoader.getExtensions().errors, ...services.diagnostics.filter(d => d.type === 'error')];
    if (errors.length) throw Error(JSON.stringify(errors));
    const route = config.dispatcher.fallback;
    const model = services.modelRuntime.getModel(route.provider, route.model);
    if (!model) throw Error(`controller host route unavailable: ${JSON.stringify(route)}`);
    ({ session: agent } = await sdk.createAgentSession({ cwd: home, agentDir: home, resourceLoader: services.resourceLoader,
      modelRuntime: services.modelRuntime, model, thinkingLevel: route.thinking, noTools: true }));
    await agent.bindExtensions({ mode: 'print' });
    await agent.prompt(`/factory-parallel ${directory}`);
    console.log(JSON.stringify({ event: 'controller_exit', directory, finished: readJson(join(directory, 'finished.json')) }));
  } catch (error) {
    console.error(error);
    save(join(directory, 'finished.json'), { ok: false, error: String(error), at: new Date().toISOString() });
    process.exitCode = 1;
  } finally {
    agent?.dispose();
    caffeinate.kill();
    releaseLock(config, directory);
  }
} else if (command === 'start-parallel') {
  const runNode = flag('--run');
  if (!isNodeId(runNode)) throw Error('start-parallel requires --run <RUN node UUID>');
  const overrides = flag('--config') ? JSON.parse(readFileSync(resolve(flag('--config')), 'utf8')) : {};
  const nodeText = execFileSync(SIFTTEXT, ['get_node', `node_id=${runNode}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const parsed = parseRunNode(nodeText);
  const owner = overrides.owner ?? parsed.owner;
  if (!isNodeId(owner)) throw Error('RUN node names no OWNER line of the form "OWNER: [[Name|uuid]]"');
  const repos = (overrides.readonly_repos ?? parsed.repos).map(path => resolve(path.replace(/^~(?=\/|$)/, homedir())));
  const heads = fenceHeads(repos);
  mkdirSync(root, { recursive: true });
  const directory = join(root, `${new Date().toISOString().replaceAll(':', '-')}-${runNode.slice(0, 8)}`);
  const config = { ...buildConfig({ runNode, owner, repos, directory, cwd: homedir(), overrides }), fence_heads: heads };
  takeLock(config, directory);
  try {
    mkdirSync(directory, { mode: 0o700 });
    save(join(directory, 'config.json'), config);
    writeFileSync(join(root, `${runNode}.LAST`), directory + '\n');
    writeFileSync(join(root, 'LAST'), directory + '\n');
    const session = launchController(directory, config);
    console.log(JSON.stringify({ directory, controller_session: session, owner, readonly_repos: heads, seats: config.seats,
      dispatcher: config.dispatcher, faults: config.faults,
      status: `node ${fileURLToPath(import.meta.url)} status --run ${runNode}` }, null, 2));
  } catch (error) { releaseLock(config, directory); throw error; }
} else if (command === 'status') {
  console.log(JSON.stringify(summary(runDirectory()), null, 2));
} else if (command === 'wake') {
  const directory = runDirectory();
  inbox(directory, { type: 'wake', note: flag('--note') ?? 'factory wake' });
  const session = controllerAlive(directory) ? undefined : resume(directory);
  console.log(JSON.stringify({ directory, woke: true, resumed_controller: session ?? null }));
} else if (command === 'stop') {
  const directory = runDirectory();
  if (!controllerAlive(directory)) console.log(JSON.stringify({ directory, stopped: true, note: 'no live controller' }));
  else {
    inbox(directory, { type: 'stop', now: rest.includes('--now') });
    console.log(JSON.stringify({ directory, stop_requested: true, now: rest.includes('--now') }));
  }
} else if (command === 'resume') {
  const directory = runDirectory();
  console.log(JSON.stringify({ directory, controller_session: resume(directory) }));
} else {
  console.log(usage);
  process.exitCode = 2;
}
