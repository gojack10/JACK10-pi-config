// Deterministic child receipt writer for the live-maintenance integration test.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publishMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
const { SessionManager } = await import(pathToFileURL(join(homedir(), '.local/share/pi-mono/packages/coding-agent/dist/index.js')));
const [manifestPath, file] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: manifest.sessionId,
  cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n');
const sm = SessionManager.open(file);
sm.appendMessage({ role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() });
const identity = { sessionId: manifest.sessionId, jobId: manifest.jobId, attemptId: manifest.attemptId,
  mode: manifest.mode, reportPath: manifest.reportPath, reportIdentity: manifest.reportIdentity };
sm.appendCustomEntry('task-outcome/v1', { version: 1, eventId: 'child-contract', kind: 'contract',
  contract: { ...identity, ownerSessionId: identity.sessionId, state: 'active', childJobIds: [] } });
writeFileSync(manifest.reportPath, 'live maintenance report\n');
sm.appendCustomEntry('task-outcome/v1', { version: 1, eventId: 'child-final', kind: 'outcome',
  jobId: identity.jobId, attemptId: identity.attemptId, outcome: 'completed', source: 'model',
  summary: 'live maintenance report', final: true });
publishMonitorReceipt(file, identity, sm.getBranch(), sm.getLeafId());
