import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, copyFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from './cli.mjs';
import { main as boardMain } from '../../bf2-swarm/cli.mjs';

// An isolated consumer checkout may point at the sibling's real backend.
// No fake SQLite/domain proof; after merge, omit this variable.
const source = resolve(process.env.FACTORY_TEST_RUNTIME_DIR ?? '.');
const runtime = await import(pathToFileURL(join(source, 'extensions/dark-factory/floors/runtime.mjs')).href);
const boardApi = await import(pathToFileURL(join(source, 'extensions/bf2-swarm/board.mjs')).href);
const supervisor = await import(pathToFileURL(join(source, 'extensions/dark-factory/floors/supervisor.mjs')).href);

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-cli-real-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const initialized = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ steeringMode: 'all', followUpMode: 'all' }));
  const root = join(dir, 'floors');
  const settings = { name: 'Fixture', cwd: repo, roots: ['11111111-1111-4111-8111-111111111111'],
    instructions: '22222222-2222-4222-8222-222222222222', voteCondition: '33333333-3333-4333-8333-333333333333',
    slots: ['peer-a', 'peer-b'].map(id => ({ id, provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'high', role: 'Fixture role', contextWarning: 77 })),
    bootstrap: 'Fixture bootstrap only', warningText: 'Fixture warning only', wrapupText: 'Fixture wrapup only' };
  const path = join(dir, 'input.json');
  const calls = [];
  const api = { ...runtime, ...boardApi, ...supervisor,
    createFloor(...args) {
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try { return runtime.createFloor(...args); }
      finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
    },
    ensureFloorController(floor) { calls.push(floor.id); return '$fixture'; } };
  const env = { FACTORY_ROOT: root };
  const run = async (...args) => {
    let text = '';
    const result = await main(args, env, { write(chunk, callback) { text += chunk; callback(); } }, api);
    return { result, text };
  };
  const input = value => { writeFileSync(path, JSON.stringify(value)); return path; };
  return { dir, repo, agentDir, root, env, settings, path, calls, api, run, input };
}

test('real create-stopped/discovery/config/route validation use one runtime SQLite', async t => {
  const f = fixture(t);
  const { result } = await f.run('create', '--floor', 'alpha', '--settings', f.input(f.settings));
  assert.equal(result.status, 'stopped'); assert.equal(existsSync(result.database), true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.run('list')).result.map(x => x.id), ['alpha']);
  assert.equal((await f.run('status', '--floor', 'alpha')).result.status, 'stopped');
  assert.equal((await f.run('config', '--floor', 'alpha')).result.voteCondition, f.settings.voteCondition);
  assert.equal((await f.run('config', '--floor', 'alpha', '--settings', f.input({ name: 'Changed' }))).result.name, 'Changed');
  for (const patch of [{ slots: null }, { slots: Array(11).fill(f.settings.slots[0]) },
    { cwd: 'relative' }, { instructions: 'not a UUID' }, { voteCondition: '' }, { voteCondition: 'Fixture owner condition' }, { voteCondition: 1 }, { voteCondition: [] }, { unknown: true },
    ...[{ model: 'unapproved' }, { provider: 'other' }, { thinking: 'low' }, { contextWarning: 0 }, { contextWarning: 101 }]
      .map(change => ({ slots: f.settings.slots.map(slot => ({ ...slot, ...change })) }))]) {
    await assert.rejects(f.run('config', '--floor', 'alpha', '--settings', f.input(patch)));
    assert.equal((await f.run('config', '--floor', 'alpha')).result.name, 'Changed');
  }
  for (const [i, route] of runtime.ROUTES.entries()) {
    const slots = f.settings.slots.map((slot, j) => ({ ...slot, provider: route.provider, model: route.model, thinking: route.thinking,
      ...(route.provider === 'local' && j === 1 ? { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'high' } : {}) }));
    assert.equal((await f.run('create', '--floor', `route-${i}`, '--settings', f.input({ ...f.settings, slots }))).result.status, 'stopped');
  }
  await assert.rejects(f.run('create', '--floor', 'alpha', '--settings', f.input(f.settings)));
  assert.equal(f.calls.length, 0);
});

test('discovery remains valid when a nonexistent root is below a symlink parent', async t => {
  const f = fixture(t);
  const alias = join(f.dir, 'alias'); symlinkSync(f.dir, alias);
  const env = { FACTORY_ROOT: join(alias, 'new-floors') };
  const output = { write(_text, cb) { cb(); } };
  await main(['create', '--floor', 'alpha', '--settings', f.input(f.settings)], env, output, f.api);
  assert.equal((await main(['list'], env, output, f.api))[0].id, 'alpha');
  assert.equal((await main(['status', '--floor', 'alpha'], env, output, f.api)).status, 'stopped');
});

