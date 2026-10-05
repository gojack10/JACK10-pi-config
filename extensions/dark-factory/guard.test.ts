import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Use Pi's loader aliases for the task manager's runtime dependency.
const pkg = join(homedir(), '.local/share/pi-mono/packages/coding-agent');
const { createJiti } = createRequire(join(pkg, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@mariozechner/pi-coding-agent': join(pkg, 'dist/index.js'),
  '@earendil-works/pi-coding-agent': join(pkg, 'dist/index.js'),
} });
const { installGuard } = await jiti.import('./guard.ts');

function harness(dir: string) {
  const handlers = new Map<string, any>();
  const entries: any[] = [];
  const active: any = { jobId: 'job', attemptId: 'attempt', pauseOnInterrupt: true,
    reportPath: join(dir, 'report.json'), state: 'active', pendingWork: [] };
  const ctx: any = { hasPendingMessages: () => false, sessionManager: { getBranch: () => entries } };
  const registry = (globalThis as any)[Symbol.for('pi.task-outcomes.manager-registry')] ??= new WeakMap();
  registry.set(ctx.sessionManager, { snapshot: () => ({ active }) });
  const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler) };
  const load = () => installGuard(pi, { smoke: false, report: active.reportPath, reads: [], role: 'planner' });
  load();
  const end = (stopReason = 'error', interruption?: any) => handlers.get('agent_end')({
    messages: [{ role: 'assistant', stopReason }], interruption }, ctx);
  const settle = (overrides = {}) => handlers.get('agent_before_settle')({ outcome: 'error', continue: false, ...overrides }, ctx);
  const call = (outcome: string) => handlers.get('tool_call')({ toolName: 'report_outcome', input: { outcome } }, ctx);
  return { active, ctx, entries, load, end, settle, call };
}

test('report delivery blocks invalid handoffs while the same attempt can repair them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-report-guard-'));
  try {
    const h = harness(dir);
    const report: any = { version: 1, role: 'planner', disposition: 'next', summary: 'Assignment landed in the tree and prose.',
      evidence: [dir], updated_nodes: ['00000000-0000-0000-0000-000000000000'] };
    writeFileSync(h.active.reportPath, JSON.stringify(report));
    for (const outcome of ['completed', 'blocked']) {
      const rejection = h.call(outcome);
      assert.equal(rejection.block, true);
      assert.match(rejection.reason, /next requires bounded task and acceptance/);
      assert.match(rejection.reason, /current attempt remains open/);
      assert.equal(h.active.state, 'active');
    }
    assert.equal(h.call('failed'), undefined); // A truthful inability to deliver is still reportable.
    report.task = { instruction: 'Use the existing assignment; no replay.', acceptance: 'observable result' };
    writeFileSync(h.active.reportPath, JSON.stringify(report));
    assert.equal(h.call('completed'), undefined);
    for (const disposition of ['continue', 'blocked']) {
      writeFileSync(h.active.reportPath, JSON.stringify({ ...report, disposition, task: undefined, updated_nodes: [] }));
      assert.equal(h.call('completed'), undefined);
    }
    writeFileSync(h.active.reportPath, JSON.stringify({ ...report, role: 'worker', disposition: 'worked' }));
    assert.match(h.call('completed').reason, /invalid report identity/);
    writeFileSync(h.active.reportPath, '{');
    assert.equal(h.call('completed').block, true);
    rmSync(h.active.reportPath);
    assert.equal(h.call('completed').block, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider errors get two same-attempt continuations; reload cannot reset the budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-provider-retry-'));
  try {
    const h = harness(dir);
    for (let retry = 1; retry <= 2; retry++) {
      h.end();
      const result = await h.settle();
      assert.equal(result.continue, true);
      assert.deepEqual(result.entries[0].data, { jobId: 'job', attemptId: 'attempt', retry });
      assert.match(result.entries[1].content, /Do not replay completed work or spent launches/);
      assert.match(result.entries[1].content, /trust saved results and recover uncertain delivery only with a narrow marker lookup/);
      assert.doesNotMatch(result.entries[1].content, /verify uncertain effects/);
      h.entries.push(...result.entries);
      h.load();
    }
    h.end();
    assert.equal(await h.settle(), undefined);
    h.active.attemptId = 'fresh-attempt';
    assert.equal((await h.settle()).entries[0].data.retry, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('human/policy stops, queued work, final outcomes and ordinary chats never auto-continue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-provider-stop-'));
  try {
    for (const kind of ['cancel', 'context', 'maintenance', 'lifecycle']) {
      const h = harness(dir); h.end('error', { kind, source: 'escape' });
      assert.equal(await h.settle(), undefined);
    }
    for (const reason of ['aborted', 'stop', 'toolUse']) {
      const h = harness(dir); h.end(reason);
      assert.equal(await h.settle(), undefined);
    }
    const h = harness(dir); h.end();
    assert.equal(await h.settle({ outcome: 'aborted' }), undefined);
    assert.equal(await h.settle({ continue: true }), undefined);
    h.ctx.hasPendingMessages = () => true;
    assert.equal(await h.settle(), undefined);
    h.ctx.hasPendingMessages = () => false;
    for (const field of [{ state: 'final' }, { state: 'context_paused' }, { pauseOnInterrupt: false },
      { declaration: { outcome: 'blocked' } }, { pendingWork: ['background:running'] }, { reportPath: '/other/report' }]) {
      const blocked = harness(dir); blocked.end(); Object.assign(blocked.active, field);
      assert.equal(await blocked.settle(), undefined);
    }
    writeFileSync(join(dir, 'STOP'), 'operator stop');
    assert.equal(await h.settle(), undefined);
    rmSync(join(dir, 'STOP'));
    (globalThis as any)[Symbol.for('pi.task-outcomes.manager-registry')].delete(h.ctx.sessionManager);
    assert.equal(await h.settle(), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
