#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDispatcherReport } from './parallel-core.mjs';

// Claude Code Stop/StopFailure hook for parallel-factory dispatchers. Registered only through the
// per-run --settings file, and inert unless the controller set FACTORY_PARALLEL_ATTEMPT_DIR.
const dir = process.env.FACTORY_PARALLEL_ATTEMPT_DIR, report = process.env.FACTORY_PARALLEL_REPORT;
const mark = (name, value) => {
  const path = join(dir, name);
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n');
  renameSync(`${path}.tmp`, path);
};

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    if (!dir || !report) return;
    const input = JSON.parse(raw || '{}');
    const identity = { session_id: input.session_id, transcript_path: input.transcript_path };
    if (input.hook_event_name === 'StopFailure') {
      mark('claude-failure.json', { ...identity, error: input.error, message: input.last_assistant_message });
      return;
    }
    if (input.hook_event_name !== 'Stop') return;
    let error;
    try { validateDispatcherReport(readFileSync(report, 'utf8')); } catch (failure) { error = failure.message; }
    if (!error) { mark('claude-stop.json', { ...identity, valid: true }); return; }
    if (!input.stop_hook_active) {
      // One reminder, like Pi's task contract: the controller needs the report file, not prose.
      process.stdout.write(JSON.stringify({ decision: 'block', reason:
        `Factory controller: REPORT ${report} is not a valid dispatcher report yet (${error}). Finish the Dispatcher Role steps, write the report in place, then end your turn. No human is available in this session.` }));
      return;
    }
    mark('claude-stop.json', { ...identity, valid: false, error });
  } catch {
    // A hook failure must never wedge the session; the controller's liveness check still applies.
  }
});
