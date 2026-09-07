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
const extensionPath = fileURLToPath(new URL('../background-jobs.ts', import.meta.url));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(20); }
  assert.fail('Timed out waiting for test event');
}
async function harness(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'bg-test-'));
  const { extensions, errors, runtime } = await loadExtensions([extensionPath], dir);
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const messages: Array<{ text: string; options: any }> = [];
  runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
  const ctx = { cwd: dir };
  const emit = async (name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  const call = (name: string, args: any = {}) =>
    extension.tools.get(name).definition.execute('test', args, undefined, undefined, ctx);
  const gates: string[] = [];
  const gated = async (label: string) => {
    const gate = join(dir, label); gates.push(gate);
    const job = await call('bash_bg', { label,
      command: `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 250 ]; do i=$((i+1)); sleep .02; done; printf '${label}'` });
    return { ...job, release: () => writeFile(gate, '') };
  };
  t.after(async () => {
    for (const gate of gates) await writeFile(gate, '').catch(() => {});
    await emit('session_shutdown');
    await delay(100);
    await rm(dir, { recursive: true, force: true });
  });
  return { call, emit, messages, gated, dir };
}

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
  const h = await harness(t), job = await h.gated('shutdown');
  await h.emit('session_shutdown');
  await until(async () => !(await h.call('bash_tail', { job_id: job.details.job_id })).details.alive);
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
