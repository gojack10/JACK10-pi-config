import { DEFAULT_MAX_BYTES, truncateTail, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type UserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type SendUserMessage = (content: string, options?: UserMessageOptions) => void;

export interface BackgroundJobStartOptions {
  command: string;
  label?: string;
  cwd: string;
}

export interface BackgroundJobInfo {
  id: number;
  command: string;
  label: string;
  cwd: string;
  pid: number | undefined;
  logPath: string;
  startedAt: number;
  exitCode: number | null | undefined;
  exitedAt: number | undefined;
  killed: boolean;
}

export interface BackgroundJobStartResult {
  job: BackgroundJobInfo;
  runningJobs: number;
}

export type BackgroundJobOutcomeStatus = "completed" | "failed" | "blocked";

export interface BackgroundJobOutcome {
  id: string;
  status: BackgroundJobOutcomeStatus;
  summary?: string;
}

export interface BackgroundJobBatch {
  readonly id: string;
  start(options: BackgroundJobStartOptions): BackgroundJobStartResult;
  recordOutcome(outcome: BackgroundJobOutcome): void;
  notifyNeedsInput(message: string): void;
  close(): void;
}

export interface BackgroundTailResult {
  text: string;
  alive: boolean;
  exitCode: number | null;
  elapsedMs: number;
}

export interface BackgroundJobsList {
  text: string;
  details: Array<{ id: number; command: string; pid: number | undefined; exit_code: number | null; killed: boolean }>;
}

export type BackgroundJobKillResult =
  | { kind: "missing" }
  | { kind: "already-exited"; exitCode: number | null | undefined }
  | { kind: "sent"; pid: number | undefined };

interface BgJob extends BackgroundJobInfo {
  child: ChildProcess;
  errorMessage?: string;
}

interface PendingCompletion {
  summary: string;
}

interface BatchState {
  id: string;
  open: boolean;
  expectedMembers?: number;
  jobs: Set<number>;
  members: Set<string>;
  finalized: Set<string>;
  pending: PendingCompletion[];
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

export class BackgroundJobManager {
  private readonly jobs = new Map<number, BgJob>();
  private readonly batches = new Map<string, BatchState>();
  private nextJobId = 1;
  private nextBatchId = 1;
  private implicitBatchId: string | undefined;
  private shuttingDown = false;
  private sendUserMessage: SendUserMessage;

  constructor(sendUserMessage: SendUserMessage) {
    this.sendUserMessage = sendUserMessage;
  }

  attach(sendUserMessage: SendUserMessage): void {
    this.sendUserMessage = sendUserMessage;
  }

  start(options: BackgroundJobStartOptions, batchOptions: { batchId?: string } = {}): BackgroundJobStartResult {
    this.assertOpen();
    const batch = this.batchForStart(batchOptions.batchId);
    if (batch.expectedMembers !== undefined && batch.members.size >= batch.expectedMembers) {
      throw new Error(`Batch ${batch.id} already has ${batch.expectedMembers} members`);
    }
    const id = this.nextJobId++;
    const logPath = join(tmpdir(), `pi-bg-${Date.now()}-${id}.log`);
    const logStream = createWriteStream(logPath);
    const child = spawn("sh", ["-c", options.command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    const job: BgJob = {
      id,
      command: options.command,
      label: (options.label?.trim() || options.command.split("\n").find(line => line.trim()) || "background job")
        .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 80),
      cwd: options.cwd,
      child,
      pid: child.pid,
      logPath,
      startedAt,
      exitCode: undefined,
      exitedAt: undefined,
      killed: false,
    };
    this.jobs.set(id, job);
    batch.jobs.add(id);
    this.addMember(batch, `job:${id}`);

    let closed = false;
    const finish = () => {
      if (job.exitedAt !== undefined) return;
      job.exitedAt = Date.now();
      if (!this.shuttingDown) {
        this.finishMember(batch, `job:${id}`, this.renderCompletionSummary(job));
      }
    };
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

    return { job: this.info(job), runningJobs: this.runningCount() };
  }

  openBatch(batchId = `batch-${this.nextBatchId++}`, expectedMembers?: number): BackgroundJobBatch {
    this.assertOpen();
    if (expectedMembers !== undefined && expectedMembers < 1) {
      throw new Error("expectedMembers must be at least 1");
    }
    const existing = this.batches.get(batchId);
    if (existing && existing.finalized.size > 0 && !existing.open) {
      throw new Error(`Batch ${batchId} is already complete`);
    }
    const batch = existing ?? this.createBatch(batchId);
    batch.open = true;
    if (expectedMembers !== undefined) batch.expectedMembers = expectedMembers;
    return this.batchHandle(batch);
  }

  closeBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    batch.open = false;
    this.maybeFlush(batch);
  }

  recordOutcome(batchId: string, outcome: BackgroundJobOutcome): void {
    this.assertOpen();
    const batch = this.batches.get(batchId) ?? this.createBatch(batchId);
    const memberId = `outcome:${outcome.id}`;
    this.addMember(batch, memberId);
    this.finishMember(
      batch,
      memberId,
      outcome.summary ?? `${outcome.status} ${outcome.id}`,
    );
  }

  notifyNeedsInput(batchId: string, message: string): void {
    this.assertOpen();
    if (!this.batches.has(batchId)) throw new Error(`Unknown background batch ${batchId}`);
    this.sendUserMessage(
      `SYSTEM (background-jobs): Batch ${batchId} needs human input.\n${message}`,
      { deliverAs: "steer" },
    );
  }

  async tail(jobId: number, lines = 50): Promise<BackgroundTailResult | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const n = Math.min(Math.max(lines, 1), 500);
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
      text: `job_${jobId}: ${status}\n--- last ${n} line${n === 1 ? "" : "s"} ---\n${tail || "(empty)"}`,
      alive,
      exitCode: job.exitCode ?? null,
      elapsedMs,
    };
  }

  kill(jobId: number): BackgroundJobKillResult {
    const job = this.jobs.get(jobId);
    if (!job) return { kind: "missing" };
    if (job.exitedAt !== undefined) return { kind: "already-exited", exitCode: job.exitCode };
    job.killed = true;
    killJobTree(job);
    return { kind: "sent", pid: job.pid };
  }

  list(): BackgroundJobsList {
    if (this.jobs.size === 0) return { text: "No background jobs.", details: [] };
    return {
      text: [...this.jobs.values()]
        .map((job) => {
          const elapsed = Math.round(((job.exitedAt ?? Date.now()) - job.startedAt) / 1000);
          const status = job.exitedAt === undefined
            ? "running (collecting output)"
            : `exit ${job.exitCode}${job.killed ? " (killed)" : ""}`;
          return `  job_${job.id}: [${status}] ${job.label} (${elapsed}s)`;
        })
        .join("\n"),
      details: [...this.jobs.values()].map(job => ({
        id: job.id,
        command: job.command,
        pid: job.pid,
        exit_code: job.exitCode ?? null,
        killed: job.killed,
      })),
    };
  }

  stats(): { jobs: number; running: number; pending: number; batches: number } {
    return {
      jobs: this.jobs.size,
      running: this.runningCount(),
      pending: [...this.batches.values()].reduce((count, batch) => count + batch.pending.length, 0),
      batches: this.batches.size,
    };
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.batches.clear();
    this.implicitBatchId = undefined;
    for (const job of this.jobs.values()) {
      if (job.exitedAt === undefined) killJobTree(job);
    }
  }

  private batchHandle(batch: BatchState): BackgroundJobBatch {
    return {
      id: batch.id,
      start: options => this.start(options, { batchId: batch.id }),
      recordOutcome: outcome => this.recordOutcome(batch.id, outcome),
      notifyNeedsInput: message => this.notifyNeedsInput(batch.id, message),
      close: () => this.closeBatch(batch.id),
    };
  }

  private batchForStart(batchId?: string): BatchState {
    if (batchId !== undefined) {
      return this.batches.get(batchId) ?? this.createBatch(batchId);
    }
    const implicit = this.implicitBatchId ? this.batches.get(this.implicitBatchId) : undefined;
    if (implicit && [...implicit.jobs].some(id => this.jobs.get(id)?.exitedAt === undefined)) return implicit;
    const batch = this.createBatch(`default-${this.nextBatchId++}`);
    this.implicitBatchId = batch.id;
    return batch;
  }

  private createBatch(id: string): BatchState {
    const batch: BatchState = {
      id,
      open: false,
      jobs: new Set(),
      members: new Set(),
      finalized: new Set(),
      pending: [],
    };
    this.batches.set(id, batch);
    return batch;
  }

  private addMember(batch: BatchState, memberId: string): void {
    if (batch.expectedMembers !== undefined && batch.members.size >= batch.expectedMembers) {
      throw new Error(`Batch ${batch.id} already has ${batch.expectedMembers} members`);
    }
    batch.members.add(memberId);
  }

  private finishMember(batch: BatchState, memberId: string, summary: string): void {
    if (batch.finalized.has(memberId)) return;
    batch.finalized.add(memberId);
    batch.pending.push({ summary });
    this.maybeFlush(batch);
  }

  private maybeFlush(batch: BatchState): void {
    if (this.shuttingDown || batch.open || !batch.pending.length) return;
    if (batch.expectedMembers !== undefined && batch.finalized.size < batch.expectedMembers) return;
    if (batch.expectedMembers === undefined && batch.finalized.size < batch.members.size) return;
    if ([...batch.jobs].some(id => this.jobs.get(id)?.exitedAt === undefined)) return;
    const pending = batch.pending.splice(0);
    this.sendUserMessage(
      `SYSTEM (background-jobs): All ${pending.length} background job(s) in this batch finished.\n${pending.map(item => item.summary).join("\n")}`,
      { deliverAs: "steer" },
    );
    this.batches.delete(batch.id);
    if (this.implicitBatchId === batch.id) this.implicitBatchId = undefined;
  }

  private renderCompletionSummary(job: BgJob): string {
    const elapsed = Math.round(((job.exitedAt ?? Date.now()) - job.startedAt) / 1000);
    const status = job.exitCode === -1
      ? `failed${job.errorMessage ? ` (${job.errorMessage})` : ""}`
      : `exit ${job.exitCode}${job.killed ? " (killed)" : ""}`;
    return `job_${job.id} (${job.label}): [${status}] (${elapsed}s). Log: ${job.logPath}`;
  }

  private info(job: BgJob): BackgroundJobInfo {
    const { child: _child, errorMessage: _errorMessage, ...info } = job;
    return info;
  }

  private runningCount(): number {
    return [...this.jobs.values()].filter(job => job.exitedAt === undefined).length;
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new Error("Background job manager is shut down");
  }
}

type SessionOwnerContext = Pick<ExtensionContext, "sessionManager">;
const managerRegistryKey = Symbol.for("pi.background-jobs.manager-registry");
const globalState = globalThis as typeof globalThis & {
  [managerRegistryKey]?: WeakMap<object, BackgroundJobManager>;
};
const managers = globalState[managerRegistryKey] ??= new WeakMap();

export function getBackgroundJobManager(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: SessionOwnerContext,
): BackgroundJobManager {
  const owner = ctx.sessionManager as object;
  let manager = managers.get(owner);
  if (!manager) {
    manager = new BackgroundJobManager((content, options) => pi.sendUserMessage(content, options));
    managers.set(owner, manager);
  } else {
    manager.attach((content, options) => pi.sendUserMessage(content, options));
  }
  return manager;
}

export function releaseBackgroundJobManager(ctx: SessionOwnerContext): void {
  const owner = ctx.sessionManager as object;
  const manager = managers.get(owner);
  if (!manager) return;
  managers.delete(owner);
  manager.shutdown();
}
