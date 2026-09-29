import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isolateLauncherEnvironment } from '../_test-helpers/launcher-env.ts';
const restore = isolateLauncherEnvironment();
test.after(restore);
const exec = promisify(execFile);
for (const [mode, firstOutcome, pendingChild = 'no'] of [['task', 'completed'], ['dialogue', 'completed'], ['task', 'needs_input'], ['task', 'completed', 'yes']])
  test(`busy ${mode}/${firstOutcome}/child=${pendingChild} follow-up uses native idle admission once in the saved session`, { timeout: 30000 }, async t => {
  const env = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), 'busy-followup-'));
  const bin = join(dir, 'bin');
  const socket = join(dir, 'tmux.sock');
  const realTmux = (await exec('which', ['tmux'])).stdout.trim();
  const quote = (s: string) => `'${s.replaceAll("'", "'\"'\"'")}'`;
  const tmux = async (args: string[]) => (await exec(realTmux, ['-S', socket, '-f', '/dev/null', ...args])).stdout.trim();
  t.after(async () => {
    await tmux(['kill-server']).catch(() => {});
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(realTmux)} -S ${quote(socket)} -f /dev/null "$@"\n`, { mode: 0o700 });
  const fixture = fileURLToPath(new URL('./busy-followup-fixture.mjs', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${env.PATH}`, PI_TEST_PACKAGE: pkg, PI_TEST_EXTENSIONS: root, PI_TEST_FIRST_OUTCOME: firstOutcome, PI_TEST_PENDING_CHILD: pendingChild });
  await tmux(['new-session', '-d', '-s', 'parent', '-c', dir]);
  process.env.TMUX_PANE = await tmux(['list-panes', '-t', 'parent', '-F', '#{pane_id}']);
  const { loadExtensions } = await import(pathToFileURL(`${pkg}/dist/core/extensions/loader.js`).href);
  const { SessionManager } = await import(pathToFileURL(`${pkg}/dist/index.js`).href);
  const loaded = await loadExtensions([join(root, 'subagent-launch.ts')], dir);
  assert.deepEqual(loaded.errors, []);
  const messages: string[] = [];
  loaded.runtime.sendUserMessage = (text: string) => { messages.push(text); };
  const model = { provider: 'fake-provider', id: 'gpt-6-astra', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } };
  const ctx = { cwd: dir, mode: 'tui', sessionManager: SessionManager.inMemory(dir),
    modelRegistry: { find: () => model, getAvailable: () => [model] } };
  const call = (name: string, args: unknown) => loaded.extensions.find((e: any) => e.tools.has(name))
    .tools.get(name).definition.execute('test', args, undefined, undefined, ctx);
  const events = async () => (await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500; i++) { if (await check()) return; await delay(20); }
    assert.fail(`timed out: ${messages.join('\n')}`);
  };
  const mission = join(dir, 'mission.md');
  await writeFile(mission, 'Synthetic busy follow-up test; no network or real model.');
  const report = join(dir, 'first.md');
  const input = { provider: model.provider, model: model.id, thinking: 'xhigh', mission_file: mission,
    cwd: dir, session_label: 'child', mode, ...(mode === 'task' ? { report_file: report } : {}) };
  const initial = (await call('subagent_launch', { jobs: [input] })).details.jobs[0];
  assert.equal(initial.status, 'running', JSON.stringify(initial) + '\n' + await readFile(join(tmpdir(), `${initial.job}.tmux.log`), 'utf8').catch(() => ''));
  const followupInput = { ...input, job_id: initial.job, session_id: initial.session_id,
    ...(mode === 'task' ? { report_file: join(dir, 'second.md') } : {}) };
  await assert.rejects(call('subagent_followup', { ...followupInput, thinking: 'low' }), /match.*route/);
  const capability = await tmux(['show-options', '-qv', '-t', initial.pane_id, '@pi_subagent_followup_session']);
  await tmux(['set-option', '-qu', '-t', initial.pane_id, '@pi_subagent_followup_session']);
  await assert.rejects(call('subagent_followup', followupInput), /lacks native queued follow-up support/);
  await tmux(['set-option', '-q', '-t', initial.pane_id, '@pi_subagent_followup_session', capability]);
  const next = (await call('subagent_followup', followupInput)).details;
  assert.equal(next.status, 'queued');
  assert.notEqual(next.attempt_id, initial.attempt_id);
  assert.equal(next.session_id, initial.session_id);
  assert.equal(next.pane_id, initial.pane_id);
  assert.equal(await tmux(['show-options', '-qv', '-t', initial.pane_id, '@pi_subagent_manifest']), initial.manifest_file);
  const reservation = mode === 'task' ? await stat(next.report_file) : undefined;
  if (reservation) { assert.equal(reservation.size, 0); assert.notEqual(next.report_file, initial.report_file); }
  assert.equal((await events()).filter(e => e.kind === 'start').length, 1);
  const third = mode === 'task' && firstOutcome === 'completed' && pendingChild === 'no'
    ? (await call('subagent_followup', { ...followupInput, report_file: join(dir, 'third.md') })).details : undefined;
  if (third) { assert.equal(third.status, 'queued'); assert.notEqual(third.attempt_id, next.attempt_id); }
  // Replay the local transport command: native admission must still happen once.
  await tmux(['send-keys', '-t', next.pane_id, '-l', `/subagent-followup ${next.manifest_file}`]);
  await tmux(['send-keys', '-t', next.pane_id, 'Enter']);
  await tmux(['wait-for', '-S', `release-${initial.job}`]);
  if (mode === 'task') await until(async () => (await readFile(report, 'utf8')).includes(initial.attempt_id));
  await delay(100);
  assert.equal((await events()).filter(e => e.kind === 'start').length, 1, 'even published outcomes do not bypass native settlement: ' + JSON.stringify(await events()));
  await tmux(['wait-for', '-S', `settle-${initial.job}`]);
  if (pendingChild === 'yes') {
    await until(async () => (await events()).some(e => e.kind === 'settled' && e.attempt === initial.attempt_id));
    await delay(100);
    assert.equal((await events()).filter(e => e.kind === 'start').length, 1, 'idle task still owns its child');
    assert.equal(await tmux(['show-options', '-qv', '-t', initial.pane_id, '@pi_subagent_manifest']), initial.manifest_file);
    await tmux(['wait-for', '-S', `child-${initial.job}`]);
  }
  await until(async () => (await events()).some(e => e.kind === 'settled' && e.attempt === (third ?? next).attempt_id));
  await until(() => messages.filter(text => text.includes(next.attempt_id)).length === 1);
  if (third) await until(() => messages.filter(text => text.includes(third.attempt_id)).length === 1);
  const rows = await events();
  const firstTurn = [['start', initial.attempt_id], ['settled', initial.attempt_id]];
  assert.deepEqual(rows.map(e => [e.kind, e.attempt]), [...firstTurn, ...(pendingChild === 'yes' ? firstTurn : []), ['start', next.attempt_id], ['settled', next.attempt_id],
    ...(third ? [['start', third.attempt_id], ['settled', third.attempt_id]] : [])]);
  const starts = rows.filter(e => e.kind === 'start');
  assert.equal(new Set(starts.map(e => e.session)).size, 1);
  assert.equal(new Set(starts.map(e => e.file)).size, 1);
  assert.deepEqual(starts.map(e => [e.provider, e.model, e.thinking]), Array(starts.length).fill([input.provider, input.model, input.thinking]));
  if (reservation) {
    assert.equal((await stat(next.report_file)).ino, reservation.ino);
    assert.match(await readFile(next.report_file, 'utf8'), new RegExp(next.attempt_id));
  } else assert.ok(messages.some(text => text.includes(`reply ${next.attempt_id}`)), 'dialogue comes back verbatim');
  assert.equal(messages.filter(text => text.includes(initial.attempt_id)).length, 1, 'old completion not lost or duplicated: ' + messages.join('\n'));
  assert.ok(messages.every(text => !/transport_lost|protocol_incomplete/.test(text)), messages.join('\n'));
  if (third) {
    const idle = (await call('subagent_followup', { ...followupInput, report_file: join(dir, 'idle.md') })).details;
    assert.equal(idle.status, 'queued');
    assert.equal(idle.session_id, initial.session_id);
    await until(() => messages.filter(text => text.includes(idle.attempt_id)).length === 1);
    await until(async () => (await events()).some(e => e.kind === 'settled' && e.attempt === idle.attempt_id));
    assert.deepEqual((await events()).slice(-2).map(e => [e.kind, e.attempt]), [['start', idle.attempt_id], ['settled', idle.attempt_id]]);
  }
});
