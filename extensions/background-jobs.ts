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
      "Start a labeled background command and return its job_id and log_path.\n\nOverlapping jobs form one batch, so each new overlapping job delays its single steering notification until it finishes. That notification resumes an idle agent or arrives at a busy agent's next tool-call boundary.\n\nWhile the batch runs, do independent work or end your turn without waiting or polling. Inspect running jobs only if the user explicitly asks for progress or an ETA, and read completed logs after the notification.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command (runs through `sh -c`)." }),
      label: Type.Optional(Type.String({ description: "Short task name, e.g. 'Run tests' or 'Queue probe', not shell code.", minLength: 1, maxLength: 80 })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to session cwd." })),
    }),
    async execute(_id, { command, cwd, label }, _signal, _onUpdate, ctx) {
      const result = getBackgroundJobManager(pi, ctx).start({ command, cwd: cwd ?? ctx.cwd, label, suggestForeground: true });
      const { job, runningJobs } = result;
      return {
        content: [
          {
            type: "text",
            text: `Started job_${job.id} (${job.label}, pid ${job.pid ?? "?"}).\nLog: ${job.logPath}\nCommand: ${command}\n\n${runningJobs === 1 ? "1 job is running" : `${runningJobs} jobs are running`} in a batch that sends one steering notification when all jobs finish. New overlapping jobs join this batch and delay its notification until they finish.\n\nWhile the batch runs, do independent work or end your turn without waiting or polling through any tool or shell command. Inspect running jobs only if the user explicitly asks for progress or an ETA, and read completed logs after the notification.`,
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
      "Read a completed log after the batch notification, or inspect a running job when the user explicitly asks for progress or an ETA. Do not poll for completion.\n\nReturns the last N lines, up to 50 KiB, with alive=true while output is still being collected.",
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
    description: "List jobs to find completed results or answer the user's request for progress or an ETA. Do not poll for completion. The batch notification arrives after all overlapping jobs finish.",
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

  pi.on("session_shutdown", (_event, ctx) => {
    releaseBackgroundJobManager(ctx);
  });
}
