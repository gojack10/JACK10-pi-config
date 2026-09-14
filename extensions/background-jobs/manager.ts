import { DEFAULT_MAX_BYTES, truncateTail, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaintenanceHandoff } from "../_shared/maintenance.ts";

type UserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type SendUserMessage = (content: string, options?: UserMessageOptions) => void | PromiseLike<unknown>;

const admissionAccepted = (result: unknown): boolean => {
  if (result === undefined || typeof result !== "object" || result === null) return true;
  return (result as { status?: unknown }).status === "admitted";
};

const admissionError = (result: unknown): Error => {
  const error = typeof result === "object" && result !== null && "error" in result
    ? String((result as { error?: unknown }).error)
    : "message admission was rejected";
  return new Error(error);
};

export interface BackgroundJobStartOptions {
  command: string;
  label?: string;
  cwd: string;
  /** Identity/status used by extensions that supervise a structured child. */
  completionId?: string;
}

export type BackgroundJobCompletionSource = "model" | "technical" | "protocol" | "transport";

export interface BackgroundJobCompletionOverride {
  id: string;
  status: BackgroundJobOutcomeStatus;
  summary: string;
  source?: BackgroundJobCompletionSource;
  reportText?: string;
  reportPath?: string;
}

export interface BackgroundJobStartHooks {
  onStdout?: (chunk: string) => void;
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
  source?: BackgroundJobCompletionSource;
}

export interface BackgroundJobCompletion {
  id: string;
  status?: BackgroundJobOutcomeStatus;
  summary: string;
  source?: BackgroundJobCompletionSource;
  reportText?: string;
  reportPath?: string;
}

export interface BackgroundJobReport {
  batchId: string;
  text: string;
  completions: readonly BackgroundJobCompletion[];
}

export interface BackgroundJobBatchStatus {
  batchId: string;
  open: boolean;
  membershipClosed: boolean;
  members: number;
  finalized: number;
  pending: number;
  running: number;
  complete: boolean;
}

export interface BackgroundJobBatch {
  readonly id: string;
  start(options: BackgroundJobStartOptions): BackgroundJobStartResult;
  startExternal(
    options: BackgroundJobStartOptions,
    createChild: () => ChildProcess,
    hooks?: BackgroundJobStartHooks,
  ): BackgroundJobStartResult;
  registerOutcome(id: string): void;
  recordOutcome(outcome: BackgroundJobOutcome): void;
  notifyNeedsInput(message: string): void | PromiseLike<unknown>;
  getReport(): BackgroundJobReport | undefined;
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
  details: Array<{ id: number; command: string; pid: number | undefined; exit_code: number | null | undefined; killed: boolean }>;
}

export type BackgroundJobKillResult =
  | { kind: "missing" }
  | { kind: "already-exited"; exitCode: number | null | undefined }
  | { kind: "sent"; pid: number | undefined };

interface BgJob extends BackgroundJobInfo {
  child: ChildProcess;
  errorMessage?: string;
  completionId?: string;
  completion?: BackgroundJobCompletionOverride;
  retired?: boolean;
  onStdout?: (chunk: string) => void;
}

interface BatchState {
  id: string;
  open: boolean;
  membershipClosed: boolean;
  expectedMembers?: number;
  jobs: Set<number>;
  members: Set<string>;
  finalized: Set<string>;
  pending: BackgroundJobCompletion[];
  earlyFailures: Set<string>;
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
  private readonly closedBatchIds = new Set<string>();
  private readonly reports = new Map<string, BackgroundJobReport>();
  private nextJobId = 1;
  private nextBatchId = 1;
  private implicitBatchId: string | undefined;
  private shuttingDown = false;
  private maintenanceId: string | undefined;
  private sendUserMessage: SendUserMessage;
  private readonly workListeners = new Set<() => void>();
  private readonly jobListeners = new Map<number, Set<(job: BackgroundJobInfo, completion: BackgroundJobCompletion) => void>>();
  private workGenerationValue = 0;

  constructor(sendUserMessage: SendUserMessage) {
    this.sendUserMessage = sendUserMessage;
  }

  attach(sendUserMessage: SendUserMessage): void {
    this.sendUserMessage = sendUserMessage;
  }

  beginMaintenance(maintenanceId: string): void {
    if (this.shuttingDown) throw new Error("Background job manager is shut down");
    if (this.maintenanceId && this.maintenanceId !== maintenanceId) {
      throw new Error("another background maintenance operation is already active");
    }
    this.maintenanceId = maintenanceId;
  }

