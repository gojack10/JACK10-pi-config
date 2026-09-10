import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Use Pi's real loader so package aliases and TypeBox resolve as they do at startup.
const { loadExtensions } = await import(pathToFileURL(join(homedir(),
  '.local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js')).href);
const { SessionManager } = await import(pathToFileURL(join(homedir(),
  '.local/share/pi-mono/packages/coding-agent/dist/index.js')).href);
const extensionPath = fileURLToPath(new URL('../background-jobs.ts', import.meta.url));
const consumerExtensionPath = fileURLToPath(new URL('./consumer-test-extension.ts', import.meta.url));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for test event');
}
async function harness(t: any, withConsumer = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bg-test-'));
  const { extensions, errors, runtime } = await loadExtensions(
    withConsumer ? [extensionPath, consumerExtensionPath] : [extensionPath],
    dir,
  );
  assert.deepEqual(errors, []);
  const messages: Array<{ text: string; options: any }> = [];
  runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
  const ctx = { cwd: dir, sessionManager: SessionManager.inMemory(dir) };
  const emit = async (name: string, event: any = {}) => {
    for (const ext of extensions) {
      for (const handler of ext.handlers.get(name) ?? []) await handler(event, ctx);
    }
  };
  const call = (name: string, args: any = {}, callCtx: any = ctx) => {
    const owner = extensions.find(ext => ext.tools.has(name));
    assert.ok(owner, `missing tool ${name}`);
    return owner.tools.get(name)!.definition.execute('test', args, undefined, undefined, callCtx);
  };
  const gates: string[] = [];
  const gated = async (label: string, command = `printf '${label}'`) => {
    const gate = join(dir, label); gates.push(gate);
    const job = await call('bash_bg', { label,
      command: `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 250 ]; do i=$((i+1)); sleep .02; done; ${command}` });
    return { ...job, release: () => writeFile(gate, '') };
  };
  t.after(async () => {
    for (const gate of gates) await writeFile(gate, '').catch(() => {});
    await emit('session_shutdown');
    await delay(100);
    await rm(dir, { recursive: true, force: true });
  });
  return { call, emit, messages, gated, dir, ctx };
}

const gatedCommand = (gate: string, output: string, exitCode = 0) =>
  `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 250 ]; do i=$((i+1)); sleep .02; done; printf '${output}'; exit ${exitCode}`;

test('default batch holds a nonzero exit until its peer finishes', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const gateA = join(h.dir, 'failed-a'), gateB = join(h.dir, 'success-b');
  const a = await h.call('bash_bg', { label: 'failed-a', command: gatedCommand(gateA, 'failed-a', 7) });
  const b = await h.call('bash_bg', { label: 'success-b', command: gatedCommand(gateB, 'success-b') });
  await writeFile(gateA, '');
  await delay(150);
  assert.equal(h.messages.length, 0);
  await writeFile(gateB, '');
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /failed-a/);
  assert.match(h.messages[0].text, /success-b/);
  assert.match(h.messages[0].text, new RegExp(`job_${a.details.job_id} .*exit 7`));
  assert.match(h.messages[0].text, new RegExp(`job_${b.details.job_id} .*exit 0`));
});

test('explicit batches are isolated and emit once', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  const xA = join(h.dir, 'x-a'), xB = join(h.dir, 'x-b');
  const yC = join(h.dir, 'y-c');
  const unrelated = await h.gated('unrelated');
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'X', expected: 2 });
  const a = await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'X', label: 'x-a', command: gatedCommand(xA, 'x-a', 3),
  });
  const b = await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'X', label: 'x-b', command: gatedCommand(xB, 'x-b'),
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'X' });
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'Y', expected: 1 });
  await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'Y', label: 'y-c', command: gatedCommand(yC, 'y-c'),
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'Y' });
  await writeFile(xA, '');
  await delay(150);
  assert.equal(h.messages.length, 0);
  await writeFile(xB, '');
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /x-a/);
  assert.match(h.messages[0].text, /x-b/);
  assert.doesNotMatch(h.messages[0].text, /y-c|unrelated/);
  assert.equal(h.messages.filter(message => /x-a|x-b/.test(message.text)).length, 1);
  assert.equal(a.details.running, 2);
  assert.equal(b.details.running, 3);
  await unrelated.release();
  await writeFile(yC, '');
  await until(() => h.messages.length === 3);
});

test('failure notification bypasses siblings but batch accounting still emits once', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'failure', expected: 2 });
  const failed = await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'failure', completion_id: 'failed-job',
    command: 'sleep .05', label: 'failed-job',
  });
  await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'failure', completion_id: 'pending-job',
    command: 'sleep .2', label: 'pending-job',
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'failure' });
  await h.call('background_jobs_consumer', { action: 'notify_failure', batch_id: 'failure',
    completion_id: 'failed-job', message: 'cannot read Pi error record: EACCES: permission denied, open session.jsonl' });
  await h.call('background_jobs_consumer', { action: 'notify_failure', batch_id: 'failure',
    completion_id: 'failed-job', message: 'cannot read Pi error record: EACCES: permission denied, open session.jsonl' });
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /failed-job.*failed.*transport.*cannot read Pi error record/);
  assert.equal(h.messages[0].options.deliverAs, 'steer');
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].text, /All 2 background job\(s\)/);
  assert.match(h.messages[1].text, /failed-job/);
  assert.match(h.messages[1].text, /pending-job/);
  assert.equal(h.messages.filter(message => /failed-job/.test(message.text)).length, 2);
  assert.ok(failed.details.job_id);
});

