import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BackgroundJobManager } from '../background-jobs/manager.ts';
import { SubagentLauncher } from '../subagent-launch/manager.ts';
import { readMonitorReceipt } from '../task-outcomes/monitor-receipt.mjs';
import { readAttemptResult } from './core.mjs';
import { ParallelController, save } from './parallel-controller.mjs';
import { closeIdleWatches } from './watch.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SIFTTEXT = join(homedir(), '.local/bin/sifttext');
const CLAUDE = join(homedir(), '.local/bin/claude');
// One pre-trusted, otherwise empty directory: dispatchers load no project memory or CLAUDE.md from it.
export const CLAUDE_CWD = join(homedir(), '.pi/agent/factory-runs/parallel/claude-dispatcher');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const PAUSED = /paused for context|needs input|maintenance error|human maintenance/;

const tmux = async (args: string[]) => {
  try { return { code: 0, stdout: (await exec('tmux', args)).stdout }; }
  catch (error) { return { code: 1, stdout: String((error as { stdout?: string }).stdout ?? ''), error }; }
};
const sql = async (query: string) => JSON.parse((await exec(SIFTTEXT, ['sql', `query=${query}`], { maxBuffer: 16 * 1024 * 1024 })).stdout);
const idList = (ids: string[]) => {
  if (!ids.every(id => /^[0-9a-f-]{36}$/.test(id))) throw Error('invalid node id');
  return ids.map(id => `'${id}'`).join(',');
};