  isInMaintenance(maintenanceId?: string): boolean {
    return this.maintenanceId !== undefined && (maintenanceId === undefined || this.maintenanceId === maintenanceId);
  }

  resumeMaintenance(maintenanceId: string): void {
    if (this.maintenanceId === undefined) return;
    if (this.maintenanceId !== maintenanceId) {
      throw new Error("background maintenance ownership is stale");
    }
    this.maintenanceId = undefined;
  }

  start(options: BackgroundJobStartOptions, batchOptions: { batchId?: string } = {}): BackgroundJobStartResult {
    return this.startProcess(
      options,
      () => spawn("sh", ["-c", options.command], {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      batchOptions,
    );
  }

  startExternal(
    options: BackgroundJobStartOptions,
    createChild: () => ChildProcess,
    hooks: BackgroundJobStartHooks = {},
    batchOptions: { batchId?: string } = {},
  ): BackgroundJobStartResult {
    return this.startProcess(options, createChild, batchOptions, hooks);
  }

  private startProcess(
    options: BackgroundJobStartOptions,
    createChild: () => ChildProcess,
    batchOptions: { batchId?: string } = {},
    hooks: BackgroundJobStartHooks = {},
  ): BackgroundJobStartResult {
    this.assertCanStart();
    const batch = this.batchForStart(batchOptions.batchId);
    if (batch.expectedMembers !== undefined && batch.members.size >= batch.expectedMembers) {
      throw new Error(`Batch ${batch.id} already has ${batch.expectedMembers} members`);
    }
    const id = this.nextJobId++;
    const logPath = join(tmpdir(), `pi-bg-${Date.now()}-${id}.log`);
    const logStream = createWriteStream(logPath);
    // Close membership before submission so a fast child cannot finish before its monitor exists.
    batch.jobs.add(id);
    this.addMember(batch, `job:${id}`);
    let child: ChildProcess;
    try {
      child = createChild();
    } catch (error) {
      batch.jobs.delete(id);
      batch.members.delete(`job:${id}`);
      throw error;
    }
    const startedAt = Date.now();
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
      completionId: options.completionId,
      onStdout: hooks.onStdout,
    };
    this.jobs.set(id, job);
    child.stdout?.on("data", chunk => {
      logStream.write(chunk);
      try { job.onStdout?.(chunk.toString()); } catch {}
    });
    child.stderr?.pipe(logStream, { end: false });
    this.workGenerationValue += 1;

    let closed = false;
    const finish = () => {
      if (job.exitedAt !== undefined) return;
      job.exitedAt = Date.now();
      if (!this.shuttingDown && !job.retired) {
        const completion = job.completion ?? (job.completionId
          ? { id: job.completionId, status: "failed" as const, summary: this.renderCompletionSummary(job) }
          : { id: `job_${id}`, summary: this.renderCompletionSummary(job) });
        this.finishMember(batch, `job:${id}`, completion);
        for (const listener of this.jobListeners.get(id) ?? []) {
          try { listener(this.info(job), completion); } catch {}
        }
        this.jobListeners.delete(id);
        if (this.runningCount() === 0) {
          for (const listener of this.workListeners) {
            try { listener(); } catch {}
          }
        }
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
    this.assertCanStart();
    if (expectedMembers !== undefined && expectedMembers < 1) {
      throw new Error("expectedMembers must be at least 1");
    }
    const existing = this.batches.get(batchId);
    if (this.closedBatchIds.has(batchId) || existing?.membershipClosed) {
      throw new Error(`Batch ${batchId} is closed`);
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
    batch.membershipClosed = true;
    this.closedBatchIds.add(batchId);
    this.maybeFlush(batch);
  }

  reopenBatch(batchId: string): BackgroundJobBatch {
    this.assertCanStart();
    const batch = this.batches.get(batchId);
    if (!batch || !this.closedBatchIds.has(batchId) || batch.jobs.size > 0 || batch.members.size > 0 || batch.pending.length > 0) {
      throw new Error(`Batch ${batchId} cannot be reopened`);
    }
    this.closedBatchIds.delete(batchId);
    batch.open = true;
    batch.membershipClosed = false;
    return this.batchHandle(batch);
  }

  retireExternal(jobId: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.exitedAt !== undefined) return;
    job.retired = true;
    this.jobListeners.delete(jobId);
    for (const batch of this.batches.values()) {
      if (!batch.jobs.delete(jobId)) continue;
      batch.members.delete(`job:${jobId}`);
      batch.finalized.delete(`job:${jobId}`);
    }
    this.jobs.delete(jobId);
    killJobTree(job);
  }

  registerOutcome(batchId: string, id: string): void {
    this.registerOutcomes(batchId, [id]);
  }

  registerOutcomes(batchId: string, ids: readonly string[]): void {
    this.assertCanStart();
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    let batch = this.batches.get(batchId);
    if (!batch) {
      if (this.closedBatchIds.has(batchId)) throw new Error(`Batch ${batchId} is closed`);
      batch = this.createBatch(batchId);
      batch.open = true;
    }
    const memberIds = uniqueIds.map(id => `outcome:${id}`);
    const newMembers = memberIds.filter(memberId => !batch!.members.has(memberId));
    if (batch.membershipClosed && newMembers.length > 0) {
      throw new Error(`Batch ${batchId} is closed`);
    }
    if (batch.expectedMembers !== undefined && batch.members.size + newMembers.length > batch.expectedMembers) {
      throw new Error(`Batch ${batchId} already has ${batch.expectedMembers} members`);
    }
    for (const memberId of newMembers) batch.members.add(memberId);
  }

  assertCanRegisterOutcomes(batchId: string, ids: readonly string[]): void {
    this.assertCanStart();
    const batch = this.batches.get(batchId);
    if (!batch) {
      if (this.closedBatchIds.has(batchId)) throw new Error(`Batch ${batchId} is closed`);
      return;
    }
    const newMembers = [...new Set(ids.map(id => `outcome:${id}`))]
      .filter(memberId => !batch!.members.has(memberId));
    if (batch.membershipClosed && newMembers.length > 0) {
      throw new Error(`Batch ${batchId} is closed`);
    }
    if (batch.expectedMembers !== undefined && batch.members.size + newMembers.length > batch.expectedMembers) {
      throw new Error(`Batch ${batchId} already has ${batch.expectedMembers} members`);
    }
  }

  recordOutcome(batchId: string, outcome: BackgroundJobOutcome): void {
    this.assertOpen();
    const existing = this.batches.get(batchId);
    if (!existing && this.closedBatchIds.has(batchId)) {
      throw new Error(`Batch ${batchId} is closed`);
    }
    const batch = existing ?? this.createBatch(batchId);
    const memberId = `outcome:${outcome.id}`;
    if (!batch.members.has(memberId)) {
      if (batch.membershipClosed) throw new Error(`Batch ${batchId} is closed`);
      this.addMember(batch, memberId);
    }
    this.finishMember(
      batch,
      memberId,
      {
        id: outcome.id,
        status: outcome.status,
        summary: outcome.summary ?? `${outcome.status} ${outcome.id}`,
        source: outcome.source,
      },
    );
  }

  notifyNeedsInput(batchId: string, message: string, admissionKey?: string, admissionGuard?: () => boolean): void | PromiseLike<unknown> {
    this.assertOpen();
    if (!this.batches.has(batchId)) throw new Error(`Unknown background batch ${batchId}`);
    return this.sendUserMessage(
      `SYSTEM (background-jobs): Batch ${batchId} needs human input.\n${message}`,
      { deliverAs: "steer", admissionKey, admissionGuard },
    );
  }

  notifyFailure(batchId: string, completion: BackgroundJobCompletion): void {
    this.assertOpen();
    const batch = this.batches.get(batchId);
    if (!batch || completion.status !== "failed") return;
    const jobId = [...batch.jobs].find(id => this.jobs.get(id)?.completionId === completion.id);
    if (jobId === undefined) return;
    const memberId = `job:${jobId}`;
    if (!batch.members.has(memberId) || batch.earlyFailures.has(memberId)) return;
    batch.earlyFailures.add(memberId);
    this.sendReport({
      batchId,
      completions: [completion],
      text: `SYSTEM (background-jobs): ${this.renderCompletion(completion)}`,
    }, `background:${batchId}:failure:${completion.id}`);
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
        exit_code: job.exitCode,
        killed: job.killed,
      })),
    };
  }

  onJobsSettled(listener: () => void): () => void {
    this.workListeners.add(listener);
    return () => this.workListeners.delete(listener);
  }

  onJobSettled(
    jobId: number,
    listener: (job: BackgroundJobInfo, completion: BackgroundJobCompletion) => void,
  ): () => void {
    const job = this.jobs.get(jobId);
    if (!job) return () => {};
    if (job.exitedAt !== undefined) {
      queueMicrotask(() => listener(this.info(job), job.completion ?? (job.completionId
        ? { id: job.completionId, status: "failed" as const, summary: this.renderCompletionSummary(job) }
        : { id: `job_${job.id}`, summary: this.renderCompletionSummary(job) })));
      return () => {};
    }
    const listeners = this.jobListeners.get(jobId) ?? new Set();
    listeners.add(listener);
    this.jobListeners.set(jobId, listeners);
    return () => {
      const current = this.jobListeners.get(jobId);
      current?.delete(listener);
      if (current?.size === 0) this.jobListeners.delete(jobId);
    };
  }

  setCompletion(jobId: number, completion: BackgroundJobCompletionOverride): void {
    const job = this.jobs.get(jobId);
    if (!job || job.exitedAt !== undefined) return;
    job.completion = { ...completion };
  }

  workGeneration(): number {
    return this.workGenerationValue;
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
    this.maintenanceId = undefined;
    this.batches.clear();
    this.closedBatchIds.clear();
    this.reports.clear();
    this.implicitBatchId = undefined;
    this.workListeners.clear();
    this.jobListeners.clear();
    for (const job of this.jobs.values()) {
      if (job.exitedAt === undefined) killJobTree(job);
    }
  }

  getReport(batchId: string): BackgroundJobReport | undefined {
    const report = this.reports.get(batchId);
    return report
      ? { ...report, completions: report.completions.map(completion => ({ ...completion })) }
      : undefined;
  }

  getBatchStatus(batchId: string): BackgroundJobBatchStatus | undefined {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return this.reports.has(batchId)
        ? { batchId, open: false, membershipClosed: true, members: 0, finalized: 0, pending: 0, running: 0, complete: true }
        : undefined;
    }
    const running = [...batch.jobs].filter(id => this.jobs.get(id)?.exitedAt === undefined).length;
    const members = batch.members.size;
    const finalized = batch.finalized.size;
    return {
      batchId,
      open: batch.open,
      membershipClosed: batch.membershipClosed,
      members,
      finalized,
      pending: batch.pending.length,
      running,
      complete: !batch.open && running === 0 && finalized >= members,
    };
  }

  private batchHandle(batch: BatchState): BackgroundJobBatch {
    return {
      id: batch.id,
      start: options => this.start(options, { batchId: batch.id }),
      startExternal: (options, createChild, hooks) =>
        this.startExternal(options, createChild, hooks, { batchId: batch.id }),
      registerOutcome: id => this.registerOutcome(batch.id, id),
      recordOutcome: outcome => this.recordOutcome(batch.id, outcome),
      notifyNeedsInput: message => this.notifyNeedsInput(batch.id, message),
      getReport: () => this.getReport(batch.id),
      close: () => this.closeBatch(batch.id),
    };
  }

  private batchForStart(batchId?: string): BatchState {
    if (batchId !== undefined) {
      const batch = this.batches.get(batchId);
      if (this.closedBatchIds.has(batchId) || batch?.membershipClosed) {
        throw new Error(`Batch ${batchId} is closed`);
      }
      return batch ?? this.createBatch(batchId);
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
      membershipClosed: false,
      jobs: new Set(),
      members: new Set(),
      finalized: new Set(),
      pending: [],
      earlyFailures: new Set(),
    };
    this.batches.set(id, batch);
    return batch;
  }

  private addMember(batch: BatchState, memberId: string): void {
    if (batch.members.has(memberId)) return;
    if (batch.expectedMembers !== undefined && batch.members.size >= batch.expectedMembers) {
      throw new Error(`Batch ${batch.id} already has ${batch.expectedMembers} members`);
    }
    batch.members.add(memberId);
  }

  private finishMember(batch: BatchState, memberId: string, completion: BackgroundJobCompletion): void {
    if (batch.finalized.has(memberId)) return;
    batch.finalized.add(memberId);
    batch.pending.push(completion);
    this.maybeFlush(batch);
  }

  private maybeFlush(batch: BatchState): void {
    if (this.shuttingDown || batch.open || !batch.pending.length) return;
    if (batch.expectedMembers !== undefined && batch.finalized.size < batch.expectedMembers) return;
    if (batch.expectedMembers === undefined && batch.finalized.size < batch.members.size) return;
    if ([...batch.jobs].some(id => this.jobs.get(id)?.exitedAt === undefined)) return;
    const completions = batch.pending.splice(0);
    const report = this.createReport(batch.id, completions);
    this.reports.set(batch.id, report);
    this.closedBatchIds.add(batch.id);
    this.batches.delete(batch.id);
    if (this.implicitBatchId === batch.id) this.implicitBatchId = undefined;
    this.sendReport(report, `background:${report.batchId}:report`);
  }

  private createReport(batchId: string, completions: BackgroundJobCompletion[]): BackgroundJobReport {
    const retained = completions.map(completion => ({ ...completion }));
    return {
      batchId,
      completions: retained,
      text: `SYSTEM (background-jobs): All ${retained.length} background job(s) in this batch finished.\n${retained.map(completion => this.renderCompletion(completion)).join("\n")}`,
    };
  }

  private sendReport(report: BackgroundJobReport, admissionKey: string): void {
    try {
      const result = this.sendUserMessage(report.text, { deliverAs: "steer", admissionKey });
      if (result !== undefined) {
        void Promise.resolve(result).then(accepted => {
          if (!admissionAccepted(accepted)) throw admissionError(accepted);
        }).catch(() => {});
      }
    } catch {}
  }

  private renderCompletion(completion: BackgroundJobCompletion): string {
    const source = completion.source && completion.source !== "model" ? ` [${completion.source}]` : "";
    const status = completion.status
      ? `outcome ${completion.id}: [${completion.status}]${source} ${completion.summary}`
      : `${source ? `[${completion.source}] ` : ""}${completion.summary}`;
    if (completion.reportText !== undefined) {
      return `${status}\n--- dialogue report${completion.reportText.length === 0 ? " (empty)" : ""} ---\n${completion.reportText}`;
    }
    if (completion.reportPath !== undefined) return `${status}\nFull dialogue report: ${completion.reportPath}`;
    return status;
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

  private assertCanStart(): void {
    this.assertOpen();
    if (this.maintenanceId) throw new Error("background job launch is fenced during maintenance");
  }
}