test('needs_input notifies without consuming or cancelling an explicit batch', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  const gateA = join(h.dir, 'input-a'), gateB = join(h.dir, 'input-b');
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'input', expected: 2 });
  const a = await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'input', label: 'input-a', command: gatedCommand(gateA, 'input-a'),
  });
  await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'input', label: 'input-b', command: gatedCommand(gateB, 'input-b'),
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'input' });
  await writeFile(gateA, '');
  await until(async () => (await h.call('background_jobs_consumer', { action: 'stats' })).details.pending === 1);
  await h.call('background_jobs_consumer', {
    action: 'needs_input', batch_id: 'input', message: 'Question: choose a continuation',
  });
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /choose a continuation/);
  const stats = await h.call('background_jobs_consumer', { action: 'stats' });
  assert.equal(stats.details.running, 1);
  assert.equal(stats.details.pending, 1);
  await writeFile(gateB, '');
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].text, /input-a/);
  assert.match(h.messages[1].text, /input-b/);
  assert.ok(a.details.job_id);
});

test('completed, failed, and blocked outcomes collect until batch close', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'outcomes', expected: 3 });
  for (const [outcome_id, status] of [['done', 'completed'], ['bad', 'failed'], ['blocked', 'blocked']]) {
    await h.call('background_jobs_consumer', {
      action: 'outcome', batch_id: 'outcomes', outcome_id, status, message: `${status} ${outcome_id}`,
    });
  }
  assert.equal(h.messages.length, 0);
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'outcomes' });
  await until(() => h.messages.length === 1);
  for (const text of ['completed done', 'failed bad', 'blocked blocked']) assert.match(h.messages[0].text, new RegExp(text));
});

test('structured transport source survives batch completion', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'transport', expected: 1 });
  await h.call('background_jobs_consumer', {
    action: 'outcome', batch_id: 'transport', outcome_id: 'child', status: 'failed',
    source: 'transport', message: 'child pane disappeared',
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'transport' });
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /failed.*transport/);
  const report = await h.call('background_jobs_consumer', { action: 'report', batch_id: 'transport' });
  assert.equal(report.details.report.completions[0].source, 'transport');
});

test('shared manager is session-owned and is cleaned up on replacement', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  const oldJob = await h.gated('old-owner');
  const shared = await h.call('background_jobs_consumer', {
    action: 'start', label: 'shared-owner', command: 'sleep 10',
  });
  const stats = await h.call('background_jobs_consumer', { action: 'stats' });
  assert.equal(stats.details.jobs, 2);
  assert.equal(stats.details.running, 2);
  await oldJob.release();
  await until(async () => (await h.call('background_jobs_consumer', { action: 'stats' })).details.pending === 1);
  await h.emit('session_shutdown');
  await delay(100);
  const replacementCtx = { cwd: h.dir, sessionManager: SessionManager.inMemory(h.dir) };
  const replacementStats = await h.call('background_jobs_consumer', { action: 'stats' }, replacementCtx);
  assert.deepEqual(replacementStats.details, { jobs: 0, running: 0, pending: 0, batches: 0 });
  const replacementJobs = await h.call('bash_jobs', {}, replacementCtx);
  assert.match(replacementJobs.content[0].text, /No background jobs/);
  assert.ok(shared.details.job_id);
});

test('closed batches reject late members and retain registered outcomes', { timeout: 10000 }, async t => {
  const h = await harness(t, true);
  const gate = join(h.dir, 'registered-job');
  await h.call('background_jobs_consumer', { action: 'open', batch_id: 'closed', expected: 2 });
  await h.call('background_jobs_consumer', {
    action: 'start', batch_id: 'closed', label: 'registered-job', command: gatedCommand(gate, 'registered-job'),
  });
  await h.call('background_jobs_consumer', {
    action: 'register', batch_id: 'closed', outcome_id: 'registered-outcome',
  });
  await h.call('background_jobs_consumer', { action: 'close', batch_id: 'closed' });
  await h.call('background_jobs_consumer', {
    action: 'outcome', batch_id: 'closed', outcome_id: 'registered-outcome',
    status: 'blocked', message: 'registered before close',
  });
  await assert.rejects(
    h.call('background_jobs_consumer', {
      action: 'start', batch_id: 'closed', label: 'late-job', command: 'true',
    }),
    /closed|complete/i,
  );
  await assert.rejects(
    h.call('background_jobs_consumer', {
      action: 'outcome', batch_id: 'closed', outcome_id: 'late-outcome', status: 'completed',
    }),
    /closed|complete/i,
  );
  await writeFile(gate, '');
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /registered-job/);
  assert.match(h.messages[0].text, /registered-outcome/);
  await assert.rejects(
    h.call('background_jobs_consumer', { action: 'open', batch_id: 'closed', expected: 1 }),
    /closed|complete/i,
  );
});

