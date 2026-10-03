import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuationAfterStop, isContinuation, readAttemptResult, runLoop } from './core.mjs';
import { publishMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';

const report = (role, disposition) => ({ version: 1, role, disposition, summary: 'retained progress', evidence: [], updated_nodes: [],
  ...(disposition === 'next' ? { task: { instruction: 'finish the original task', acceptance: 'verified result' } } : {}) });

test('friendly reports continue the same role and task; real blockers still stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-handoff-'));
  try {
    const roles = [];
    const dispositions = ['blocked', 'next', 'continue', 'blocked', 'worked', 'blocked'];
    await runLoop({ directory: dir, smoke: true, maxSteps: 7, runStep: async ({ step, role, previous, task }) => {
      roles.push(role);
      if (step === 2) assert.equal(previous, join(dir, '1-planner.json'));
      if ([3, 4, 5].includes(step)) assert.deepEqual(task, report('planner', 'next').task);
      if (step === 4) assert.equal(previous, join(dir, '3-worker.json'));
      if (step === 5) assert.equal(previous, join(dir, '4-worker.json'));
      const r = report(role, dispositions[step - 1]);
      writeFileSync(join(dir, `${step}-${role}.json`), JSON.stringify(r));
      return { text: JSON.stringify(r), receipt: { job: `attempt-${step}` }, contextStopped: [1, 3, 4, 5].includes(step) };
    } });
    assert.deepEqual(roles, ['planner', 'planner', 'worker', 'worker', 'worker', 'planner']);
    const history = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(history.map(h => h.contextCheckpoint), [true, false, true, true, false, false]);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).status, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('STOP at a context handoff preserves the unfinished assignment and fresh report path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-handoff-stop-'));
  try {
    await runLoop({ directory: dir, smoke: true, maxSteps: 3, runStep: async ({ step, role }) => {
      const r = report(role, step === 1 ? 'next' : 'continue');
      if (step === 2) writeFileSync(join(dir, 'STOP'), 'human stop');
      return { text: JSON.stringify(r), receipt: { job: `attempt-${step}` }, contextStopped: step === 2 };
    } });
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const history = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const resume = continuationAfterStop(state, history);
    assert.equal(resume.step, 3);
    assert.equal(resume.role, 'worker');
    assert.equal(resume.previous, join(dir, '2-worker.json'));
    assert.deepEqual(resume.task, report('planner', 'next').task);
    assert.notEqual(join(dir, `${resume.step}-${resume.role}.json`), resume.previous);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit incomplete reports hand off without an 80% event; ordinary blockers remain terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-handoff-explicit-'));
  try {
    assert.equal(isContinuation(report('worker', 'continue'), false), true);
    assert.equal(isContinuation(report('worker', 'blocked'), false), false);
    assert.equal(isContinuation(report('worker', 'blocked'), true), true);
    const seen = [];
    await runLoop({ directory: dir, smoke: true, maxSteps: 4,
      runStep: async ({ step, role, previous, task }) => {
        seen.push(role);
        if (step === 3) {
          assert.equal(previous, join(dir, '2-worker.json'));
          assert.deepEqual(task, report('planner', 'next').task);
        }
        return { text: JSON.stringify(report(role, step === 1 ? 'next' : step === 2 ? 'continue' : step === 3 ? 'worked' : 'blocked')),
          receipt: { job: step }, contextStopped: false };
      } });
    assert.deepEqual(seen, ['planner', 'worker', 'worker', 'planner']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).status, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('durable context checkpoints bind to the selected branch, attempt and report identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-handoff-receipt-'));
  try {
    const fixture = (label, { outcome = 'completed', source = 'model', stopAttempt = 'attempt', offBranch = false } = {}) => {
      const sessionFile = join(dir, `${label}.jsonl`), reportFile = join(dir, `${label}-report.json`), manifestFile = join(dir, `${label}-manifest.json`);
      const reportText = JSON.stringify(report('worker', 'blocked'));
      writeFileSync(reportFile, reportText);
      const stat = statSync(reportFile), reportIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
      const identity = { sessionId: 'pi-session', jobId: 'job', attemptId: 'attempt', mode: 'task', reportPath: reportFile, reportIdentity };
      const contract = { type: 'custom', id: 'contract', parentId: null, customType: 'task-outcome/v1', data: {
        version: 1, kind: 'contract', eventId: 'contract-event', contract: { ...identity, ownerSessionId: identity.sessionId } } };
      const stop = { type: 'custom', id: 'friendly', parentId: contract.id, customType: 'rlm-friendly-stop-state',
        data: { version: 2, jobId: identity.jobId, attemptId: stopAttempt } };
      const final = { type: 'custom', id: 'final', parentId: offBranch ? contract.id : stop.id, customType: 'task-outcome/v1', data: {
        version: 1, kind: 'outcome', eventId: 'final-event', jobId: identity.jobId, attemptId: identity.attemptId,
        outcome, source, reportText, summary: 'FRIENDLY STOP prose is not the evidence' } };
      writeFileSync(sessionFile, [JSON.stringify({ type: 'session', id: identity.sessionId }), ...[contract, stop, final].map(JSON.stringify)].join('\n') + '\n');
      publishMonitorReceipt(sessionFile, identity, offBranch ? [contract, final] : [contract, stop, final], final.id);
      writeFileSync(manifestFile, JSON.stringify({ ...identity, reportIdentity }));
      return { job: identity.jobId, attempt_id: identity.attemptId, manifest_file: manifestFile, session_file: sessionFile, report_file: reportFile };
    };
    for (const outcome of ['completed', 'blocked']) {
      const result = readAttemptResult(fixture(outcome, { outcome }));
      assert.equal(result.contextStopped, true);
      assert.equal(result.outcome.payload.outcome, outcome);
      assert.equal(JSON.parse(result.text).disposition, 'blocked');
    }
    assert.equal(readAttemptResult(fixture('stale', { stopAttempt: 'other-attempt' })).contextStopped, false);
    assert.equal(readAttemptResult(fixture('offbranch', { offBranch: true })).contextStopped, false);
    assert.throws(() => readAttemptResult(fixture('technical', { outcome: 'failed', source: 'technical' })), /settled model report/);
    const changed = fixture('changed');
    writeFileSync(changed.report_file, JSON.stringify(report('worker', 'worked')));
    assert.throws(() => readAttemptResult(changed), /report changed after settlement/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
