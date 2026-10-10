import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
import { readPiLifecycle, nonfinalPiOutcome, readPiOutcome } from './parallel-lifecycle.mjs';

// Actual identity/selected-branch receipt reader, no pane or provider simulation as settlement proof.
test('readopted provisional/input/context/maintenance/loss lifecycles remain distinct from MODEL final', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-lifecycle-'));
  try {
    const reportPath = join(dir, 'report.json'), reportText = '{"summary":"finished assigned contribution"}\n';
    writeFileSync(reportPath, reportText);
    const reportStat = statSync(reportPath);
    const identity = { sessionId: 'e5a7641d-0000-4000-8000-000000000001', jobId: 'saved-job', attemptId: 'saved-attempt', mode: 'task',
      reportPath, reportIdentity: { dev: String(reportStat.dev), ino: String(reportStat.ino) } };
    const transportSessionId = 'subagent-session-fixture';
    assert.notEqual(identity.sessionId, transportSessionId);
    const session = join(dir, 'session.jsonl'), manifest = join(dir, 'manifest.json');
    const receipt = { session_id: transportSessionId, job: identity.jobId, attempt_id: identity.attemptId,
      session_file: session, manifest_file: manifest, report_file: identity.reportPath };
    const savedManifest = { ...identity, sessionId: transportSessionId };
    writeFileSync(manifest, JSON.stringify(savedManifest));
    const entry = (id, parentId, data) => ({ type: 'custom', customType: 'task-outcome/v1', id, parentId,
      data: { version: 1, eventId: 'event-' + id, jobId: identity.jobId, attemptId: identity.attemptId, ...data } });
    const contract = entry('contract', null, { kind: 'contract', contract: { ...identity, ownerSessionId: identity.sessionId,
      reportPath: identity.reportPath, reportIdentity: identity.reportIdentity } });
    const observe = entries => {
      writeFileSync(session, [JSON.stringify({ type: 'session', id: identity.sessionId }), ...entries.map(entry => JSON.stringify(entry))].join('\n') + '\n');
      publishMonitorReceipt(session, identity, entries, entries.at(-1).id);
      return readPiLifecycle(receipt);
    };
    const provisional = entry('provisional', 'contract', { kind: 'declaration', outcome: 'completed' });
    assert.equal(nonfinalPiOutcome(observe([contract, provisional])).status, 'active');
    assert.equal(readPiOutcome(receipt, { status: 'completed', source: 'model', summary: 'stale monitor final' }).status, 'active',
      'provisional declaration cannot be settled by monitor completion or report presence');
    const question = entry('question', 'provisional', { kind: 'outcome', outcome: 'needs_input', summary: 'Which allowed input?', source: 'model' });
    assert.equal(nonfinalPiOutcome(observe([contract, provisional, question])).status, 'needs_input');
    assert.equal(readPiOutcome(receipt).status, 'needs_input');
    const monitorFailure = { status: 'failed', source: 'transport', summary: 'monitor failure, drain unknown' };
    assert.equal(readPiOutcome(receipt, monitorFailure).lifecycle.state, 'unknown', 'monitor failure is not canonical loss or human input');
    const pause = entry('pause', 'question', { kind: 'context_pause', contextPause: { id: 'pause-id', reason: 'context limit', limit: 100 } });
    const paused = observe([contract, provisional, question, pause]);
    assert.equal(nonfinalPiOutcome(paused).status, 'interrupted');
    assert.equal(nonfinalPiOutcome(paused).lifecycle.pause_id, 'pause-id');
    assert.equal(readPiOutcome(receipt).lifecycle.pause_id, 'pause-id');
    assert.equal(readPiOutcome(receipt, { status: 'failed', source: 'protocol', summary: 'monitor protocol error' }).lifecycle.pause_id, 'pause-id');
    const resumed = entry('resume', 'pause', { kind: 'context_resume', contextPause: { id: 'pause-id' } });
    assert.equal(nonfinalPiOutcome(observe([contract, provisional, question, pause, resumed])).status, 'active');
    const maintenance = entry('maintenance', 'resume', { kind: 'maintenance_error', outcome: 'maintenance_error', summary: 'cleanup refused', maintenance: { maintenanceId: 'maintenance-id' } });
    assert.equal(nonfinalPiOutcome(observe([contract, provisional, question, pause, resumed, maintenance])).status, 'interrupted');
    const lost = entry('lost', 'maintenance', { kind: 'transport_lost', outcome: 'transport_lost', source: 'transport', summary: 'actual loss' });
    const loss = observe([contract, provisional, question, pause, resumed, maintenance, lost]);
    assert.equal(loss.payload.final, true);
    assert.equal(nonfinalPiOutcome(loss).status, 'interrupted', 'transport finality is not draft/background drain');
    assert.equal(readPiOutcome(receipt, monitorFailure).lifecycle.state, 'transport_lost', 'canonical loss remains distinct from monitor failure');
    // Deliberate new selected branch excludes the old absorbing loss, not historical rearming.
    const final = entry('final', 'contract', { kind: 'outcome', outcome: 'completed', source: 'model', summary: 'done' });
    assert.equal(nonfinalPiOutcome(observe([contract, final])), undefined);
    assert.equal(readPiOutcome(receipt, monitorFailure).status, 'completed', 'canonical MODEL final outranks stale monitor loss');
    assert.equal(readPiOutcome(receipt).text, reportText, 'final credit uses the reserved report inode');
    writeFileSync(reportPath, 'changed after settlement');
    const finalWithText = entry('final-with-text', 'contract', { kind: 'outcome', outcome: 'completed', source: 'model', summary: 'done', reportText });
    observe([contract, finalWithText]);
    assert.equal(readPiOutcome(receipt).source, 'protocol', 'a report changed after settled bytes cannot receive completion credit');
    writeFileSync(reportPath, reportText);
    // A deliberately corrupt manifest is interruption evidence, never a report-only fallback.
    writeFileSync(manifest, JSON.stringify({ ...savedManifest, attemptId: 'foreign-attempt' }));
    assert.equal(readPiOutcome(receipt, { status: 'completed', source: 'model', summary: 'old completion' }).lifecycle.state, 'unknown');
    writeFileSync(manifest, JSON.stringify(savedManifest));
    assert.throws(() => readPiLifecycle({ ...receipt, attempt_id: 'stale-attempt' }));
    assert.throws(() => readPiLifecycle({ ...receipt, report_file: '/different-report' }), /identity changed/);
    assert.throws(() => readPiLifecycle({ ...receipt, session_id: 'different-session' }), /identity changed/);
    writeFileSync(manifest, JSON.stringify(identity));
    assert.throws(() => readPiLifecycle(receipt), /identity changed/, 'Pi header ID cannot substitute for transport identity');
    writeFileSync(manifest, JSON.stringify(savedManifest));
    writeFileSync(session, [JSON.stringify({ type: 'session', id: transportSessionId }), JSON.stringify(contract), JSON.stringify(final)].join('\n') + '\n');
    assert.throws(() => readPiLifecycle(receipt), /monitor receipt identity/, 'transport identity cannot substitute for Pi header');
    const foreignContract = { ...contract, data: { ...contract.data, contract: { ...contract.data.contract, ownerSessionId: transportSessionId } } };
    assert.throws(() => observe([foreignContract, final]), /monitor contract identity/, 'contract ancestry binds to actual Pi session');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
