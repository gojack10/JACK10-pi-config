import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
const exec = promisify(execFile);

// Every descendant, including the launcher's monitor and fake interactive child,
// uses this disposable socket. No default or inherited live tmux server is used.
for (const scenario of ['complete', 'insufficient', 'cancel', 'queued', 'busy', 'friendly'] as const) test(`no-provider context recovery: ${scenario}`, { timeout: 30000 }, async t => {
  const env = { ...process.env };
  delete process.env.TMUX; delete process.env.TMUX_PANE; delete process.env.PI_SUBAGENT_MANIFEST;
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
  const model = { provider: 'openai-test', id: 'fake', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } };
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
    ...(scenario === 'friendly' ? { friendly_stop_percent: 50, friendly_stop_directory: dir } : {}) }] })).details;
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
  const original = await readFile(paused.sessionFile, 'utf8');
  const pauseMessageCount = messages.length;
  if (scenario !== 'complete' && scenario !== 'friendly') {
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
  assert.equal(messages.slice(pauseMessageCount).some(text => /Operation aborted|transport_lost/.test(text)), false);
  assert.match(await readFile(report, 'utf8'), new RegExp(job.attempt_id));
  assert.match(await readFile(report, 'utf8'), new RegExp(paused.piSessionId));
  const cleaned = await readFile(paused.sessionFile, 'utf8');
  assert.match(cleaned, /retained progress/);
  assert.match(cleaned, /tool result cleared by \/tool-call-clean/);
  assert.doesNotMatch(cleaned, /large output large output/);
  const backup = (await readdir(dir)).find(name => name.includes('.tool-call-clean.') && name.endsWith('.bak'));
  assert.ok(backup);
  assert.equal(await readFile(join(dir, backup), 'utf8'), original);
  await assert.rejects(call('subagent_clean_and_continue', ids), /no monitored context-paused/);
});

test('paused state rejects insufficient context and pending children; normal abort semantics are unchanged', async t => {
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
  assert.throws(() => manager.resumeAfterContextClean('job', 'attempt', pauseId, 50), /work is pending/);
  manager.recordChildOutcome('job', 'child', 'completed', 'done');
  manager.shutdown('session resume');
  (globalThis as any)[Symbol.for('pi.task-outcomes.manager-registry')].delete(sm);
  manager = await restore();
  assert.equal(manager.snapshot().active.contextPause.id, pauseId);
  assert.equal(manager.snapshot().active.attemptId, 'attempt');
  manager.resumeAfterContextClean('job', 'attempt', pauseId, 50);
  assert.equal(manager.snapshot().active.state, 'active');
  assert.throws(() => manager.resumeAfterContextClean('job', 'attempt', pauseId, 50), /no longer matches/);
  manager.onAgentStart();
  manager.onAgentEnd([{ role: 'assistant', stopReason: 'aborted', errorMessage: 'user cancelled', content: [] }]);
  await manager.onAgentSettled(false);
  assert.equal(manager.snapshot().outcomes.at(-1).outcome, 'failed');
  assert.match(manager.snapshot().outcomes.at(-1).summary, /user cancelled/);
});
