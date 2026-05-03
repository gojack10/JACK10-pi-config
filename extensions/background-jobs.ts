import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BgJob {
  id: number;
  command: string;
  cwd: string;
  child: ChildProcess;
  pid: number | undefined;
  logPath: string;
  startedAt: number;
  exitCode: number | null | undefined;
  exitedAt: number | undefined;
  killed: boolean;
  errorMessage?: string;
}

const killJobTree = (job: BgJob): void => {
  if (job.pid === undefined) return;
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    if (job.exitCode !== undefined) return;
    try {
      process.kill(-job.pid!, "SIGKILL");
    } catch {}
  }, 2000);
};

export default function backgroundJobs(pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let nextJobId = 1;

  const liveJobs = () => [...jobs.values()].filter((j) => j.exitCode === undefined);

  const renderCompletionSummary = (): string => {
    const lines = [...jobs.values()].map((j) => {
      const elapsed = Math.round(((j.exitedAt ?? Date.now()) - j.startedAt) / 1000);
      let status: string;
      if (j.exitCode === -1) {
        status = `failed${j.errorMessage ? ` (${j.errorMessage})` : ""}`;
      } else if (j.exitCode !== undefined) {
        status = `exit ${j.exitCode}${j.killed ? " (killed)" : ""}`;
      } else {
        status = "running (unexpected)";
      }
      return `  job_${j.id}: [${status}] ${j.command.slice(0, 100)} (${elapsed}s)`;
    });
    return `SYSTEM (background-jobs): All background jobs finished:\n${lines.join("\n")}`;
  };

  const renderJobsList = (): string => {
    if (jobs.size === 0) return "(none)";
    return [...jobs.values()]
      .map((j) => {
        const elapsed = Math.round(((j.exitedAt ?? Date.now()) - j.startedAt) / 1000);
        const status =
          j.exitCode === undefined ? "running" : `exit ${j.exitCode}${j.killed ? " (killed)" : ""}`;
        return `  job_${j.id}: [${status}] ${j.command.slice(0, 100)} (${elapsed}s)`;
      })
      .join("\n");
  };

  // ============================================================
  // Tools
  // ============================================================

  pi.registerTool({
    name: "bash_bg",
    label: "bash_bg",
    description:
      "Spawn a long-running command in the background. Returns {job_id, log_path}. Do not poll/wait after starting a job; the agent will receive a follow-up message when all background jobs finish. Use bash_tail(job_id) only for occasional progress checks while doing other work, and bash_kill(job_id) to stop it.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command (runs through `sh -c`)." }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to session cwd." })),
    }),
    async execute(_id, { command, cwd }, _signal, _onUpdate, ctx) {
      const id = nextJobId++;
      const logPath = join(tmpdir(), `pi-bg-${Date.now()}-${id}.log`);
      const logStream = createWriteStream(logPath);
      const workingDir = cwd ?? ctx.cwd;
      const child = spawn("sh", ["-c", command], {
        cwd: workingDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const startedAt = Date.now();
      child.stdout?.on("data", (d) => logStream.write(d));
      child.stderr?.on("data", (d) => logStream.write(d));
      const job: BgJob = {
        id,
        command,
        cwd: workingDir,
        child,
        pid: child.pid,
        logPath,
        startedAt,
        exitCode: undefined,
        exitedAt: undefined,
        killed: false,
      };
      child.on("exit", (code) => {
        job.exitCode = code;
        job.exitedAt = Date.now();
        logStream.end();
        if (liveJobs().length === 0) {
          pi.sendUserMessage(renderCompletionSummary(), { deliverAs: "followUp" });
        }
      });
      child.on("error", (err) => {
        logStream.write(`\n[spawn error: ${err.message}]\n`);
        job.exitCode = -1;
        job.errorMessage = err.message;
        job.exitedAt = Date.now();
        logStream.end();
        if (liveJobs().length === 0) {
          pi.sendUserMessage(renderCompletionSummary(), { deliverAs: "followUp" });
        }
      });
      jobs.set(id, job);
      return {
        content: [
          {
            type: "text",
            text: `Started job_${id} (pid ${child.pid ?? "?"}).\nLog: ${logPath}\nCommand: ${command}\n\nIMPORTANT NEXT STEP: If you are only waiting for this command, stop now and send the user a brief response. Do NOT call bash_tail(), bash_jobs(), sleep, or any polling/wait command. This extension will send you a follow-up message when all background jobs finish. Only use bash_tail() for occasional progress checks while doing other independent work.`, 
          },
        ],
        details: { job_id: id, log_path: logPath, pid: child.pid },
      };
    },
  });

  pi.registerTool({
    name: "bash_tail",
    label: "bash_tail",
    description:
      "Peek the last N lines of a background job's stdout+stderr. Non-blocking. Returns alive=true while running, exit_code when finished.",
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
    async execute(_id, { job_id, lines }) {
      const job = jobs.get(job_id);
      if (!job) {
        return {
          content: [{ type: "text", text: `ERROR: no job with id ${job_id}. Call bash_jobs() to list.` }],
          isError: true,
        };
      }
      const n = Math.min(Math.max(lines ?? 50, 1), 500);
      let tail = "";
      if (existsSync(job.logPath)) {
        const contents = readFileSync(job.logPath, "utf-8");
        const all = contents.split("\n");
        tail = all.slice(-n).join("\n");
      }
      const alive = job.exitCode === undefined;
      const elapsedMs = (job.exitedAt ?? Date.now()) - job.startedAt;
      const elapsed = Math.round(elapsedMs / 1000);
      const status = alive
        ? `RUNNING (${elapsed}s elapsed)`
        : `EXITED code=${job.exitCode}${job.killed ? " (killed)" : ""} (${elapsed}s total)`;
      return {
        content: [
          {
            type: "text",
            text: `job_${job_id}: ${status}\n--- last ${n} line${n === 1 ? "" : "s"} ---\n${tail || "(empty)"}`,
          },
        ],
        details: { job_id, alive, exit_code: job.exitCode ?? null, elapsed_ms: elapsedMs },
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
    async execute(_id, { job_id }) {
      const job = jobs.get(job_id);
      if (!job) {
        return {
          content: [{ type: "text", text: `ERROR: no job with id ${job_id}.` }],
          isError: true,
        };
      }
      if (job.exitCode !== undefined) {
        return { content: [{ type: "text", text: `job_${job_id} already exited (code ${job.exitCode}).` }] };
      }
      job.killed = true;
      killJobTree(job);
      return { content: [{ type: "text", text: `Sent SIGTERM to job_${job_id} (pid ${job.pid ?? "?"}).` }] };
    },
  });

  pi.registerTool({
    name: "bash_jobs",
    label: "bash_jobs",
    description: "List background jobs (live and recently exited).",
    parameters: Type.Object({}),
    async execute() {
      if (jobs.size === 0) return { content: [{ type: "text", text: "No background jobs." }] };
      return {
        content: [
          {
            type: "text",
            text: renderJobsList(),
          },
        ],
        details: { jobs: [...jobs.values()].map((j) => ({ id: j.id, command: j.command, pid: j.pid, exit_code: j.exitCode, killed: j.killed })) },
      };
    },
  });

  // ============================================================
  // Events
  // ============================================================

  pi.on("session_shutdown", async () => {
    for (const job of jobs.values()) {
      if (job.exitCode === undefined) killJobTree(job);
    }
  });
}
