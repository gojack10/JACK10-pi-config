import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getBackgroundJobManager,
  releaseBackgroundJobManager,
} from "./background-jobs/manager.ts";

export default function backgroundJobs(pi: ExtensionAPI) {
  // ============================================================
  // Tools
  // ============================================================

  pi.registerTool({
    name: "bash_bg",
    label: "bash_bg",
    description:
      "Spawn a background command. Returns {job_id, log_path}. Give it a short task label. All overlapping jobs form one batch: one automatic steering notification when ALL jobs finish, at the next tool-call boundary if busy, or waking the agent if idle. New overlapping jobs extend the wait. Do independent work or end your turn; NEVER poll or wait for completion. Inspect running jobs only if the user explicitly asks for progress/ETA. Read completed logs to consume results; use bash_kill to stop a job.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command (runs through `sh -c`)." }),
      label: Type.Optional(Type.String({ description: "Short task name, e.g. 'Run tests' or 'Queue probe', not shell code.", minLength: 1, maxLength: 80 })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to session cwd." })),
    }),
    async execute(_id, { command, cwd, label }, _signal, _onUpdate, ctx) {
      const result = getBackgroundJobManager(pi, ctx).start({ command, cwd: cwd ?? ctx.cwd, label });
      const { job, runningJobs } = result;
      return {
        content: [
          {
            type: "text",
            text: `Started job_${job.id} (${job.label}, pid ${job.pid ?? "?"}).\nLog: ${job.logPath}\nCommand: ${command}\n\n${runningJobs === 1 ? "1 job running; it will notify automatically when done." : `${runningJobs} jobs running; completed results are held until ALL finish, then sent in ONE steering notification.`} New overlapping jobs extend the wait.\nDo independent work if available; otherwise end your turn now. Do NOT poll with bash_tail, bash_jobs, bash, sleep, or wait just to check completion. Automatic notification will resume you. Only inspect running jobs if the user explicitly asks for progress/ETA; never repeatedly poll. Reading completed logs to consume results is allowed.`,
          },
        ],
        details: { job_id: job.id, log_path: job.logPath, pid: job.pid, label: job.label, running_jobs: runningJobs },
      };
    },
  });

  pi.registerTool({
    name: "bash_tail",
    label: "bash_tail",
    description:
      "Read the last N lines of a job's log, capped at 50 KiB. Use to consume completed results, or inspect running progress/ETA ONLY when the user explicitly asks. Never poll for completion: an automatic batch notification will resume you. Returns alive=true while output is still being collected.",
    parameters: Type.Object({
      job_id: Type.Integer(),
      lines: Type.Optional(
        Type.Integer({
          description: "Number of trailing lines. Default 50, max 500.",
          minimum: 1,
          maximum: 500,
        }),
      ),
    }),
    async execute(_id, { job_id, lines }, _signal, _onUpdate, ctx) {
      const result = await getBackgroundJobManager(pi, ctx).tail(job_id, lines);
      if (!result) {
        return {
          content: [{ type: "text", text: `ERROR: no job with id ${job_id}. Call bash_jobs() to list.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: { job_id, alive: result.alive, exit_code: result.exitCode, elapsed_ms: result.elapsedMs },
      };
    },
  });

  pi.registerTool({
    name: "bash_kill",
    label: "bash_kill",
    description: "Terminate a background job (SIGTERM, then SIGKILL after 2s if still alive).",
    parameters: Type.Object({
      job_id: Type.Integer(),
    }),
    async execute(_id, { job_id }, _signal, _onUpdate, ctx) {
      const result = getBackgroundJobManager(pi, ctx).kill(job_id);
      if (result.kind === "missing") {
        return {
          content: [{ type: "text", text: `ERROR: no job with id ${job_id}.` }],
          isError: true,
        };
      }
      if (result.kind === "already-exited") {
        return { content: [{ type: "text", text: `job_${job_id} already exited (code ${result.exitCode}).` }] };
      }
      return { content: [{ type: "text", text: `Sent SIGTERM to job_${job_id} (pid ${result.pid ?? "?"}).` }] };
    },
  });

  pi.registerTool({
    name: "bash_jobs",
    label: "bash_jobs",
    description: "List background jobs when the user explicitly asks for progress/ETA, or to find completed results. Never poll for completion; all overlapping jobs produce one automatic notification when done.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, ctx) {
      const result = getBackgroundJobManager(pi, ctx).list();
      if (result.details.length === 0) return { content: [{ type: "text", text: result.text }] };
      return {
        content: [{ type: "text", text: result.text }],
        details: { jobs: result.details },
      };
    },
  });

  // ============================================================
  // Events
  // ============================================================

  // Task outcomes owns both parking and atomic task/background adoption.

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "maintenance" && event.maintenance) return;
    releaseBackgroundJobManager(ctx);
  });
}
