import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundJobManager } from '../background-jobs/manager.ts';
import { SubagentLauncher } from '../subagent-launch/manager.ts';
import { readMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
import { taskSettings, runLoop, save, mission } from './core.mjs';

export default function (pi: ExtensionAPI) {
  // The controller has no model turns. All reasoning belongs to the sequential workers.
  pi.on('input', () => ({ action: 'handled' as const }));
  pi.registerCommand('factory-run', {
    description: 'Run the deterministic factory controller (programmatic entry only)',
    handler: async (directory, ctx) => {
      const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
      const project = config.project ?? taskSettings();
      const resume = config.resume;
      if (resume) { delete config.resume; save(join(directory, 'config.json'), config); }
      const notices: string[] = [];
      let wake = () => {};
      const notify = (text: string) => { notices.push(text); wake(); };
      const transportPi = new Proxy(pi, { get: (target, key) => key === 'sendUserMessage' ? notify : Reflect.get(target, key) });
      const background = new BackgroundJobManager(notify);
      const launcher = new SubagentLauncher(transportPi, ctx, background);
      let safe = true;
      try {
        await runLoop({ directory, smoke: config.smoke, project, resume,
          runStep: async ({ step, role, reportPath, previous, task }) => {
            if (existsSync(join(directory, 'STOP'))) throw Error('stop requested');
            const missionPath = join(directory, `${step}-${role}.md`);
            writeFileSync(missionPath, mission({ role, reportPath, previous, task, smoke: config.smoke, directory, contract: config.contract, project }));
            const extensionFiles: string[] = [];
            if (config.smoke || project.name === 'bf2') {
              const policyFile = join(directory, `${step}-policy.ts`);
              const policy = { smoke: config.smoke, route: project.route, report: reportPath,
                reads: [join(directory, 'fixture.txt'), ...(previous ? [previous] : [])] };
              writeFileSync(policyFile, `import { installGuard } from ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), 'guard.ts'))};\nexport default pi => installGuard(pi, ${JSON.stringify(policy)});\n`);
              extensionFiles.push(policyFile);
            }
            safe = false; // A crash or ambiguous launch must retain this task's lock.
            const launched = await launcher.launch([{ ...project.route, mode: 'task', cwd: config.cwd,
              session_label: `${project.name}-${role}-${step}`, mission_file: missionPath, report_file: reportPath,
              extension_files: extensionFiles, pause_on_interrupt: true }]);
            const receipt = launched.jobs[0];
            save(join(directory, `${step}-launch.json`), launched);
            save(join(directory, 'active.json'), { step, role, receipt });
            if (!['running', 'start_timeout'].includes(receipt.status)) throw Error(`launch failed: ${JSON.stringify(receipt)}`);
            // Completion notification is event-driven; no model or pane-text polling.
            await new Promise<void>((resolve, reject) => {
              let timer: NodeJS.Timeout | undefined;
              const done = () => { if (timer) clearTimeout(timer); wake = () => {}; };
              const inspect = () => {
                const result = background.getReport(launched.batch_id);
                if (result) { done(); resolve(); return; }
                const notice = notices.find(n => /paused for context|needs input|maintenance error|human maintenance/.test(n));
                if (notice) { done(); reject(Error(notice)); }
              };
              // Real work waits for its durable outcome. Per-command limits and explicit stop/abort own intervention.
              if (config.smoke) timer = setTimeout(() => { done(); reject(Error('smoke attempt deadline reached')); }, 300000);
              wake = inspect;
              inspect();
            });
            const batch = background.getReport(launched.batch_id)!;
            save(join(directory, `${step}-batch.json`), batch);
            const final = batch.completions[0];
            if (batch.completions.length !== 1 || final.id !== receipt.job || final.status !== 'completed' || final.source !== 'model') {
              // Escape/technical failure permanently closes report_outcome for this attempt. Pause cleanly;
              // never leave a pane that looks resumable but has no active task contract.
              const closed = await pi.exec('tmux', ['kill-session', '-t', receipt.session_label]);
              if (closed.code !== 0) {
                const stillThere = await pi.exec('tmux', ['has-session', '-t', `=${receipt.session_label}`]);
                if (stillThere.code === 0) throw Error(`cannot close interrupted worker: ${closed.stderr}`);
              }
              safe = true;
              const paused = Error(`factory paused after interrupted attempt: ${JSON.stringify(batch)}`) as Error & { factoryPaused?: boolean };
              paused.factoryPaused = true;
              throw paused;
            }
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
        const prior = existsSync(join(directory, 'state.json'))
          ? JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')) : {};
        const paused = !!(error as { factoryPaused?: boolean }).factoryPaused;
        save(join(directory, 'state.json'), { ...prior, status: paused ? 'paused' : 'error', error: String(error) });
        save(join(directory, paused ? 'paused.json' : 'error.json'), { error: String(error), safe, notices });
        throw error;
      } finally {
        if (safe) { background.shutdown(); writeFileSync(join(directory, 'QUIESCENT'), 'No active factory worker remains.\n'); }
      }
    },
  });
}