type SessionOwnerContext = Pick<ExtensionContext, "sessionManager">;
const managerRegistryKey = Symbol.for("pi.background-jobs.manager-registry");
const handoffRegistryKey = Symbol.for("pi.background-jobs.maintenance-handoffs");
const globalState = globalThis as typeof globalThis & {
  [managerRegistryKey]?: WeakMap<object, BackgroundJobManager>;
  [handoffRegistryKey]?: Map<string, { manager: BackgroundJobManager; lease: MaintenanceHandoff }>;
};
const managers = globalState[managerRegistryKey] ??= new WeakMap();
const handoffs = globalState[handoffRegistryKey] ??= new Map();

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

export function parkBackgroundJobManager(ctx: SessionOwnerContext, lease: MaintenanceHandoff): void {
  const manager = managers.get(ctx.sessionManager as object);
  if (!manager) throw new Error("background job manager is unavailable for maintenance");
  if (!manager.isInMaintenance(lease.maintenanceId)) {
    throw new Error("background job maintenance lease is stale");
  }
  handoffs.set(lease.maintenanceId, { manager, lease: { ...lease } });
}

export function adoptBackgroundJobManager(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: SessionOwnerContext,
  lease: MaintenanceHandoff,
): BackgroundJobManager | undefined {
  const handoff = handoffs.get(lease.maintenanceId);
  if (!handoff) throw new Error("background maintenance handoff is missing or already consumed");
  if (handoff.lease.sessionId !== lease.sessionId || handoff.lease.ownerEpoch !== lease.ownerEpoch ||
      !handoff.manager.isInMaintenance(lease.maintenanceId) || handoff.manager.stats().running > 0) {
    throw new Error("background job maintenance handoff token conflicts with its owner");
  }
  const manager = handoff.manager;
  manager.resumeMaintenance(lease.maintenanceId);
  manager.attach((content, options) => pi.sendUserMessage(content, options));
  managers.set(ctx.sessionManager as object, manager);
  handoffs.delete(lease.maintenanceId);
  return manager;
}

export function abandonBackgroundMaintenance(lease: MaintenanceHandoff): void {
  const handoff = handoffs.get(lease.maintenanceId);
  if (!handoff || handoff.lease.ownerEpoch !== lease.ownerEpoch) return;
  handoffs.delete(lease.maintenanceId);
  handoff.manager.resumeMaintenance(lease.maintenanceId);
}

export function releaseBackgroundJobManager(ctx: SessionOwnerContext): void {
  const owner = ctx.sessionManager as object;
  const manager = managers.get(owner);
  if (!manager) return;
  managers.delete(owner);
  manager.shutdown();
}