test('final reports retain generic identity and status after send failure', async t => {
  const h = await harness(t, true);
  const result = await h.call('background_jobs_consumer', {
    action: 'fail_report', batch_id: 'report', outcome_id: 'failure-id',
    status: 'failed', message: 'custom failure summary',
  });
  const report = result.details.report;
  assert.equal(h.messages.length, 0);
  assert.ok(report);
  assert.match(report.text, /failure-id/);
  assert.match(report.text, /failed/);
  assert.match(report.text, /custom failure summary/);
  assert.equal(report.completions[0].id, 'failure-id');
  assert.equal(report.completions[0].status, 'failed');
  const again = await h.call('background_jobs_consumer', { action: 'report', batch_id: 'report' });
  assert.equal(again.details.report.text, report.text);
});

test('running jobs preserve undefined exit_code details', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const job = await h.call('bash_bg', { label: 'running-details', command: 'sleep 10' });
  const listed = await h.call('bash_jobs');
  assert.equal(listed.details.jobs.find((item: any) => item.id === job.details.job_id)?.exit_code, undefined);
});

test('overlapping jobs share one steering wake, including jobs added mid-batch', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const a = await h.gated('alpha'), b = await h.gated('beta');
  await a.release(); await delay(150);
  assert.equal(h.messages.length, 0);
  const c = await h.gated('gamma');
  await b.release(); await delay(150);
  assert.equal(h.messages.length, 0);
  await c.release(); await until(() => h.messages.length === 1);
  const batch = h.messages[0];
  assert.equal(batch.options.deliverAs, 'steer');
  for (const label of ['alpha', 'beta', 'gamma']) assert.ok(batch.text.includes(label));
  for (const job of [a, b, c]) {
    assert.ok(batch.text.includes(`job_${job.details.job_id}`));
    assert.ok(batch.text.includes(job.details.log_path));
    assert.match(job.content[0].text, /poll/i);
    assert.match(job.content[0].text, /user.*(asks|request)/i);
  }
  assert.match(c.content[0].text, /2.*(running|remain)|(?:running|remain).*2/i);
  const d = await h.call('bash_bg', { command: 'true', label: 'standalone' });
  await until(() => h.messages.length === 2);
  assert.ok(h.messages[1].text.includes(`job_${d.details.job_id}`));
  assert.ok(!h.messages[1].text.includes(`job_${a.details.job_id}`));
});

test('spawn failure is terminal but waits for its overlapping peer', { timeout: 10000 }, async t => {
  const h = await harness(t), a = await h.gated('peer');
  const failed = await h.call('bash_bg', { command: 'true', cwd: join(h.dir, 'missing'), label: 'failure' });
  await delay(150); assert.equal(h.messages.length, 0);
  await a.release(); await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /failed|ENOENT/);
  assert.ok(h.messages[0].text.includes(`job_${failed.details.job_id}`));
});

test('shutdown suppresses completion wakes', { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.gated('shutdown');
  await h.emit('session_shutdown');
  await delay(100);
  assert.equal(h.messages.length, 0);
});

test('completion waits for late stdout and log flush', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const job = await h.call('bash_bg', { command: '(sleep .15; printf late-output) & exit 0' });
  await until(() => h.messages.length === 1);
  assert.equal(await readFile(job.details.log_path, 'utf8'), 'late-output');
});

test('can kill a job whose shell exited while descendants still hold stdout', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const job = await h.call('bash_bg', { command: '(trap "" TERM; sleep 10) & exit 0' });
  await until(async () => (await h.call('bash_tail', { job_id: job.details.job_id })).details.exit_code === 0);
  assert.equal(h.messages.length, 0);
  const result = await h.call('bash_kill', { job_id: job.details.job_id });
  assert.match(result.content[0].text, /SIGTERM/);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /killed/);
});

test('tail respects real lines, byte bounds and UTF-8; preserves full log', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const job = await h.call('bash_bg', { command: 'true' });
  await until(() => h.messages.length === 1);
  const path = job.details.log_path;
  await writeFile(path, 'a\nb\nc\n');
  const tail = () => h.call('bash_tail', { job_id: job.details.job_id, lines: 2 });
  assert.match((await tail()).content[0].text, /\nb\nc(?:\n|$)/);
  const huge = '😀'.repeat(65536) + 'END';
  await writeFile(path, huge);
  const result = (await tail()).content[0].text;
  assert.ok(Buffer.byteLength(result) < 50 * 1024 + 2048);
  assert.ok(!result.includes('\uFFFD'));
  assert.ok(result.includes('END'));
  assert.ok(result.includes(path));
  assert.match(result, /truncat|limit|partial/i);
  assert.equal(await readFile(path, 'utf8'), huge);
});