test('two floors isolate owner posts, settings, lifecycle commands and OSS selection', async t => {
  const f = fixture(t);
  for (const id of ['alpha', 'beta']) await f.run('create', '--floor', id, '--settings', f.input({ ...f.settings, name: id }));
  await f.run('message', '--floor', 'alpha', 'from alpha', '--key', 'alpha-message');
  await f.run('message', '--floor', 'alpha', 'from alpha', '--key', 'alpha-message');
  const alpha = (await f.run('status', '--floor', 'alpha')).result;
  assert.equal(alpha.posts.filter(p => p.text === 'from alpha').length, 1);
  assert.equal(alpha.status, 'stopped', 'chat saves without Start on a fully configured floor');
  assert.equal(alpha.pending, false);
  assert.equal((await f.run('status', '--floor', 'beta')).result.posts.length, 0);
  await f.run('start', '--floor', 'beta', '--key', 'beta-start');
  await f.run('stop', '--floor', 'alpha', '--key', 'alpha-stop');
  assert.equal((await f.run('status', '--floor', 'alpha')).result.status, 'stopped');
  assert.equal((await f.run('status', '--floor', 'beta')).result.status, 'running');
  await f.run('config', '--floor', 'alpha', '--settings', f.input({ voteCondition: '44444444-4444-4444-8444-444444444444' }));
  assert.equal((await f.run('config', '--floor', 'beta')).result.voteCondition, f.settings.voteCondition);
  await assert.rejects(f.run('oss', '--floor', 'beta'), /OSS slot/);
  await f.run('config', '--floor', 'beta', '--settings', f.input({ slots: [f.settings.slots[0], { ...f.settings.slots[1], provider: 'local', model: 'qwen3.8-flash-next', thinking: 'xhigh' }] }));
  assert.equal((await f.run('oss', '--floor', 'beta')).result.selected, 'beta');
  assert.equal((await f.run('oss')).result.selected, 'beta');
  assert.equal((await f.run('oss', '--none')).result.selected, null);
  assert.deepEqual(f.calls, ['beta']); // Only explicit Start recovers a stopped controller; no worker/model launched.
});

test('real worker board binding, history startup boundary, outside scope and cross-floor refusal', async t => {
  const f = fixture(t);
  for (const id of ['alpha', 'beta']) await f.run('create', '--floor', id, '--settings', f.input(f.settings));
  const floor = runtime.openFloor('alpha', { root: f.root });
  t.after(() => floor.close());
  floor.command('fixture-start', 'start');
  const slot = floor.settings().slots[0];
  assert.equal(floor.board.lifecycle.addWorker('session-a', 'aaaaaaaa', '%fixture', undefined, { slot: slot.id, launchConfig: slot }), true);
  const env = { ...f.env, FACTORY_FLOOR: 'alpha', FACTORY_DB: floor.database, FACTORY_SESSION: 'session-a', FACTORY_SENDER: 'aaaaaaaa' };
  const worker = boardApi.openBoard(boardApi.configuration(env));
  t.after(() => worker.close()); worker.lifecycle.ready();
  const capture = { write(_text, callback) { callback(); } };
  await boardMain(['post', 'worker alpha'], env, capture, f.api);
  await boardMain(['read', '--floor', 'alpha'], env, capture, f.api);
  assert.equal(worker.history().startup, false);
  await assert.rejects(boardMain(['post', '--floor', 'beta', 'cross'], env, capture, f.api), /cannot change/);
  await assert.rejects(boardMain(['read'], { ...env, FACTORY_SENDER: '' }, capture, f.api), /incomplete/);
  await assert.rejects(boardMain(['read', '--floor', 'beta'], { BF2_BOARD_SESSION: 'legacy-worker' }, capture, f.api), /legacy BF2 workers/);
  await assert.rejects(main(['message', 'pretend owner'], env, capture, f.api), /outside operator/);
  await assert.rejects(boardMain(['done', '--floor', 'alpha', 'outside'], f.env, capture, f.api), /launch-bound/);
  await boardMain(['post', '--floor', 'beta', 'owner beta'], f.env, capture, f.api);
  let read = ''; await boardMain(['read', '--floor', 'beta'], f.env, { write(text, cb) { read += text; cb(); } }, f.api);
  assert.match(read, /owner beta/); assert.doesNotMatch(read, /worker alpha/); assert.match(read, /FACTORY OWNER/);
  assert.equal(worker.history().posts.filter(p => p.text === 'worker alpha').length, 1);
  assert.equal(worker.history().posts.some(p => p.text === 'owner beta'), false);
  const second = floor.settings().slots[1];
  assert.equal(floor.board.lifecycle.addWorker('session-b', 'bbbbbbbb', '%fixture-b', undefined, { slot: second.id, launchConfig: second }), true);
  const envB = { ...env, FACTORY_SESSION: 'session-b', FACTORY_SENDER: 'bbbbbbbb' };
  const workerB = boardApi.openBoard(boardApi.configuration(envB));
  t.after(() => workerB.close()); workerB.lifecycle.ready();
  assert.equal(floor.snapshot().vote, undefined, 'joining all peers opens no ballot');
  worker.lifecycle.ready(); workerB.lifecycle.ready();
  assert.equal(floor.snapshot().vote, undefined, 'repeated readiness opens no ballot');
  await assert.rejects(boardMain(['pause', 'wrong-condition', 'peer invented question'], env, capture, f.api), /only the owner/);
  await boardMain(['pause', 'fixture-round', f.settings.voteCondition], env, capture, f.api);
  const number = String(floor.snapshot().vote.number);
  await boardMain(['vote', number, 'yes'], env, capture, f.api);
  assert.equal(floor.snapshot().vote.electorate.filter(v => v.answer === 'yes').length, 1);
  assert.equal(floor.snapshot().status, 'running');
  await boardMain(['vote', number, 'yes'], envB, capture, f.api);
  assert.equal(floor.snapshot().status, 'waiting');
  await boardMain(['done', 'fixture progress stays on tree and messages'], env, capture, f.api);
  assert.equal(worker.lifecycle.status().workers.find(w => w.session === 'session-a').state, 'retiring');
});

