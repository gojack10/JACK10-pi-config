import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isolateLauncherEnvironment } from '../_test-helpers/launcher-env.ts';
const exec = promisify(execFile);

const restoreLauncherEnvironment = isolateLauncherEnvironment();
test.after(restoreLauncherEnvironment);

// Every descendant, including the launcher's monitor and fake interactive child,
// uses this disposable socket. No default or inherited live tmux server is used.
for (const scenario of ['complete', 'insufficient', 'cancel', 'queued', 'busy', 'friendly', 'drain'] as const) test(`no-provider context recovery: ${scenario}`, { timeout: 30000 }, async t => {
  const env = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), 'context-recovery-'));
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
  const fixture = fileURLToPath(new URL('./context-recovery-fixture.mjs', import.meta.url));
  const extensionsDir = fileURLToPath(new URL('../', import.meta.url));
  const packageDir = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${env.PATH}`;
  process.env.PI_TEST_RECOVERY_CASE = scenario;
  process.env.PI_TEST_PACKAGE = packageDir;
  process.env.PI_TEST_EXTENSIONS = extensionsDir;
  // Even inherited legacy limits must not leak into an unconfigured child.
  process.env.PI_RLM_FRIENDLY_STOP_TOKENS = '1';
  process.env.PI_RLM_FRIENDLY_STOP_PERCENT = '99';
  const { loadExtensions } = await import(pathToFileURL(`${packageDir}/dist/core/extensions/loader.js`).href);
  const { SessionManager } = await import(pathToFileURL(`${packageDir}/dist/index.js`).href);
  await tmux(['new-session', '-d', '-s', 'parent', '-c', dir]);
  const pane = await tmux(['list-panes', '-t', 'parent', '-F', '#{pane_id}']);
  process.env.TMUX_PANE = pane;
  const loaded = await loadExtensions([join(extensionsDir, 'subagent-launch.ts')], dir);
  assert.deepEqual(loaded.errors, []);
  const messages: string[] = [];
  loaded.runtime.sendUserMessage = (text: string) => { messages.push(text); };
  const model = { provider: 'openai-test', id: scenario === 'friendly' ? 'gpt-5.6-sol' : 'fake', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } };
  const ctx = { cwd: dir, mode: 'tui', sessionManager: SessionManager.inMemory(dir),
    modelRegistry: { find: () => model, getAvailable: () => [model] } };
  const call = (name: string, args: unknown) => loaded.extensions.find((e: any) => e.tools.has(name))
    .tools.get(name).definition.execute('test', args, undefined, undefined, ctx);
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500; i++) { if (await check()) return; await delay(20); }
    assert.fail(`timed out; parent messages: ${messages.join('\n')}`);
  };
  const mission = join(dir, 'mission.md');
  const report = join(dir, 'report.md');
  await writeFile(mission, 'Synthetic context recovery canary; no model.');
  const launch = (await call('subagent_launch', { jobs: [{ provider: model.provider, model: model.id, thinking: 'xhigh',
    mission_file: mission, cwd: dir, session_label: 'child', mode: 'task', report_file: report,
    ...(scenario === 'friendly' ? { friendly_stop_percent: 40, friendly_stop_directory: dir } : {}) }] })).details;
  const job = launch.jobs[0];
  assert.equal(job.status, 'running', job.status === 'running' ? undefined :
    `${JSON.stringify(job)}\n${await readFile(join(tmpdir(), `${job.job}.tmux.log`), 'utf8').catch(() => '(no child log)')}`);
  await until(() => messages.some(text => text.includes('paused for context')));
  assert.match(messages[0], scenario === 'friendly' ? /Friendly checkpoint saved:/ : /Blocked OpenAI request at ~259,495 context tokens/);
  assert.doesNotMatch(messages[0], /Operation aborted/);
  const background = (globalThis as any)[Symbol.for('pi.background-jobs.manager-registry')].get(ctx.sessionManager);
  assert.equal(background.getBatchStatus(launch.batch_id).complete, false);
  const ids = { job_id: job.job, session_id: job.session_id, attempt_id: job.attempt_id };
  await assert.rejects(call('subagent_clean_and_continue', { ...ids, attempt_id: 'stale-attempt' }), /no monitored context-paused/);
  await until(async () => { try { await readFile(join(dir, 'paused.json')); return true; } catch { return false; } });
  const paused = JSON.parse(await readFile(join(dir, 'paused.json'), 'utf8'));
  if (scenario === 'drain') {
    assert.deepEqual(paused.pendingWork, ['child:pending-grandchild'], 'the guard paused the assignment while a child job was still pending');
  }
  const original = await readFile(paused.sessionFile, 'utf8');
  const pauseMessageCount = messages.length;
  if (scenario !== 'complete' && scenario !== 'friendly' && scenario !== 'drain') {
    const reason = { insufficient: /cannot free enough context/, cancel: /reload cancelled/,
      queued: /queued messages remain/, busy: /worker is not idle/ }[scenario];
    await assert.rejects(call('subagent_clean_and_continue', ids), reason);
    assert.equal(background.getBatchStatus(launch.batch_id).complete, false);
    assert.equal(await readFile(report, 'utf8'), '');
    assert.equal(messages.length, pauseMessageCount, 'no false completion or generic abort after refused maintenance');
    if (scenario !== 'cancel') assert.equal(await readFile(paused.sessionFile, 'utf8'), original, 'refused cleanup changes nothing');
    return;
  }
  const result = await call('subagent_clean_and_continue', ids);
  assert.equal(result.details.status, 'resume_requested');
  assert.equal(result.details.attempt_id, job.attempt_id);
  assert.equal(result.details.report_file, report);
  assert.ok(result.details.after_tokens < 256000);
  await until(() => messages.some(text => text.includes('recovered assignment completed')));
  assert.equal(background.getBatchStatus(launch.batch_id).complete, true);
  assert.equal(messages.filter(text => text.includes('recovered assignment completed')).length, 1);
  assert.equal(messages.slice(pauseMessageCount).some(text => /Operation aborted|transport_lost/.test(text)), false);
  // The in-place recovery refresh emits no session lifecycle events.
  assert.equal(await readFile(join(dir, 'lifecycle.jsonl'), 'utf8'), 'session_start\n');
  assert.match(await readFile(report, 'utf8'), new RegExp(job.attempt_id));
  assert.match(await readFile(report, 'utf8'), new RegExp(paused.piSessionId));
  const cleaned = await readFile(paused.sessionFile, 'utf8');
  assert.match(cleaned, /retained progress/);
  assert.match(cleaned, /tool result cleared by \/tool-call-clean/);
  assert.doesNotMatch(cleaned, /large output large output/);
  const childRows = cleaned.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(childRows.filter((row: any) => row.type === 'custom' && row.data?.kind === 'transport_lost').length, 0, 'no false transport loss in the child branch');
  if (scenario === 'drain') {
    // The pending child delivered during the recovered turn, exactly once.
    assert.equal(childRows.filter((row: any) => row.type === 'custom' && row.data?.kind === 'child_outcome').length, 1);
  }
  const backup = (await readdir(dir)).find(name => name.includes('.tool-call-clean.') && name.endsWith('.bak'));
  assert.ok(backup);
  // In-place maintenance persists ownership before cleanup takes its backup.
  const backedUp = await readFile(join(dir, backup), 'utf8');
  assert.equal(backedUp.slice(0, original.length), original, 'backup preserves every pre-maintenance byte');
  const added = backedUp.slice(original.length).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(added.length, 1, 'only the required ownership marker precedes cleanup');
  assert.equal(added[0].type, 'custom');
  assert.equal(added[0].customType, 'task-outcome/v1');
  assert.equal(added[0].data.kind, 'maintenance_begin');
  assert.equal(added[0].data.jobId, job.job);
  assert.equal(added[0].data.attemptId, job.attempt_id);
  assert.equal(added[0].parentId, JSON.parse(original.trim().split('\n').at(-1)!).id);
  await assert.rejects(call('subagent_clean_and_continue', ids), /no monitored context-paused/);
});

test('paused state rejects insufficient context; pending children survive restart and resume through recovery; normal abort semantics are unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'context-recovery-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packageDir = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
  const { loadExtensions } = await import(pathToFileURL(`${packageDir}/dist/core/extensions/loader.js`).href);
  const { SessionManager } = await import(pathToFileURL(`${packageDir}/dist/index.js`).href);
  const taskPath = fileURLToPath(new URL('../task-outcomes.ts', import.meta.url));
  const sm = SessionManager.inMemory(dir);
  async function restore() {
    const loaded = await loadExtensions([taskPath], dir);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = (type: string, data: unknown) => sm.appendCustomEntry(type, data);
    loaded.runtime.sendUserMessage = () => { throw new Error('paused task must not request another model turn'); };
    for (const ext of loaded.extensions) for (const handler of ext.handlers.get('session_start') ?? []) {
      await handler({ reason: 'startup' }, { cwd: dir, sessionManager: sm });
    }
    return (globalThis as any)[Symbol.for('pi.task-outcomes.manager-registry')].get(sm);
  }
  let manager = await restore();
  manager.activateContract({ jobId: 'job', attemptId: 'attempt', mode: 'task', reportPath: join(dir, 'report.md'), childJobIds: ['child'] });
  manager.onAgentStart();
  assert.equal(manager.pauseForContext('actual context guard reason', 100), true);
  const pauseId = manager.snapshot().active.contextPause.id;
  manager.onAgentEnd([{ role: 'assistant', stopReason: 'aborted', errorMessage: 'Operation aborted', content: [] }]);
  await manager.onAgentSettled(false);
  assert.equal(manager.snapshot().active.state, 'context_paused');
  assert.deepEqual(manager.snapshot().outcomes, []);
  await assert.rejects(manager.declare('completed', 'wrong'), /not active/);
  assert.throws(() => manager.resumeAfterContextClean('job', 'wrong', pauseId, 1), /does not match|no longer matches/);
  assert.throws(() => manager.resumeAfterContextClean('job', 'attempt', pauseId, 101), /still over the limit/);
  // The restart happens while the child's result is still pending: the paused
  // assignment and its live child work must survive together.
  manager.shutdown('session resume');
  (globalThis as any)[Symbol.for('pi.task-outcomes.manager-registry')].delete(sm);
  manager = await restore();
  assert.equal(manager.snapshot().active.contextPause.id, pauseId);
  assert.equal(manager.snapshot().active.attemptId, 'attempt');
  // Recovery succeeds while the child's result is still pending, and fabricates
  // no lifecycle outcome records.
  manager.resumeAfterContextClean('job', 'attempt', pauseId, 50);
  assert.equal(manager.snapshot().active.state, 'active');
  assert.deepEqual(manager.snapshot().outcomes, [], 'recovery fabricated no lifecycle outcome');
  // The child's result is delivered exactly once afterwards; a duplicate delivery
  // must not duplicate the durable row, and no transport_lost appears.
  manager.recordChildOutcome('job', 'child', 'completed', 'done');
  manager.recordChildOutcome('job', 'child', 'completed', 'done');
  assert.equal(sm.getBranch().filter((row: any) => row.data?.kind === 'child_outcome').length, 1);
  assert.deepEqual(manager.snapshot().active.pendingWork, []);
  assert.equal(manager.snapshot().outcomes.filter((row: any) => row.outcome === 'transport_lost').length, 0);
  assert.throws(() => manager.resumeAfterContextClean('job', 'attempt', pauseId, 50), /no longer matches/);
  manager.onAgentStart();
  manager.onAgentEnd([{ role: 'assistant', stopReason: 'aborted', errorMessage: 'user cancelled', content: [] }]);
  await manager.onAgentSettled(false);
  assert.equal(manager.snapshot().outcomes.at(-1).outcome, 'failed');
  assert.match(manager.snapshot().outcomes.at(-1).summary, /user cancelled/);
});

test('launcher admits racing final markers once and never resurrects a resumed pause', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packageDir = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
  const { loadExtensions } = await import(pathToFileURL(`${packageDir}/dist/core/extensions/loader.js`).href);
  const { SessionManager } = await import(pathToFileURL(`${packageDir}/dist/index.js`).href);
  const loaded = await loadExtensions([fileURLToPath(new URL('../subagent-launch.ts', import.meta.url))], dir);
  assert.deepEqual(loaded.errors, []);
  const ctx = { cwd: dir, mode: 'tui', sessionManager: SessionManager.inMemory(dir) };
  let release!: (value: unknown) => void;
  const messages: string[] = [];
  loaded.runtime.sendUserMessage = (text: string) => {
    messages.push(text);
    return new Promise(resolve => { release = resolve; });
  };
  const tool = loaded.extensions[0].tools.get('subagent_clean_and_continue').definition;
  await assert.rejects(tool.execute('test', { job_id: 'job', session_id: 'transport', attempt_id: 'attempt' }, undefined, undefined, ctx));
  const launcher = (globalThis as any)[Symbol.for('pi.subagent-launch.launcher-registry')].get(ctx.sessionManager);
  let completions = 0;
  launcher.background = { setCompletion: () => { completions++; } };
  const state: any = { jobId: 'job', attemptId: 'attempt', sessionId: 'transport', outputBuffer: '',
    monitorJobId: 1, startResults: new Map(), startWaiters: new Map() };
  const marker = { jobId: 'job', attemptId: 'attempt', sessionId: 'pi-session',
    eventId: 'pause-event', revision: 1, kind: 'context_paused', pauseId: 'pause', summary: 'clean' };
  const send = (m: any) => launcher.onMonitorOutput(state, JSON.stringify(m) + '\n');
  send(marker); send(marker);
  assert.equal(messages.length, 1);
  send({ ...marker, eventId: 'resume-event', revision: 2, kind: 'active' });
  release(undefined); await delay(0);
  send(marker);
  assert.equal(state.contextPauseId, undefined);
  const final = { ...marker, eventId: 'final-event', revision: 3, kind: 'final', outcome: 'completed', source: 'model', summary: 'done' };
  const chunk = JSON.stringify(final) + '\n' + JSON.stringify({ ...final, outcome: 'failed' }) + '\n';
  launcher.onMonitorOutput(state, chunk.slice(0, 10));
  launcher.onMonitorOutput(state, chunk.slice(10));
  send({ ...marker, revision: 4 });
  assert.equal(completions, 1);
  assert.equal(messages.length, 1);
  assert.equal(state.finalAdmitted, true);
  assert.equal(state.contextPauseId, undefined);
});
