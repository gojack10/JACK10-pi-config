import { DEFAULT_MAX_BYTES, truncateTail, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BgJob {
  id: number;
  command: string;
  label: string;
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
    if (job.exitedAt !== undefined) return;
    try {
      process.kill(-job.pid!, "SIGKILL");
    } catch {}
  }, 2000);
};

export default function backgroundJobs(pi: ExtensionAPI) {
  const jobs = new Map<number, BgJob>();
  let nextJobId = 1;
  const pending: BgJob[] = [];
  let shuttingDown = false;

  const runningCount = () => [...jobs.values()].filter(j => j.exitedAt === undefined).length;
  const flushCompletions = () => {
    // ponytail: one session-wide batch; use explicit groups if long-lived jobs need isolation.
    if (shuttingDown || !pending.length || runningCount()) return;
    const batch = pending.splice(0);
    pi.sendUserMessage(
      `SYSTEM (background-jobs): All ${batch.length} background job(s) in this batch finished.\n${batch.map(renderCompletionSummary).join("\n")}`,
      { deliverAs: "steer" },
    );
  };

  const renderCompletionSummary = (job: BgJob): string => {
    const elapsed = Math.round(((job.exitedAt ?? Date.now()) - job.startedAt) / 1000);
    const status = job.exitCode === -1
      ? `failed${job.errorMessage ? ` (${job.errorMessage})` : ""}`
      : `exit ${job.exitCode}${job.killed ? " (killed)" : ""}`;
    return `job_${job.id} (${job.label}): [${status}] (${elapsed}s). Log: ${job.logPath}`;
  };

  const renderJobsList = (): string => {
    if (jobs.size === 0) return "(none)";
    return [...jobs.values()]
      .map((j) => {
        const elapsed = Math.round(((j.exitedAt ?? Date.now()) - j.startedAt) / 1000);
        const status =
          j.exitedAt === undefined ? "running (collecting output)" : `exit ${j.exitCode}${j.killed ? " (killed)" : ""}`;
        return `  job_${j.id}: [${status}] ${j.label} (${elapsed}s)`;
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
      "Spawn a background command. Returns {job_id, log_path}. Give it a short task label. All overlapping jobs form one batch: one automatic steering notification when ALL jobs finish, at the next tool-call boundary if busy, or waking the agent if idle. New overlapping jobs extend the wait. Do independent work or end your turn; NEVER poll or wait for completion. Inspect running jobs only if the user explicitly asks for progress/ETA. Read completed logs to consume results; use bash_kill to stop a job.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command (runs through `sh -c`)." }),
      label: Type.Optional(Type.String({ description: "Short task name, e.g. 'Run tests' or 'Queue probe', not shell code.", minLength: 1, maxLength: 80 })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to session cwd." })),
    }),
    async execute(_id, { command, cwd, label }, _signal, _onUpdate, ctx) {
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
      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });
      const job: BgJob = {
        id,
        command,
        label: (label?.trim() || command.split("\n").find(line => line.trim()) || "background job")
          .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 80),
        cwd: workingDir,
        child,
        pid: child.pid,
        logPath,
        startedAt,
        exitCode: undefined,
        exitedAt: undefined,
        killed: false,
      };
      const finish = () => {
        if (job.exitedAt !== undefined) return;
        job.exitedAt = Date.now();
        if (!shuttingDown) { pending.push(job); flushCompletions(); }
      };
      let closed = false;
      logStream.on("error", err => {
        job.exitCode = -1;
        job.errorMessage = `log write failed: ${err.message}`;
        if (closed) finish(); else killJobTree(job);
      });
      child.on("exit", code => { job.exitCode ??= code; });
      child.on("error", err => {
        job.exitCode = -1;
        job.errorMessage = err.message;
        if (!logStream.destroyed) logStream.write(`\n[spawn error: ${err.message}]\n`);
      });
      child.on("close", () => {
        closed = true;
        // exit can precede descendant stdout. Notify only after stdio closes and the log flushes.
        if (logStream.destroyed) finish(); else logStream.end(finish);
      });
      jobs.set(id, job);
      const running = runningCount();
      return {
        content: [
          {
            type: "text",
            text: `Started job_${id} (${job.label}, pid ${child.pid ?? "?"}).\nLog: ${logPath}\nCommand: ${command}\n\n${running === 1 ? "1 job running; it will notify automatically when done." : `${running} jobs running; completed results are held until ALL finish, then sent in ONE steering notification.`} New overlapping jobs extend the wait.\nDo independent work if available; otherwise end your turn now. Do NOT poll with bash_tail, bash_jobs, bash, sleep, or wait just to check completion. Automatic notification will resume you. Only inspect running jobs if the user explicitly asks for progress/ETA; never repeatedly poll. Reading completed logs to consume results is allowed.`,
          },
        ],
        details: { job_id: id, log_path: logPath, pid: child.pid, label: job.label, running_jobs: running },
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
      try {
        const file = await open(job.logPath, "r");
        try {
          const { size } = await file.stat();
          const offset = Math.max(0, size - DEFAULT_MAX_BYTES - 4);
          const buffer = Buffer.alloc(Math.min(size, DEFAULT_MAX_BYTES + 4));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          let start = 0;
          while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
          const result = truncateTail(buffer.subarray(start, bytesRead).toString("utf8"), { maxLines: n });
          tail = result.content;
          if (offset > 0 || result.truncated) {
            tail += `\n[Truncated tail: ${n} lines / 50 KiB limit; may begin mid-line. Full log: ${job.logPath}]`;
          }
        } finally { await file.close(); }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const alive = job.exitedAt === undefined;
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
      if (job.exitedAt !== undefined) {
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
    description: "List background jobs when the user explicitly asks for progress/ETA, or to find completed results. Never poll for completion; all overlapping jobs produce one automatic notification when done.",
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
    shuttingDown = true;
    pending.length = 0;
    for (const job of jobs.values()) {
      if (job.exitedAt === undefined) killJobTree(job);
    }
  });
}
