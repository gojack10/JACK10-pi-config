import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundJobManager } from '../background-jobs/manager.ts';
import { SubagentLauncher } from '../subagent-launch/manager.ts';
import { readMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
import { ROUTE, runLoop, save, mission } from './core.mjs';

export default function (pi: ExtensionAPI) {
  // The controller has no model turns. All reasoning belongs to the sequential workers.
  pi.on('input', () => ({ action: 'handled' as const }));
  pi.registerCommand('factory-run', {
    description: 'Run the deterministic factory controller (programmatic entry only)',
    handler: async (directory, ctx) => {
      const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
      const notices: string[] = [];
      let wake = () => {};
      const notify = (text: string) => { notices.push(text); wake(); };
      const transportPi = new Proxy(pi, { get: (target, key) => key === 'sendUserMessage' ? notify : Reflect.get(target, key) });
      const background = new BackgroundJobManager(notify);
      const launcher = new SubagentLauncher(transportPi, ctx, background);
      let safe = true;
      try {
        await runLoop({ directory, smoke: config.smoke,
          runStep: async ({ step, role, reportPath, previous, task }) => {
            if (existsSync(join(directory, 'STOP'))) throw Error('stop requested');
            const missionPath = join(directory, `${step}-${role}.md`);
            writeFileSync(missionPath, mission({ role, reportPath, previous, task, smoke: config.smoke, directory, contract: config.contract }));
            const policyFile = join(directory, `${step}-policy.ts`);
            const policy = { smoke: config.smoke, report: reportPath, reads: [join(directory, 'fixture.txt'), ...(previous ? [previous] : [])] };
            writeFileSync(policyFile, `import { installGuard } from ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), 'guard.ts'))};\nexport default pi => installGuard(pi, ${JSON.stringify(policy)});\n`);
            safe = false; // A crash or ambiguous launch must leave the global lock in place.
            const launched = await launcher.launch([{ ...ROUTE, mode: 'task', cwd: config.cwd,
              session_label: `bf2-${role}-${step}`, mission_file: missionPath, report_file: reportPath,
              extension_files: [policyFile] }]);
            const receipt = launched.jobs[0];
            save(join(directory, `${step}-launch.json`), launched);
            save(join(directory, 'active.json'), { step, role, receipt });
            if (!['running', 'start_timeout'].includes(receipt.status)) throw Error(`launch failed: ${JSON.stringify(receipt)}`);
            // Completion notification is event-driven; no model or pane-text polling.
            await new Promise<void>((resolve, reject) => {
              const inspect = () => {
                const result = background.getReport(launched.batch_id);
                if (result) { clearTimeout(timer); wake = () => {}; resolve(); return; }
                const notice = notices.find(n => /paused for context|needs input|maintenance error|human maintenance/.test(n));
                if (notice) { clearTimeout(timer); wake = () => {}; reject(Error(notice)); }
              };
              const timer = setTimeout(() => { wake = () => {}; reject(Error('attempt deadline reached; child retained, no successor launched')); }, config.smoke ? 300000 : 7200000);
              wake = inspect;
              inspect();
            });
            const batch = background.getReport(launched.batch_id)!;
            save(join(directory, `${step}-batch.json`), batch);
            const final = batch.completions[0];
            if (batch.completions.length !== 1 || final.id !== receipt.job || final.status !== 'completed' || final.source !== 'model') throw Error(`non-successful attempt: ${JSON.stringify(batch)}`);
            const manifest = JSON.parse(readFileSync(receipt.manifest_file!, 'utf8'));
            const markers = readFileSync(receipt.monitor_log!, 'utf8').trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
            const marker = markers.find(m => m.kind === 'final' && m.jobId === receipt.job && m.attemptId === receipt.attempt_id);
            if (!marker?.sessionId || !marker.sessionFile) throw Error('missing durable final identity');
            const durable = readMonitorReceipt(marker.sessionFile, { sessionId: marker.sessionId, jobId: receipt.job,
              attemptId: receipt.attempt_id, mode: 'task', reportPath, reportIdentity: manifest.reportIdentity });
            if (durable.state !== 'final' || durable.payload.outcome !== 'completed') throw Error('durable task is not completed');
            save(join(directory, `${step}-outcome.json`), durable);
            // Close only this completed factory pane; a new turn cannot race the successor.
            const closed = await pi.exec('tmux', ['kill-session', '-t', receipt.session_label]);
            if (closed.code !== 0) throw Error(`cannot close completed worker: ${closed.stderr}`);
            safe = true;
            appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ step, role, event: 'verified_completed', at: Date.now(), job: receipt.job }) + '\n');
            return { text: readFileSync(reportPath, 'utf8'), receipt };
          } });
      } catch (error) {
        save(join(directory, 'error.json'), { error: String(error), safe, notices });
        throw error;
      } finally {
        if (safe) { background.shutdown(); writeFileSync(join(directory, 'QUIESCENT'), 'No active factory worker remains.\n'); }
      }
    },
  });
}