export default function (pi: ExtensionAPI) {
  // The controller has no model turns. All reasoning belongs to dispatcher and worker sessions.
  pi.on('input', () => ({ action: 'handled' as const }));
  pi.registerCommand('factory-parallel', {
    description: 'Run the deterministic parallel factory controller (programmatic entry only)',
    handler: async (argument, ctx) => {
      const directory = argument.trim();
      const notices: string[] = [];
      const notify = (text: unknown) => { notices.push(String(text)); if (notices.length > 1000) notices.shift(); };
      const transportPi = new Proxy(pi, { get: (target, key) => key === 'sendUserMessage' ? notify : Reflect.get(target, key) });
      const background = new BackgroundJobManager(notify);
      const launcher = new SubagentLauncher(transportPi, ctx, background);
      const own = new Set<string>();
      // Launches paste through tmux's shared buffer: never interleave two.
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>) => {
        const next = chain.then(fn, fn);
        chain = next.catch(() => {});
        return next;
      };
      const settings = join(directory, 'claude-settings.json');
      const hook = `${quote(process.execPath)} ${quote(join(here, 'parallel-hook.mjs'))}`;
      save(settings, { hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 30 }] }],
        StopFailure: [{ hooks: [{ type: 'command', command: hook, timeout: 30 }] }],
      } });

      const fromFinal = (receipt: any, status: string, source: string, summary: string) => {
        if (status === 'failed' || source !== 'model') return { status: 'failed', source, summary };
        try {
          const result = readAttemptResult(receipt);
          return { status, source, summary, text: result.text, contextStopped: result.contextStopped };
        } catch (error) {
          return { status: 'failed', source: 'protocol', summary: `unreadable settled outcome: ${String(error)}` };
        }
      };
      const sessionFile = async (receipt: any) => {
        if (receipt.session_file || !receipt.pane_id) return;
        const shown = await tmux(['show-options', '-p', '-v', '-t', receipt.pane_id, '@pi_session_file']);
        if (shown.code === 0 && shown.stdout.trim()) receipt.session_file = shown.stdout.trim();
      };

      const deps = {
        now: () => Date.now(),
        sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        writePolicy: (dir: string, policy: unknown) => {
          const path = join(dir, 'policy.ts');
          writeFileSync(path, `import { installParallelGuard } from ${JSON.stringify(join(here, 'parallel-guard.ts'))};\nexport default pi => installParallelGuard(pi, ${JSON.stringify(policy)});\n`);
          return path;
        },
        launchPi: ({ label, route, missionFile, reportFile, extensionFiles, cwd }: any) => serial(async () => {
          const launched = await launcher.launch([{ ...route, mode: 'task', cwd, session_label: label, mission_file: missionFile,
            report_file: reportFile, extension_files: extensionFiles, pause_on_interrupt: false }]);
          own.add(launched.batch_id);
          return { ...launched.jobs[0], batch_id: launched.batch_id };
        }),
        piOutcome: async (receipt: any) => {
          await sessionFile(receipt);
          if (own.has(receipt.batch_id)) {
            const final = background.getReport(receipt.batch_id)?.completions?.[0];
            if (final) return fromFinal(receipt, final.status, final.source, final.summary);
            const notice = notices.find(text => text.includes(receipt.job) && PAUSED.test(text));
            return notice ? { status: 'failed', source: 'technical', summary: notice } : undefined;
          }
          // After a controller restart the in-process monitor is gone; read the worker's durable receipt.
          if (!receipt.session_file || !receipt.manifest_file) return undefined;
          try {
            const manifest = JSON.parse(readFileSync(receipt.manifest_file, 'utf8'));
            const sessionId = JSON.parse(readFileSync(receipt.session_file, 'utf8').split('\n')[0]).id;
            const durable = readMonitorReceipt(receipt.session_file, { sessionId, jobId: receipt.job, attemptId: receipt.attempt_id,
              mode: 'task', reportPath: receipt.report_file, reportIdentity: manifest.reportIdentity });
            if (['final', 'transport_lost'].includes(durable.state)) {
              const outcome = durable.payload.outcome;
              return fromFinal(receipt, ['completed', 'blocked'].includes(outcome) ? outcome : 'failed', durable.payload.source, durable.payload.summary);
            }
            if (durable.state === 'context_paused') return { status: 'failed', source: 'technical', summary: `paused: ${durable.payload.summary}` };
          } catch {}
          return undefined;
        },
        sessionAlive: async (label: string) => (await tmux(['has-session', '-t', `=${label}`])).code === 0,
        killSession: async (label: string) => { await tmux(['kill-session', '-t', `=${label}`]); },
        killSessionsWithPrefix: async (prefix: string) => {
          const listed = await tmux(['list-sessions', '-F', '#{session_name}']);
          for (const name of listed.stdout.split('\n').filter(name => name.startsWith(prefix))) await tmux(['kill-session', '-t', `=${name}`]);
        },
        sendToPane: async (label: string, text: string) => {
          await tmux(['send-keys', '-t', `=${label}:`, '-l', text]);
          await tmux(['send-keys', '-t', `=${label}:`, 'Enter']);
        },
        launchClaude: async ({ label, model, effort, promptFile, sessionId, attemptDir, report }: any) => {
          const boot = join(attemptDir, 'claude-boot.sh');
          writeFileSync(boot, [
            `cd ${quote(CLAUDE_CWD)} || exit 1`,
            `export PATH=${quote(join(homedir(), '.local/bin'))}:"$PATH"`,
            'unset SIFTWORKS_SEAT PI_SUBAGENT_MANIFEST',
            `export FACTORY_PARALLEL_ATTEMPT_DIR=${quote(attemptDir)} FACTORY_PARALLEL_REPORT=${quote(report)}`,
            `exec ${quote(CLAUDE)} --model ${quote(model)} --effort ${quote(effort)} --dangerously-skip-permissions --session-id ${quote(sessionId)} --settings ${quote(settings)} "$(cat ${quote(promptFile)})"`,
          ].join('\n') + '\n');
          const started = await tmux(['new-session', '-d', '-s', label, '-x', '220', '-y', '60', '-c', CLAUDE_CWD, `/bin/zsh -f ${quote(boot)}`]);
          if (started.code !== 0) throw Error(`tmux could not start ${label}: ${String(started.error)}`);
          return { transcript: join(homedir(), '.claude/projects', CLAUDE_CWD.replace(/[/.]/g, '-'), `${sessionId}.jsonl`) };
        },
        fence: async (repos: string[]) => Promise.all(repos.map(async repo => ({
          repo,
          head: (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(),
          porcelain: (await exec('git', ['-C', repo, 'status', '--porcelain'])).stdout,
        }))),
        ancestors: async (ids: string[]) => {
          const rows = await sql(`WITH RECURSIVE a(start_id, id, parent_id, depth) AS (SELECT id, id, parent_id, 0 FROM nodes WHERE id IN (${idList(ids)}) UNION ALL SELECT a.start_id, n.id, n.parent_id, a.depth + 1 FROM nodes n JOIN a ON n.id = a.parent_id WHERE a.depth < 64) SELECT start_id, id, depth FROM a ORDER BY start_id, depth`);
          const map = new Map<string, string[]>();
          for (const row of rows) map.set(row.start_id, [...(map.get(row.start_id) ?? []), row.id]);
          return map;
        },
        statuses: async (ids: string[]) => new Map((await sql(`SELECT id, status FROM nodes WHERE id IN (${idList(ids)})`)).map((row: any) => [row.id, row.status])),
      };

      const controller = new ParallelController(directory, deps);
      try {
        const status = await controller.run();
        save(join(directory, 'finished.json'), { ok: true, status, at: new Date().toISOString() });
      } finally {
        background.shutdown();
        closeIdleWatches();
        if (!existsSync(join(directory, 'finished.json'))) save(join(directory, 'finished.json'), { ok: false, at: new Date().toISOString() });
      }
    },
  });
}
