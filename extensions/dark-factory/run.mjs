#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { factoryActivity, save, ROUTE } from './core.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const home = join(homedir(), '.pi/agent');
const runs = join(home, 'factory-runs');
const lock = join(runs, 'LOCK');
const [command, argument] = process.argv.slice(2);
const quote = x => `'${x.replaceAll("'", "'\\''")}'`;
const lines = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
  catch { return []; }
};
const activity = directory => factoryActivity(
  lines('tmux', ['list-sessions', '-F', '#{session_name}']),
  lines('ps', ['-axo', 'command=']),
  directory,
);
const releaseQuiescent = (directory, reason) => {
  const found = activity(directory);
  if (found.controller || found.sessions.length) return found;
  const active = existsSync(join(directory, 'active.json'))
    ? JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8')) : undefined;
  save(join(directory, 'interrupted.json'), {
    reason,
    orphan_report: !!active && existsSync(join(directory, `${active.step}-${active.role}.json`)),
    note: 'An orphan report has no durable successful outcome receipt and is not credited as a completed attempt.',
  });
  writeFileSync(join(directory, 'QUIESCENT'), 'No active factory controller or worker remains; stale lock recovered.\n');
  if (existsSync(join(lock, 'run')) && readFileSync(join(lock, 'run'), 'utf8').trim() === directory) {
    unlinkSync(join(lock, 'run')); rmdirSync(lock);
  }
  return found;
};

if (command === 'controller') {
  const directory = resolve(argument);
  const caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  let session;
  let entered = false;
  try {
    const sdk = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/index.js')).href);
    const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir: home, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(here, 'host.ts')] });
    await loader.reload();
    const errors = loader.getExtensions().errors;
    if (errors.length) throw Error(JSON.stringify(errors));
    const runtime = await sdk.ModelRuntime.create();
    const model = runtime.getModel(ROUTE.provider, ROUTE.model);
    if (!model) throw Error('required Qwen route unavailable');
    ({ session } = await sdk.createAgentSession({ cwd: home, agentDir: home, resourceLoader: loader,
      modelRuntime: runtime, model, thinkingLevel: ROUTE.thinking, noTools: true }));
    await session.bindExtensions({ mode: 'print' });
    entered = true;
    await session.prompt(`/factory-run ${directory}`);
    if (!existsSync(join(directory, 'QUIESCENT')) || existsSync(join(directory, 'error.json'))) throw Error('factory did not finish cleanly; inspect error.json/active.json');
    save(join(directory, 'finished.json'), { ok: true });
  } catch (error) {
    console.error(error);
    save(join(directory, 'finished.json'), { ok: false, error: String(error) });
    process.exitCode = 1;
  } finally {
    session?.dispose();
    caffeinate.kill();
    if ((!entered || existsSync(join(directory, 'QUIESCENT'))) && readFileSync(join(lock, 'run'), 'utf8').trim() === directory) {
      unlinkSync(join(lock, 'run')); rmdirSync(lock);
    }
  }
} else if (command === 'smoke' || command === 'start') {
  mkdirSync(runs, { recursive: true });
  try { mkdirSync(lock); } catch { throw Error(`Factory locked. Inspect ${join(lock, 'run')}; never remove while its worker may still run.`); }
  const directory = join(runs, new Date().toISOString().replaceAll(':', '-') + (command === 'smoke' ? '-smoke' : '-bf2'));
  mkdirSync(directory);
  writeFileSync(join(lock, 'run'), directory + '\n');
  writeFileSync(join(runs, 'LAST'), directory + '\n');
  save(join(directory, 'config.json'), { smoke: command === 'smoke', cwd: homedir(),
    contract: readFileSync(join(here, 'bf2-contract.md'), 'utf8') });
  writeFileSync(join(directory, 'fixture.txt'), 'FACTORY_READ_ONLY_OK\n');
  const label = `bf2-factory-${Date.now()}`;
  const clean = ['env', '-u', 'PI_SUBAGENT_MANIFEST', '-u', 'PI_RLM_FRIENDLY_STOP_TOKENS', '-u', 'PI_RLM_FRIENDLY_STOP_MODEL', '-u', 'PI_RLM_FRIENDLY_STOP_PERCENT', '-u', 'PI_RLM_ROLLOVER_DIR'];
  const boot = [...clean, process.execPath, fileURLToPath(import.meta.url), 'controller', directory].map(quote).join(' ');
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', label, '-c', home, `${boot} > ${quote(join(directory, 'controller.log'))} 2>&1`]);
  } catch (error) {
    unlinkSync(join(lock, 'run')); rmdirSync(lock); throw error;
  }
  console.log(JSON.stringify({ session: label, directory, stop: `touch '${join(directory, 'STOP')}'` }, null, 2));
  if (process.argv.includes('--wait')) {
    // CLI integration wait, not a model inference loop. The controller publishes a durable result.
    const { setTimeout } = await import('node:timers/promises');
    const deadline = Date.now() + 660000;
    while (!existsSync(join(directory, 'finished.json'))) {
      if (Date.now() > deadline) throw Error('controller wait timed out; lock retained, inspect controller.log');
      await setTimeout(250);
    }
    const result = JSON.parse(readFileSync(join(directory, 'finished.json'), 'utf8'));
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  }
} else if (command === 'status') {
  const candidates = readdirSync(runs, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'LOCK').map(entry => join(runs, entry.name)).sort();
  const directory = existsSync(join(lock, 'run')) ? readFileSync(join(lock, 'run'), 'utf8').trim()
    : existsSync(join(runs, 'LAST')) ? readFileSync(join(runs, 'LAST'), 'utf8').trim() : candidates.at(-1);
  if (!directory) console.log(JSON.stringify({ status: 'never_started' }, null, 2));
  else {
    const readJson = name => existsSync(join(directory, name)) ? JSON.parse(readFileSync(join(directory, name), 'utf8')) : undefined;
    console.log(JSON.stringify({ directory, locked: existsSync(join(lock, 'run')),
      activity: activity(directory), state: readJson('state.json'), error: readJson('error.json'),
      finished: readJson('finished.json') }, null, 2));
  }
} else if (command === 'stop' || command === 'recover') {
  if (!existsSync(join(lock, 'run'))) {
    console.log('Factory already stopped; no lock exists.');
  } else {
    const directory = readFileSync(join(lock, 'run'), 'utf8').trim();
    writeFileSync(join(directory, 'STOP'), 'Stop after the active bounded attempt.\n');
    const found = releaseQuiescent(directory, command === 'recover' ? 'explicit stale-run recovery' : 'stop found an already-quiescent interrupted run');
    if (found.controller || found.sessions.length) {
      if (command === 'recover') throw Error(`Cannot recover an active factory: controller=${found.controller}, sessions=${found.sessions.join(',')}`);
      console.log(`Stop requested after the active attempt: ${directory}`);
    } else console.log(`Stopped and released stale lock: ${directory}`);
  }
} else {
  console.log('Usage: node run.mjs smoke [--wait] | start | status | stop | recover');
  process.exitCode = 2;
}