test('start rejects absent launch text; saved command recovery failure is truthful and retryable', async t => {
  const f = fixture(t);
  await f.run('create', '--floor', 'alpha', '--settings', f.input({ ...f.settings, bootstrap: null }));
  await assert.rejects(f.run('start', '--floor', 'alpha'), /launch settings: bootstrap/);
  assert.equal((await f.run('status', '--floor', 'alpha')).result.status, 'stopped');
  const floor = runtime.openFloor('alpha', { root: f.root });
  try { floor.configure({ bootstrap: f.settings.bootstrap }); } finally { floor.close(); }
  await f.run('start', '--floor', 'alpha', '--key', 'explicit-start');
  let printed = '';
  await assert.rejects(main(['message', '--floor', 'alpha', 'saved', '--key', 'retry'], f.env,
    { write(text, cb) { printed += text; cb(); } }, { ...f.api, ensureFloorController() { throw new Error('fixture recovery failure'); } }), /was saved; controller recovery failed/);
  assert.match(printed, /controllerError/);
  await f.run('message', '--floor', 'alpha', 'saved', '--key', 'retry');
  assert.equal((await f.run('status', '--floor', 'alpha')).result.posts.filter(p => p.text === 'saved').length, 1);
});

test('copied generic legacy BF2 adoption preserves DB/history, stays stopped and is idempotent', async t => {
  const f = fixture(t);
  const originalDir = join(f.dir, 'legacy-original'); mkdirSync(originalDir);
  const originalDB = join(originalDir, 'board.sqlite');
  const original = boardApi.openBoard({ database: originalDB, run: 'legacy-fixture', session: 'controller', sender: '00000000' });
  original.lifecycle.initialize({ agentDir: f.agentDir });
  original.lifecycle.addWorker('old-session', 'aaaaaaaa', '%old');
  const old = boardApi.openBoard({ database: originalDB, run: 'legacy-fixture', session: 'old-session', sender: 'aaaaaaaa' });
  old.lifecycle.ready(); old.post('retained generic history'); old.lifecycle.done('historical handoff'); old.lifecycle.settled(); old.close();
  original.lifecycle.cleaned('old-session'); original.lifecycle.ownerCommand('stop-fixture', 'stop'); original.close();
  const copied = join(f.dir, 'legacy-copy'); mkdirSync(copied);
  copyFileSync(originalDB, join(copied, 'board.sqlite'));
  writeFileSync(join(copied, 'run.json'), JSON.stringify({ run: 'legacy-fixture' }));
  const pendingSettings = { ...f.settings, voteCondition: null, wrapupText: null };
  await f.run('adopt', '--floor', 'legacy', '--run-dir', copied, '--settings', f.input(pendingSettings));
  assert.equal(realpathSync(join(f.root, 'legacy/floor.sqlite')), realpathSync(join(copied, 'board.sqlite')));
  let status = (await f.run('status', '--floor', 'legacy')).result;
  assert.equal(status.floor.voteCondition, null); assert.equal(status.floor.wrapupText, null);
  assert.equal(status.status, 'stopped'); assert.equal(status.workers.length, 1); assert.equal(status.workers[0].state, 'retired');
  assert.equal(status.workers[0].cleaned, 1); assert.equal(status.posts.some(p => p.text === 'retained generic history'), true);
  await f.run('adopt', '--floor', 'legacy', '--run-dir', copied, '--settings', f.input(pendingSettings));
  status = (await f.run('status', '--floor', 'legacy')).result;
  assert.equal(status.workers.length, 1); assert.equal(f.calls.length, 0);
  await assert.rejects(f.run('adopt', '--floor', 'legacy', '--run-dir', originalDir, '--settings', f.input(f.settings)));
  await assert.rejects(f.run('adopt', '--floor', 'legacy', '--run-dir', copied, '--settings', f.input({ ...f.settings, name: 'different' })));
  assert.deepEqual((await f.run('list')).result.map(x => x.id), ['legacy']);
});
