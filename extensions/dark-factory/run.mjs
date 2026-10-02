#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { save, ROUTE } from './core.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const home = join(homedir(), '.pi/agent');
const runs = join(home, 'factory-runs');
const lock = join(runs, 'LOCK');
const [command, argument] = process.argv.slice(2);
const quote = x => `'${x.replaceAll("'", "'\\''")}'`;

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
} else if (command === 'stop') {
  const directory = readFileSync(join(lock, 'run'), 'utf8').trim();
  writeFileSync(join(directory, 'STOP'), 'Stop after the active bounded attempt.\n');
  console.log(`Stop requested: ${directory}`);
} else {
  console.log('Usage: node run.mjs smoke [--wait] | start | stop');
  process.exitCode = 2;
}
