import { readFileSync } from 'node:fs';
import { readMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
import { readAttemptResult } from './core.mjs';

// One identity-bound observation for both live and readopted monitors. Notices/panes are not outcomes.
export function readPiLifecycle(receipt) {
  if (!receipt.session_file || !receipt.manifest_file) return undefined;
  const manifest = JSON.parse(readFileSync(receipt.manifest_file, 'utf8'));
  const sessionId = JSON.parse(readFileSync(receipt.session_file, 'utf8').split('\n')[0]).id;
  // Launcher/tmux session IDs are not Pi's actual session header ID. Bind both independently.
  if (manifest.jobId !== receipt.job || manifest.attemptId !== receipt.attempt_id || manifest.sessionId !== receipt.session_id ||
      manifest.mode !== 'task' || manifest.reportPath !== receipt.report_file) throw Error('saved manifest identity changed');
  return readMonitorReceipt(receipt.session_file, { sessionId, jobId: receipt.job, attemptId: receipt.attempt_id,
    mode: 'task', reportPath: receipt.report_file, reportIdentity: manifest.reportIdentity });
}

export function nonfinalPiOutcome(durable) {
  if (!durable || durable.state === 'final') return undefined;
  const lifecycle = { event: durable.eventId, entry: durable.entryId, state: durable.state,
    pause_id: durable.payload.pause_id, maintenance_id: durable.payload.maintenance_id };
  if (durable.payload.outcome === 'needs_input') return { status: 'needs_input', source: 'model', summary: durable.payload.summary, lifecycle };
  if (['context_paused', 'transport_lost'].includes(durable.state)) {
    return { status: 'interrupted', source: durable.payload.source, summary: durable.payload.summary, lifecycle };
  }
  return { status: 'active', lifecycle };
}

// Canonical selected-branch state outranks monitor notices; monitor failure alone proves no drain.
export function readPiOutcome(receipt, monitorFinal) {
  let durable;
  try { durable = readPiLifecycle(receipt); }
  catch (error) {
    if (error.code !== 'ENOENT') return { status: 'interrupted', source: 'protocol',
      summary: `invalid lifecycle evidence: ${String(error)}`,
      lifecycle: { event: `invalid-lifecycle:${receipt.attempt_id}`, state: 'unknown' } };
  }
  const fromFinal = (status, source, summary) => {
    if (status === 'failed' || source !== 'model') return { status: 'failed', source, summary };
    try {
      const result = readAttemptResult(receipt);
      return { status, source, summary, text: result.text, contextStopped: result.contextStopped };
    } catch (error) {
      return { status: 'failed', source: 'protocol', summary: `unreadable settled outcome: ${String(error)}` };
    }
  };
  if (durable?.state === 'final') {
    const { outcome, source, summary } = durable.payload;
    return fromFinal(['completed', 'blocked'].includes(outcome) ? outcome : 'failed', source, summary);
  }
  const nonfinal = nonfinalPiOutcome(durable);
  if (durable?.state === 'transport_lost') return nonfinal;
  if (monitorFinal?.source === 'transport') return { status: 'interrupted', source: 'transport', summary: monitorFinal.summary,
    lifecycle: { event: `monitor-failure:${receipt.attempt_id}`, state: 'unknown' } };
  // A provisional/input/context state cannot be closed by a stale or conflicting monitor completion.
  return nonfinal ?? (monitorFinal ? fromFinal(monitorFinal.status, monitorFinal.source, monitorFinal.summary) : undefined);
}
