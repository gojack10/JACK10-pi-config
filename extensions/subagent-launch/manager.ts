import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaintenanceHandoff } from "../_shared/maintenance.ts";
import {
  BackgroundJobManager,
  adoptBackgroundJobManager,
  getBackgroundJobManager,
} from "../background-jobs/manager.ts";
import {
  getTaskOutcomeManager,
  TASK_LAUNCH_MANIFEST_OPTION,
  type OutcomeSource,
  type TaskLaunchManifest,
  type TaskMode,
} from "../task-outcomes/manager.ts";

import { RECOVERY_COMMAND, RECOVERY_OPTION, registerContextRecovery } from "./recovery.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_JOBS = 16;
const START_WAIT_MS = 8_000;
const MONITOR_START_MS = 30_000;
const POLL_MS = 100;
const OUTCOME_OPTION = "@pi_outcome";
const OUTCOME_GENERATION_OPTION = "@pi_outcome_generation";
const START_GENERATION_OPTION = "@pi_start_generation";
const SESSION_FILE_OPTION = "@pi_session_file";
const OUTCOME_CHANNEL_OPTION = "@pi_outcome_channel";
const START_CHANNEL_OPTION = "@pi_start_channel";
const DONE_CHANNEL_OPTION = "@pi_done_channel";
const SETTLED_CHANNEL_OPTION = "@pi_settled_channel";
const SETTLED_GENERATION_OPTION = "@pi_settled_generation";
const FRIENDLY_PRODUCTION_MODEL = "gpt-6-astra";

const admissionAccepted = (result: unknown): boolean => {
  if (result === undefined || typeof result !== "object" || result === null) return true;
  return (result as { status?: unknown }).status === "admitted";
};

export interface SubagentJobInput {
  provider: string;
  model: string;
  thinking: (typeof THINKING_LEVELS)[number];
  mission_file: string;
  cwd: string;
  session_label: string;
  mode: TaskMode;
  report_file?: string;
  /** Run-scoped friendly-stop opt-in; omitted means disabled. */
  friendly_stop_percent?: number;
  friendly_stop_directory?: string;
}

export interface SubagentFollowupInput extends SubagentJobInput {
  job_id: string;
  session_id: string;
}

interface StoredState {
  jobId: string;
  sessionId: string;
  attemptId: string;
  batchId: string;
  paneId: string;
  sessionLabel: string;
  cwd: string;
  provider: string;
  model: string;
  thinking: string;
  mode: TaskMode;
  manifestPath: string;
  reportPath?: string;
  monitorJobId?: number;
  monitorLogPath?: string;
  monitorUnsubscribe?: () => void;
  releaseFailure?: string;
  releaseBuffered?: boolean;
  startWaiters: Map<string, Array<(started: boolean) => void>>;
  startResults: Map<string, boolean>;
  outputBuffer: string;
  finished: boolean;
  friendlyStopPercent?: number;
  friendlyStopDirectory?: string;
  contextPauseId?: string;
  finalAdmitted?: boolean;
  admittedMarkers?: Map<string, string>;
  receiptRevision?: number;
  piSessionId?: string;
  recoveryPending?: string;
  parentJobId?: string;
  failureStatus?: "setup_failed" | "monitor_setup_failed" | "release_failed";
}

interface Receipt {
  job: string;
  status: "running" | "start_timeout" | "setup_failed" | "monitor_setup_failed" | "release_failed";
  attempt_id: string;
  session_id: string;
  session_label: string;
  pane_id?: string;
  batch_id: string;
  manifest_file?: string;
  report_file?: string;
  session_file?: string;
  monitor_log?: string;
  error?: string;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const safeText = (value: unknown, name: string, max = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be a nonempty NUL/control-free string of at most ${max} characters`);
  }
  return value;
};
const safeId = (value: unknown, name: string): string => {
  const text = safeText(value, name, 128);
  if (!SAFE_ID.test(text)) throw new Error(`${name} is not a safe identifier`);
  return text;
};
const safeLabel = (value: unknown): string => {
  const text = safeText(value, "session_label", 64).trim();
  if (!SAFE_LABEL.test(text)) throw new Error("session_label must contain only safe tmux label characters");
  return text;
};
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
const asPath = (value: unknown, name: string): string => {
  const text = safeText(value, name, 4096);
  if (!isAbsolute(text)) throw new Error(`${name} must be absolute`);
  return resolve(text);
};

async function requireDirectory(path: string, name: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${name} is not a directory`);
    await access(path);
  } catch (error) {
    throw new Error(`${name} is not an accessible directory: ${errorMessage(error)}`);
  }
}

async function requireMission(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1) throw new Error("mission_file must be a nonempty regular file");
    await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a nonempty")) throw error;
    throw new Error(`mission_file is not a readable nonempty file: ${errorMessage(error)}`);
  }
}

interface ReportReservation {
  activatedAt: number;
  reportIdentity: { dev: string; ino: string };
}

async function requireFreshReport(path: string, reserved: Set<string>): Promise<ReportReservation> {
  if (reserved.has(path)) throw new Error(`report_file is duplicated in this launch batch: ${path}`);
  try {
    await lstat(path);
    throw new Error(`report_file must be fresh and unused: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("fresh and unused")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await requireDirectory(dirname(path), "report_file parent");
  const reservation = join(tmpdir(), `pi-subagent-report-${createHash("sha256").update(path).digest("hex")}.reserve`);
  try {
    await writeFile(reservation, `${path}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`report_file is already reserved by another launch: ${path}`);
    }
    throw new Error(`cannot reserve report_file ${path}: ${errorMessage(error)}`);
  }
  const activatedAt = Date.now();
  let report;
  try {
    report = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const info = await report.stat();
    reserved.add(path);
    return { activatedAt, reportIdentity: { dev: String(info.dev), ino: String(info.ino) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`report_file was created while it was being reserved: ${path}`);
    }
    throw new Error(`cannot create report reservation ${path}: ${errorMessage(error)}`);
  } finally {
    await report?.close().catch(() => {});
  }
}

const extensionPaths = (): string[] => {
  const extensionsDir = dirname(dirname(fileURLToPath(import.meta.url)));
  return [
    join(extensionsDir, "codex-workspaces.ts"),
    join(extensionsDir, "background-jobs.ts"),
    join(extensionsDir, "task-outcomes.ts"),
    // task-outcomes emits task-outcome synchronously from agent_settled;
    // tmux-turn-signal must run afterward to await its publication.
    join(extensionsDir, "tmux-turn-signal.ts"),
    join(extensionsDir, "subagent-launch.ts"),
    join(extensionsDir, "openai-272k-guard.ts"),
    join(dirname(extensionsDir), "optional-extensions", "rlm-friendly-stop.ts"),
  ];
};

export class SubagentLauncher {
  private readonly states = new Map<string, StoredState>();
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private background: BackgroundJobManager;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, background: BackgroundJobManager) {
    this.pi = pi;
    this.ctx = ctx;
    this.background = background;
  }

  attach(pi: ExtensionAPI, ctx: ExtensionContext, background: BackgroundJobManager): void {
    this.pi = pi;
    this.ctx = ctx;
    this.background = background;
  }

  getSessionId(): string {
    return this.ctx.sessionManager.getSessionId();
  }

  async launch(inputs: readonly SubagentJobInput[]): Promise<{ batch_id: string; jobs: Receipt[] }> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_JOBS) {
      throw new Error(`jobs must contain 1-${MAX_JOBS} items`);
    }
    const parentPane = safeText(process.env.TMUX_PANE, "TMUX_PANE", 32);
    if (!/^%[0-9]+$/.test(parentPane)) throw new Error("subagent_launch must run inside a tmux pane");
    await this.validateRoutes(inputs);
    const extensions = extensionPaths();
    for (const path of extensions) {
      try { const info = await stat(path); if (!info.isFile()) throw new Error("not a file"); }
      catch (error) { throw new Error(`required extension entrypoint unavailable: ${path}: ${errorMessage(error)}`); }
    }

    const reservedReports = new Set<string>();
    const prepared = [] as Array<{
      input: SubagentJobInput;
      jobId: string;
      attemptId: string;
      sessionId: string;
      batchId: string;
      sessionLabel: string;
      cwd: string;
      missionFile: string;
      reportPath?: string;
      reportIdentity?: { dev: string; ino: string };
      activatedAt?: number;
      parentJobId?: string;
      state?: StoredState;
      error?: string;
    }>;
    const batchId = unique("subagent-batch");
    const task = getTaskOutcomeManager(this.pi, this.ctx);
    const parent = task.snapshot().active;
    for (const input of inputs) {
      const jobId = unique("subagent-job");
      const attemptId = unique("subagent-attempt");
      const sessionId = unique("subagent-session");
      const item = {
        input,
        jobId,
        attemptId,
        sessionId,
        batchId,
        sessionLabel: `${safeLabel(input.session_label)}-${randomUUID().slice(0, 8)}`,
        cwd: asPath(input.cwd, "cwd"),
        missionFile: asPath(input.mission_file, "mission_file"),
        reportPath: input.mode === "task" ? asPath(input.report_file, "report_file") : undefined,
        reportIdentity: undefined as { dev: string; ino: string } | undefined,
        activatedAt: undefined as number | undefined,
        parentJobId: parent?.jobId,
      };
      await requireDirectory(item.cwd, "cwd");
      await requireMission(item.missionFile);
      if (input.mode === "task") {
        const reservation = await requireFreshReport(item.reportPath!, reservedReports);
        item.reportIdentity = reservation.reportIdentity;
        item.activatedAt = reservation.activatedAt;
      }
      else if (input.report_file !== undefined) throw new Error("dialogue mode must not include report_file");
      prepared.push(item);
    }

    const batch = this.background.openBatch(batchId, inputs.length);
    const receipts: Receipt[] = [];
    const viable: Array<typeof prepared[number]> = [];
    const failed = new Set<string>();
    if (parent) {
      for (const item of prepared) task.registerChild(parent.jobId, item.jobId);
    }

    // Create every pane, option, manifest, and log before any monitor or child is released.
    for (const item of prepared) {
      try {
        const state = await this.prepare(item, parentPane, extensions);
        item.state = state;
        viable.push(item);
      } catch (error) {
        item.error = errorMessage(error);
        item.failureStatus = "setup_failed";
        failed.add(item.jobId);
        batch.recordOutcome({
          id: item.jobId,
          status: "failed",
          source: "transport",
          summary: `setup_failed: ${item.error}; no child was released (session evidence is retained)`,
        });
        if (parent) this.recordParent(parent.jobId, item.jobId, `setup_failed: ${item.error}`, "failed", "transport");
      }
    }

    // Arm every viable monitor through the shared manager before releasing any pane.
    for (const item of viable) {
      try {
        await this.armMonitor(item.state!, batch);
        if (item.state?.monitorJobId !== undefined) this.states.set(item.jobId, item.state);
      } catch (error) {
        item.error = errorMessage(error);
        item.failureStatus = "monitor_setup_failed";
        failed.add(item.jobId);
        // A monitor that was already submitted remains authoritative; do not add a
        // second batch member or invent a second parent outcome.
        if (item.state?.monitorJobId === undefined) {
          batch.recordOutcome({ id: item.jobId, status: "failed", source: "transport", summary: `monitor_setup_failed: ${item.error}; no child was released` });
          if (parent) this.recordParent(parent.jobId, item.jobId, `monitor_setup_failed: ${item.error}`, "failed", "transport");
        }
      }
    }

    const startPromises = new Map<string, Promise<boolean>>();
    for (const item of viable) {
      const state = item.state!;
      if (!failed.has(item.jobId) && state.monitorJobId !== undefined) {
        startPromises.set(item.jobId, this.waitForStart(state, item.attemptId));
      }
    }
    for (const item of viable) {
      const state = item.state!;
      if (failed.has(item.jobId) || state.monitorJobId === undefined) continue;
      try {
        await this.release(item);
      } catch (error) {
        item.error = errorMessage(error);
        item.failureStatus = "release_failed";
        failed.add(item.jobId);
        const summary = `release_failed: ${item.error}; pane was preserved`;
        // Before load-buffer succeeds nothing was accepted, so transport is the
        // fallback. Once buffering succeeds, the monitor owns the race.
        if (state.monitorJobId !== undefined && !state.releaseBuffered) {
          state.releaseFailure = summary;
          this.background.setCompletion(state.monitorJobId, {
            id: item.jobId,
            status: "failed",
            source: "transport",
            summary,
          });
        } else if (state.monitorJobId === undefined) {
          batch.recordOutcome({ id: item.jobId, status: "failed", source: "transport", summary });
          if (parent) this.recordParent(parent.jobId, item.jobId, summary, "failed", "transport");
        }
      }
    }
    batch.close();

    await Promise.all(viable
      .filter(item => !failed.has(item.jobId) && item.state?.monitorJobId !== undefined)
      .map(item => startPromises.get(item.jobId)!));

    for (const item of prepared) {
      const state = item.state;
      if (!state) {
        receipts.push({
          job: item.jobId,
          status: "setup_failed",
          attempt_id: item.attemptId,
          session_id: item.sessionId,
          session_label: item.sessionLabel,
          batch_id: item.batchId,
          report_file: item.reportPath,
          error: item.error,
        });
        continue;
      }
      const started = await this.startWasSeen(state, item.attemptId);
      receipts.push({
        job: item.jobId,
        status: item.failureStatus ?? (failed.has(item.jobId) ? "release_failed" : started ? "running" : "start_timeout"),
        attempt_id: item.attemptId,
        session_id: item.sessionId,
        session_label: item.sessionLabel,
        pane_id: item.state?.paneId,
        batch_id: item.batchId,
        manifest_file: item.state?.manifestPath,
        report_file: item.reportPath,
        session_file: await this.show(item.state.paneId, SESSION_FILE_OPTION),
        monitor_log: item.state.monitorLogPath,
        error: item.error,
      });
    }
    return { batch_id: batchId, jobs: receipts };
  }

  async cleanAndContinue(input: { job_id: string; session_id: string; attempt_id: string }, signal?: AbortSignal) {
    const jobId = safeId(input.job_id, "job_id");
    const sessionId = safeId(input.session_id, "session_id");
    const attemptId = safeId(input.attempt_id, "attempt_id");
    const state = this.states.get(jobId);
    if (!state || state.sessionId !== sessionId || state.attemptId !== attemptId || state.finished || !state.contextPauseId) {
      throw new Error("no monitored context-paused attempt matches these IDs");
    }
    if (state.recoveryPending) throw new Error("a recovery command is already pending; no duplicate was sent");
    const pauseId = state.contextPauseId;
    const nonce = unique("context-recovery");
    state.recoveryPending = nonce;
    let sent = false;
    const path = join(tmpdir(), `${nonce}.command`);
    try {
      signal?.throwIfAborted();
      if (await this.findPane(jobId, sessionId) !== state.paneId) throw new Error("saved subagent pane changed");
      const manifest = await this.readManifest(state.manifestPath);
      if (manifest.jobId !== jobId || manifest.sessionId !== sessionId || manifest.attemptId !== attemptId ||
          await this.show(state.paneId, TASK_LAUNCH_MANIFEST_OPTION) !== state.manifestPath) {
        throw new Error("saved subagent attempt changed");
      }
      // Local commands can run while model work is active. The child checks Pi's
      // authoritative idle/queue state, not the asynchronously published counter.
      await this.set(state.paneId, RECOVERY_OPTION, JSON.stringify({
        nonce, jobId, attemptId, sessionId, pauseId, status: "pending",
      }));
      await writeFile(path, `/${RECOVERY_COMMAND} ${nonce}`, { flag: "wx", mode: 0o600 });
      await this.tmux(["load-buffer", "-b", nonce, path]);
      await this.tmux(["paste-buffer", "-pr", "-d", "-b", nonce, "-t", state.paneId]);
      sent = true;
      await this.tmux(["send-keys", "-t", state.paneId, "Enter"]);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const raw = await this.show(state.paneId, RECOVERY_OPTION);
        const ack = raw ? JSON.parse(raw) : undefined;
        if (!ack || ack.nonce !== nonce || ack.jobId !== jobId || ack.attemptId !== attemptId || ack.sessionId !== sessionId) {
          throw new Error("recovery acknowledgement missing or replaced; no retry was sent");
        }
        if (ack.status === "error" || ack.status === "resume_requested") {
          state.recoveryPending = undefined;
          if (ack.status === "error") throw new Error(ack.error || "context cleanup failed");
          if (state.contextPauseId === pauseId) state.contextPauseId = undefined;
          return { job_id: jobId, session_id: sessionId, attempt_id: attemptId,
            status: "resume_requested", report_file: state.reportPath,
            before_tokens: ack.beforeTokens, after_tokens: ack.afterTokens };
        }
        await this.timeout(POLL_MS);
      }
      throw new Error("recovery acknowledgement timed out; command may still run, no retry was sent");
    } finally {
      if (!sent) state.recoveryPending = undefined;
      await unlink(path).catch(() => {});
    }
  }

  async followup(input: SubagentFollowupInput): Promise<Receipt> {
    const jobId = safeId(input.job_id, "job_id");
    const sessionId = safeId(input.session_id, "session_id");
    await this.validateRoutes([input]);
    const paneId = await this.findPane(jobId, sessionId);
    if (!paneId) throw new Error(`no live saved subagent matches job_id ${jobId} and session_id ${sessionId}`);
    const oldManifestPath = await this.show(paneId, TASK_LAUNCH_MANIFEST_OPTION);
    if (!oldManifestPath) throw new Error("saved subagent has no launcher manifest");
    const old = await this.readManifest(oldManifestPath);
    if (old.jobId !== jobId || old.sessionId !== sessionId) throw new Error("saved subagent identity does not match its manifest");
    if (old.provider !== input.provider || old.model !== input.model || old.thinking !== input.thinking) {
      throw new Error("follow-up provider/model/thinking must explicitly match the saved route");
    }
    if (old.mode !== input.mode) throw new Error("follow-up mode must match the saved mode");
    const savedFriendlyPercent = old.friendlyStopPercent as number | undefined;
    const savedFriendlyDirectory = old.friendlyStopDirectory as string | undefined;
    if (savedFriendlyDirectory === undefined) {
      if (input.friendly_stop_percent !== undefined || input.friendly_stop_directory !== undefined) {
        throw new Error("follow-up cannot change friendly-stop settings on an unconfigured launch");
      }
    } else {
      if (input.friendly_stop_percent !== undefined && input.friendly_stop_percent !== savedFriendlyPercent) {
        throw new Error("follow-up friendly_stop_percent must match the saved launch");
      }
      if (input.friendly_stop_directory !== undefined && asPath(input.friendly_stop_directory, "friendly_stop_directory") !== savedFriendlyDirectory) {
        throw new Error("follow-up friendly_stop_directory must match the saved launch");
      }
    }
    const cwd = asPath(input.cwd, "cwd");
    const missionFile = asPath(input.mission_file, "mission_file");
    await requireDirectory(cwd, "cwd");
    await requireMission(missionFile);
    const reportPath = input.mode === "task" ? asPath(input.report_file, "report_file") : undefined;
    if (input.mode !== "task" && input.report_file !== undefined) throw new Error("dialogue mode must not include report_file");

    const knownState = this.states.get(jobId);
    if (knownState?.contextPauseId || knownState?.recoveryPending) {
      throw new Error("attempt is context-paused or recovering; use subagent_clean_and_continue, not a fresh follow-up");
    }
    if (!knownState?.finished && await this.paneIsBusy(paneId)) {
      throw new Error(`subagent ${jobId} is still handling its current turn; follow-up was not pasted`);
    }
    const reservation = input.mode === "task" ? await requireFreshReport(reportPath!, new Set()) : undefined;
    const replaceMonitor = knownState?.monitorJobId !== undefined && !knownState.finished;
    const currentStartGeneration = Number.parseInt(await this.show(paneId, START_GENERATION_OPTION) ?? "0", 10);
    const currentOutcomeGeneration = Number.parseInt(await this.show(paneId, OUTCOME_GENERATION_OPTION) ?? "0", 10);
    const attemptId = unique("subagent-attempt");
    const batchId = replaceMonitor ? knownState!.batchId : unique("subagent-followup-batch");
    const batch = replaceMonitor
      ? (() => {
        knownState!.monitorUnsubscribe?.();
        this.background.retireExternal(knownState!.monitorJobId!);
        knownState!.monitorUnsubscribe = undefined;
        knownState!.monitorJobId = undefined;
        return this.background.reopenBatch(batchId);
      })()
      : this.background.openBatch(batchId, 1);
    let state: StoredState | undefined;
    try {
      const manifestPath = await this.writeManifest({
        version: 1,
        jobId,
        attemptId,
        sessionId,
        mode: input.mode,
        reportPath,
        reportIdentity: reservation?.reportIdentity,
        batchId,
        activatedAt: reservation?.activatedAt,
        parentJobId: old.parentJobId,
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        friendlyStopPercent: savedFriendlyPercent,
        friendlyStopDirectory: savedFriendlyDirectory,
        startChannel: unique("pi-subagent-start"),
        startGeneration: Number.isSafeInteger(currentStartGeneration) ? currentStartGeneration : 0,
        outcomeGeneration: Number.isSafeInteger(currentOutcomeGeneration) ? currentOutcomeGeneration : 0,
      });
      const followupManifest = await this.readManifest(manifestPath);
      const startChannel = followupManifest.startChannel;
      if (!startChannel) throw new Error("follow-up manifest has no start channel");
      await this.set(paneId, TASK_LAUNCH_MANIFEST_OPTION, manifestPath);
      await this.verify(paneId, TASK_LAUNCH_MANIFEST_OPTION, manifestPath);
      await this.set(paneId, START_CHANNEL_OPTION, startChannel);
      await this.verify(paneId, START_CHANNEL_OPTION, startChannel);
      await this.set(paneId, "@pi_subagent_attempt_id", attemptId);
      await this.set(paneId, "@pi_subagent_mode", input.mode);

      state = {
        jobId,
        sessionId,
        attemptId,
        batchId,
        paneId,
        sessionLabel: await this.show(paneId, "@pi_subagent_session_label") ?? sessionId,
        cwd,
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        mode: input.mode,
        manifestPath,
        reportPath,
        startWaiters: new Map(),
        startResults: new Map(),
        outputBuffer: "",
        finished: false,
        friendlyStopPercent: savedFriendlyPercent,
        friendlyStopDirectory: savedFriendlyDirectory,
        parentJobId: old.parentJobId,
      };
      await this.armMonitor(state, batch);
      this.states.set(jobId, state);
      const startPromise = this.waitForStart(state, attemptId);
      await this.paste(paneId, missionFile, state);
      const started = await Promise.race([startPromise, this.timeout(START_WAIT_MS)]);
      batch.close();
      return {
        job: jobId,
        status: started ? "running" : "start_timeout",
        attempt_id: attemptId,
        session_id: sessionId,
        session_label: state.sessionLabel,
        pane_id: paneId,
        batch_id: batchId,
        manifest_file: manifestPath,
        report_file: reportPath,
        session_file: await this.show(paneId, SESSION_FILE_OPTION),
        monitor_log: state.monitorLogPath,
        error: started ? undefined : "START/session-file receipt timed out; saved pane and monitor evidence were preserved",
      };
    } catch (error) {
      this.cleanupFollowupFailure(batch, state, knownState, jobId, old.parentJobId, attemptId, error);
      throw error;
    }
  }

  private cleanupFollowupFailure(
    batch: ReturnType<BackgroundJobManager["openBatch"]>,
    state: StoredState | undefined,
    oldState: StoredState | undefined,
    jobId: string,
    parentJobId: string | undefined,
    attemptId: string,
    error: unknown,
  ): void {
    const summary = `release_failed: ${errorMessage(error)}; pane was preserved (attempt ${attemptId})`;
    if (state?.releaseBuffered) {
      batch.close();
      return;
    }
    if (state?.monitorJobId !== undefined) {
      state.releaseFailure = summary;
      state.monitorUnsubscribe?.();
      state.monitorUnsubscribe = undefined;
      this.background.retireExternal(state.monitorJobId);
      state.monitorJobId = undefined;
    }
    const failedState = state ?? oldState;
    if (failedState) {
      failedState.finished = true;
      failedState.monitorUnsubscribe = undefined;
      failedState.monitorJobId = undefined;
      this.states.set(jobId, failedState);
    }
    const status = this.background.getBatchStatus(batch.id);
    const shouldRecord = status !== undefined && !status.complete &&
      (status.members === 0 || status.finalized < status.members);
    if (shouldRecord) {
      batch.recordOutcome({ id: jobId, status: "failed", source: "transport", summary });
      if (parentJobId) this.recordParent(parentJobId, jobId, summary, "failed", "transport");
    }
    batch.close();
  }

  private async validateRoutes(inputs: readonly SubagentJobInput[]): Promise<void> {
    for (const input of inputs) {
      const provider = safeText(input.provider, "provider", 128);
      const modelId = safeText(input.model, "model", 512);
      if (!SAFE_ID.test(provider.replaceAll("/", "_")) || /[\s]/.test(provider)) throw new Error("provider is not a safe route identifier");
      if (input.thinking === undefined || !THINKING_LEVELS.includes(input.thinking)) throw new Error("thinking must be explicit and valid");
      if (input.mode !== "task" && input.mode !== "dialogue") throw new Error("mode must be task or dialogue");
      if (input.friendly_stop_percent !== undefined &&
          (!Number.isInteger(input.friendly_stop_percent) || input.friendly_stop_percent < 40 || input.friendly_stop_percent > 80)) {
        throw new Error("friendly_stop_percent must be an integer from 40 through 80");
      }
      if (input.friendly_stop_directory !== undefined) asPath(input.friendly_stop_directory, "friendly_stop_directory");
      if (input.friendly_stop_directory !== undefined && input.friendly_stop_percent === undefined && input.model !== FRIENDLY_PRODUCTION_MODEL) {
        throw new Error("friendly_stop_directory requires a friendly-stop percentage unless launching Astra");
      }
      if (!this.ctx.modelRegistry) throw new Error("model registry is unavailable; route cannot be verified");
      const model = this.ctx.modelRegistry.find(provider, modelId);
      const available = this.ctx.modelRegistry.getAvailable().some(candidate => candidate.provider === provider && candidate.id === modelId);
      if (!model || !available) throw new Error(`exact provider/model is unavailable: ${provider}/${modelId}`);
      if (!getSupportedThinkingLevels(model).includes(input.thinking)) {
        throw new Error(`model ${provider}/${modelId} does not support thinking level ${input.thinking}`);
      }
    }
  }

  private async prepare(
    item: {
      input: SubagentJobInput;
      jobId: string;
      attemptId: string;
      sessionId: string;
      batchId: string;
      sessionLabel: string;
      cwd: string;
      missionFile: string;
      reportPath?: string;
      reportIdentity?: { dev: string; ino: string };
      activatedAt?: number;
      parentJobId?: string;
    },
    parentPane: string,
    extensions: string[],
  ): Promise<StoredState> {
    let friendlyDirectory: string | undefined;
    const friendlyOptIn = item.input.friendly_stop_percent !== undefined || item.input.model === FRIENDLY_PRODUCTION_MODEL;
    if (friendlyOptIn) {
      const configured = item.input.friendly_stop_directory ?? process.env.PI_RLM_ROLLOVER_DIR ?? join(tmpdir(), `pi-friendly-stop-${item.jobId}`);
      friendlyDirectory = asPath(configured, "friendly_stop_directory");
      await mkdir(friendlyDirectory, { recursive: true, mode: 0o700 });
      await requireDirectory(friendlyDirectory, "friendly_stop_directory");
    }
    const parentSession = (await this.tmux(["display-message", "-p", "-t", parentPane, "#{session_id}"])).trim();
    if (!/^\$\d+$/.test(parentSession)) throw new Error("could not resolve parent tmux session");
    const paneId = (await this.tmux(["new-session", "-d", "-s", item.sessionLabel, "-c", item.cwd]),
      (await this.tmux(["list-panes", "-t", item.sessionLabel, "-F", "#{pane_id}"])).split(/\r?\n/).find(Boolean)?.trim());
    if (!paneId) throw new Error("tmux created no child pane");
    const manifestPath = await this.writeManifest({
      version: 1,
      jobId: item.jobId,
      attemptId: item.attemptId,
      sessionId: item.sessionId,
      mode: item.input.mode,
      reportPath: item.reportPath,
      reportIdentity: item.reportIdentity,
      batchId: item.batchId,
      activatedAt: item.activatedAt,
      parentJobId: item.parentJobId,
      friendlyStopPercent: item.input.friendly_stop_percent,
      friendlyStopDirectory: friendlyDirectory,
      provider: item.input.provider,
      model: item.input.model,
      thinking: item.input.thinking,
      startChannel: unique("pi-subagent-start"),
      startGeneration: 0,
      outcomeGeneration: 0,
    });
    const logPath = join(tmpdir(), `${item.jobId}.tmux.log`);
    await writeFile(logPath, "", { flag: "wx" });
    const values: Array<[string, string]> = [
      ["@pi_subagent_job_id", item.jobId],
      ["@pi_subagent_session_id", item.sessionId],
      ["@pi_subagent_session_label", item.sessionLabel],
      ["@pi_subagent_parent_id", parentSession],
      ["@pi_subagent_batch_id", item.batchId],
      ["@pi_subagent_attempt_id", item.attemptId],
      ["@pi_subagent_mode", item.input.mode],
      ["@pi_subagent_boot_barrier", unique("pi-subagent-boot")],
      [TASK_LAUNCH_MANIFEST_OPTION, manifestPath],
      [START_CHANNEL_OPTION, JSON.parse(await readFile(manifestPath, "utf8")).startChannel],
      [START_GENERATION_OPTION, "0"],
      [OUTCOME_CHANNEL_OPTION, unique("pi-subagent-outcome")],
      [OUTCOME_GENERATION_OPTION, "0"],
      [DONE_CHANNEL_OPTION, unique("pi-subagent-done")],
      [SETTLED_CHANNEL_OPTION, unique("pi-subagent-settled")],
      [SETTLED_GENERATION_OPTION, "0"],
    ];
    for (const [option, value] of values) await this.set(paneId, option, value);
    await this.tmux(["pipe-pane", "-t", paneId, `cat >> ${shellQuote(logPath)}`]);
    for (const [option, value] of values) await this.verify(paneId, option, value);
    const bootPath = join(tmpdir(), `${item.jobId}.boot`);
    const args = [
      "pi",
      ...extensions.flatMap(path => ["--extension", path]),
      "--provider", item.input.provider,
      "--model", item.input.model,
      "--thinking", item.input.thinking,
      "--name", item.sessionLabel,
      "--", `@${item.missionFile}`,
    ];
    const friendlyNames = ["PI_RLM_FRIENDLY_STOP_TOKENS", "PI_RLM_FRIENDLY_STOP_MODEL", "PI_RLM_FRIENDLY_STOP_PERCENT", "PI_RLM_ROLLOVER_DIR", "PI_RLM_FRIENDLY_STOP_GRACE_TURNS"];
    const friendlyEnv = friendlyOptIn ? [
      `PI_RLM_FRIENDLY_STOP_MODEL=${item.input.model}`,
      ...(item.input.friendly_stop_percent === undefined ? [] : [`PI_RLM_FRIENDLY_STOP_PERCENT=${item.input.friendly_stop_percent}`]),
      `PI_RLM_ROLLOVER_DIR=${friendlyDirectory}`,
    ] : [];
    const command = ["env", ...friendlyNames.flatMap(name => ["-u", name]), ...friendlyEnv, ...args];
    await writeFile(bootPath, `exec ${command.map(shellQuote).join(" ")}\n`, { flag: "wx" });
    await this.set(paneId, "@pi_subagent_boot_file", bootPath);
    return {
      jobId: item.jobId,
      sessionId: item.sessionId,
      attemptId: item.attemptId,
      batchId: item.batchId,
      paneId,
      sessionLabel: item.sessionLabel,
      cwd: item.cwd,
      provider: item.input.provider,
      model: item.input.model,
      thinking: item.input.thinking,
      mode: item.input.mode,
      friendlyStopPercent: item.input.friendly_stop_percent,
      friendlyStopDirectory: friendlyDirectory,
      manifestPath,
      reportPath: item.reportPath,
      startWaiters: new Map(),
      startResults: new Map(),
      outputBuffer: "",
      finished: false,
      parentJobId: item.parentJobId,
    };
  }

  private async armMonitor(state: StoredState, batch: ReturnType<BackgroundJobManager["openBatch"]>): Promise<void> {
    const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));
    const config = JSON.stringify({
      paneId: state.paneId,
      manifestOption: TASK_LAUNCH_MANIFEST_OPTION,
      outcomeOption: OUTCOME_OPTION,
      outcomeGenerationOption: OUTCOME_GENERATION_OPTION,
      startGenerationOption: START_GENERATION_OPTION,
      sessionFileOption: SESSION_FILE_OPTION,
      sessionIdOption: "@pi_session_id",
      outcomeChannel: await this.show(state.paneId, OUTCOME_CHANNEL_OPTION),
      pollMs: POLL_MS,
      startTimeoutMs: MONITOR_START_MS,
      jobId: state.jobId,
      attemptId: state.attemptId,
      sessionId: state.sessionId,
      mode: state.mode,
      resultModulePath: process.env.PI_PACKAGE_DIR
        ? join(process.env.PI_PACKAGE_DIR, "dist/core/result.js")
        : undefined,
    });
    const monitorJob = batch.startExternal(
      {
        command: `subagent monitor ${state.jobId}`,
        label: `subagent monitor ${state.sessionLabel}`,
        cwd: state.cwd,
        completionId: state.jobId,
      },
      () => spawn(process.execPath, [monitorPath, config], {
        cwd: state.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      { onStdout: chunk => this.onMonitorOutput(state, chunk) },
    );
    state.monitorJobId = monitorJob.job.id;
    state.monitorLogPath = monitorJob.job.logPath;
    state.monitorUnsubscribe = this.background.onJobSettled(monitorJob.job.id, (_job, completion) => {
      state.finished = true;
      state.monitorUnsubscribe = undefined;
      if (state.parentJobId && completion.status) {
        this.recordParent(state.parentJobId, state.jobId, completion.summary, completion.status, completion.source, state.attemptId);
      }
    });
  }

  private onMonitorOutput(state: StoredState, chunk: string): void {
    state.outputBuffer += chunk;
    while (true) {
      const newline = state.outputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = state.outputBuffer.slice(0, newline).trim();
      state.outputBuffer = state.outputBuffer.slice(newline + 1);
      if (!line) continue;
      let marker: any;
      try { marker = JSON.parse(line); } catch { continue; }
      if (state.finalAdmitted || marker.jobId !== state.jobId || marker.attemptId !== state.attemptId) continue;
      if (marker.sessionId) {
        if (state.piSessionId && state.piSessionId !== marker.sessionId) continue;
        state.piSessionId = marker.sessionId;
      }
      if (Number.isSafeInteger(marker.revision)) {
        if (marker.revision < (state.receiptRevision ?? 0)) continue;
        state.receiptRevision = marker.revision;
      }
      const admissionKey = marker.eventId ?? `${marker.kind}:${marker.pauseId ?? marker.summary ?? ""}`;
      const payload = JSON.stringify({ ...marker, revision: undefined });
      const admitted = state.admittedMarkers ??= new Map();
      if (admitted.has(admissionKey)) continue; // Conflicts cannot overwrite admitted evidence.
      admitted.set(admissionKey, payload);
      if (marker.kind === "final") {
        state.finalAdmitted = true;
        state.contextPauseId = undefined;
      }
      if (marker.kind === "active") {
        state.contextPauseId = undefined;
        continue;
      }
      if (marker.kind === "start" && marker.jobId === state.jobId && marker.attemptId === state.attemptId) {
        this.resolveStart(state, marker.attemptId, true);
      } else if (marker.kind === "context_paused" && marker.jobId === state.jobId && marker.attemptId === state.attemptId &&
          typeof marker.pauseId === "string" && SAFE_ID.test(marker.pauseId)) {
        if (state.contextPauseId === marker.pauseId) continue;
        const message = `Subagent ${state.jobId} paused for context (attempt ${state.attemptId}; session ${state.sessionId}):\n${marker.summary}`;
        try {
          const delivery = this.pi.sendUserMessage(message, {
            deliverAs: "steer",
            admissionKey: `subagent:${state.jobId}@${state.attemptId}:context_paused:${marker.pauseId}`,
          });
          if (delivery !== undefined) {
            void Promise.resolve(delivery).then(result => {
              if (admissionAccepted(result) && !state.finalAdmitted &&
                  (!marker.revision || marker.revision === state.receiptRevision)) state.contextPauseId = marker.pauseId;
            }).catch(() => {});
          } else {
            state.contextPauseId = marker.pauseId;
          }
        } catch {}
      } else if ((marker.kind === "maintenance_paused" || marker.kind === "maintenance_error") &&
          marker.jobId === state.jobId && marker.attemptId === state.attemptId) {
        try {
          this.pi.sendUserMessage(
            `Subagent ${state.jobId} (attempt ${marker.attemptId}) ${marker.kind === "maintenance_paused" ? "is under human maintenance" : "reported a maintenance error"}:\n${marker.summary ?? marker.kind}`,
            { deliverAs: "steer", admissionKey: `subagent:${state.jobId}@${state.attemptId}:${marker.kind}` },
          );
        } catch {}
      } else if (marker.kind === "needs_input" && marker.jobId === state.jobId && marker.attemptId === state.attemptId) {
        const message = `Subagent ${state.jobId} (attempt ${marker.attemptId}) needs input:\n${marker.summary ?? "child requested human input"}`;
        try {
          const result = this.pi.sendUserMessage(message, {
            deliverAs: "steer",
            admissionKey: `subagent:${state.jobId}@${state.attemptId}:needs_input`,
          });
          if (result !== undefined) {
            void Promise.resolve(result).then(admission => {
              if (!admissionAccepted(admission)) return;
            }).catch(() => {});
          }
        } catch {}
      } else if (marker.kind === "final" && marker.jobId === state.jobId && marker.attemptId === state.attemptId) {
        const status = marker.outcome === "completed" ? "completed" : marker.outcome === "blocked" ? "blocked" : "failed";
        const source = ["model", "technical", "protocol", "transport"].includes(marker.source)
          ? marker.source as OutcomeSource
          : "protocol" as const;
        const suffix = ` (attempt ${marker.attemptId}; session ${state.sessionId}; report ${marker.report || "none"}; monitor ${state.monitorLogPath || "pending"})`;
        const baseSummary = typeof marker.summary === "string" && marker.summary.length > 0
          ? marker.summary
          : marker.outcome;
        const summary = `${baseSummary.slice(0, Math.max(1, 20_000 - suffix.length))}${suffix}`;
        const reportText = typeof marker.reportText === "string" ? marker.reportText : undefined;
        const reportPath = typeof marker.dialogueReportPath === "string" ? marker.dialogueReportPath : undefined;
        const completion = { id: state.jobId, status, summary, source, reportText, reportPath } as const;
        if (status === "failed") {
          // A failed structured marker is effective failure evidence even when
          // the monitor itself later exits cleanly; do not wait for siblings.
          this.background.notifyFailure(state.batchId, completion);
        }
        if (state.monitorJobId !== undefined &&
            !(state.releaseFailure && !state.releaseBuffered)) {
          this.background.setCompletion(state.monitorJobId, completion);
        }
        this.resolveStart(state, marker.attemptId, false);
      }
    }
  }

  private async release(item: { state?: StoredState }): Promise<void> {
    const state = item.state!;
    const bootPath = await this.show(state.paneId, "@pi_subagent_boot_file");
    if (!bootPath) throw new Error("boot barrier file is missing");
    await this.paste(state.paneId, bootPath, state);
  }

  private async paste(paneId: string, filePath: string, state?: StoredState): Promise<void> {
    await this.tmux(["load-buffer", filePath]);
    if (state) state.releaseBuffered = true;
    await this.tmux(["paste-buffer", "-pr", "-t", paneId]);
    await this.tmux(["send-keys", "-t", paneId, "Enter"]);
  }

  private waitForStart(state: StoredState, attemptId: string): Promise<boolean> {
    const key = `${state.jobId}@${attemptId}`;
    return new Promise(resolve => {
      const waiters = state.startWaiters.get(key) ?? [];
      waiters.push(resolve);
      state.startWaiters.set(key, waiters);
      setTimeout(() => this.resolveStart(state, attemptId, false), START_WAIT_MS);
    });
  }

  private async paneIsBusy(paneId: string): Promise<boolean> {
    const started = Number.parseInt(await this.show(paneId, START_GENERATION_OPTION) ?? "", 10);
    const settled = Number.parseInt(await this.show(paneId, SETTLED_GENERATION_OPTION) ?? "", 10);
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(settled)) return true;
    return started > settled;
  }

  private async startWasSeen(state: StoredState, attemptId: string): Promise<boolean> {
    const key = `${state.jobId}@${attemptId}`;
    return state.startResults.get(key) === true;
  }

  private resolveStart(state: StoredState, attemptId: string, started: boolean): void {
    const key = `${state.jobId}@${attemptId}`;
    const waiters = state.startWaiters.get(key);
    if (!waiters) return;
    state.startWaiters.delete(key);
    state.startResults.set(key, started);
    for (const resolve of waiters) resolve(started);
  }

  private async timeout(ms: number): Promise<false> {
    await new Promise(resolve => setTimeout(resolve, ms));
    return false;
  }

  private async writeManifest(manifest: TaskLaunchManifest & Record<string, unknown>): Promise<string> {
    const path = join(tmpdir(), `${manifest.jobId}-${manifest.attemptId}.manifest.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    return path;
  }

  private async readManifest(path: string): Promise<TaskLaunchManifest & Record<string, any>> {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1 || typeof value.jobId !== "string" || typeof value.attemptId !== "string" ||
        typeof value.sessionId !== "string" || (value.mode !== "task" && value.mode !== "dialogue")) {
      throw new Error("invalid saved launcher manifest");
    }
    return value;
  }

  private async findPane(jobId: string, sessionId: string): Promise<string | undefined> {
    const panes = (await this.tmux(["list-panes", "-a", "-F", "#{pane_id}"])).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    for (const pane of panes) {
      if (await this.show(pane, "@pi_subagent_job_id") === jobId && await this.show(pane, "@pi_subagent_session_id") === sessionId) return pane;
    }
    return undefined;
  }

  private async set(pane: string, option: string, value: string): Promise<void> {
    await this.tmux(["set-option", "-q", "-t", pane, option, value]);
  }
  private async verify(pane: string, option: string, expected: string): Promise<void> {
    const actual = await this.show(pane, option);
    if (actual !== expected) throw new Error(`tmux option ${option} failed verification`);
  }
  private async show(pane: string, option: string): Promise<string | undefined> {
    try {
      const output = await this.tmux(["show-options", "-qv", "-t", pane, option]);
      return output.trim() || undefined;
    } catch { return undefined; }
  }
  private async tmux(args: string[]): Promise<string> {
    const result = await this.pi.exec("tmux", args);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `tmux ${args[0]} failed`).trim());
    return result.stdout;
  }
  private recordParent(
    parentJobId: string,
    childJobId: string,
    summary: string,
    status: "completed" | "failed" | "blocked" = "failed",
    source: OutcomeSource = "model",
    childAttemptId?: string,
  ): void {
    getTaskOutcomeManager(this.pi, this.ctx).recordChildOutcome(parentJobId, childJobId, status, summary, source, childAttemptId);
  }
}

export const launchJobSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  model: Type.String({ minLength: 1, maxLength: 512 }),
  thinking: StringEnum(THINKING_LEVELS, { description: "Explicit thinking level; never inferred." }),
  mission_file: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute nonempty mission file." }),
  cwd: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute working directory." }),
  session_label: Type.String({ minLength: 1, maxLength: 64 }),
  mode: StringEnum(["task", "dialogue"] as const),
  report_file: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  friendly_stop_percent: Type.Optional(Type.Integer({ minimum: 40, maximum: 80 })),
  friendly_stop_directory: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

export const launchSchema = Type.Object({ jobs: Type.Array(launchJobSchema, { minItems: 1, maxItems: MAX_JOBS }) }, { additionalProperties: false });
export const followupSchema = Type.Object({
  job_id: Type.String({ minLength: 1, maxLength: 128 }),
  session_id: Type.String({ minLength: 1, maxLength: 128 }),
  ...launchJobSchema.properties,
}, { additionalProperties: false });

const launcherRegistryKey = Symbol.for("pi.subagent-launch.launcher-registry");
const launcherHandoffKey = Symbol.for("pi.subagent-launch.maintenance-handoffs");
const launcherGlobal = globalThis as typeof globalThis & {
  [launcherRegistryKey]?: WeakMap<object, SubagentLauncher>;
  [launcherHandoffKey]?: Map<string, { launcher: SubagentLauncher; lease: MaintenanceHandoff }>;
};
const launchers = launcherGlobal[launcherRegistryKey] ??= new WeakMap();
const launcherHandoffs = launcherGlobal[launcherHandoffKey] ??= new Map();

export function parkSubagentLauncher(ctx: Pick<ExtensionContext, "sessionManager">, lease: MaintenanceHandoff): void {
  const launcher = launchers.get(ctx.sessionManager as object);
  if (!launcher) return;
  if (launcher.getSessionId() !== lease.sessionId) throw new Error("subagent launcher maintenance owner mismatch");
  launcherHandoffs.set(lease.maintenanceId, { launcher, lease: { ...lease } });
}

export function adoptSubagentLauncher(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  lease: MaintenanceHandoff,
): SubagentLauncher | undefined {
  const handoff = launcherHandoffs.get(lease.maintenanceId);
  if (!handoff) return undefined;
  if (handoff.lease.sessionId !== lease.sessionId || handoff.lease.ownerEpoch !== lease.ownerEpoch) {
    throw new Error("subagent launcher maintenance handoff token conflicts with its owner");
  }
  const launcher = handoff.launcher;
  launcher.attach(pi, ctx, getBackgroundJobManager(pi, ctx));
  launchers.set(ctx.sessionManager as object, launcher);
  launcherHandoffs.delete(lease.maintenanceId);
  return launcher;
}

export function registerSubagentTools(pi: ExtensionAPI): void {
  registerContextRecovery(pi);
  let launcher: SubagentLauncher | undefined;
  let launcherOwner: object | undefined;
  const forContext = (ctx: ExtensionContext): SubagentLauncher => {
    const owner = ctx.sessionManager as object;
    if (!launcher || launcherOwner !== owner) {
      launcher = launchers.get(owner) ?? new SubagentLauncher(pi, ctx, getBackgroundJobManager(pi, ctx));
      launcher.attach(pi, ctx, getBackgroundJobManager(pi, ctx));
      launcherOwner = owner;
      launchers.set(owner, launcher);
    }
    return launcher;
  };
  pi.registerTool({
    name: "subagent_launch",
    label: "subagent_launch",
    description: "Launch one or more saved interactive Pi subagents in ordinary tmux sessions. Every job requires an explicit provider/model/thinking route, absolute mission file, cwd, session label, and task/dialogue mode. Task mode also requires a fresh report file. Dialogue reports return automatically at clean settlement, verbatim when small or through a readable artifact when large. Returns verified per-job START/session receipts; partial setup failures never release an unarmed child. Task outcomes and batch completion are delivered from durable receipts, not process exit.",
    parameters: launchSchema,
    prepareArguments(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return input;
      const args = input as Record<string, unknown>;
      if (typeof args.jobs !== "string") return input;
      try {
        const jobs = JSON.parse(args.jobs);
        if (Array.isArray(jobs)) return { ...args, jobs };
      } catch {}
      return input;
    },
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const result = await forContext(ctx).launch(args.jobs as SubagentJobInput[]);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
  pi.registerTool({
    name: "subagent_clean_and_continue",
    label: "subagent_clean_and_continue",
    description: "Clean tool outputs and request continuation of a monitored context-paused subagent. Use the IDs from its pause notification. Preserves the same session, attempt, report and monitor; this is maintenance, not a fresh assignment. Requires an idle worker with no queued messages or pending children/background jobs. Refuses if cleaning cannot free enough context. No automatic retries; resume_requested is not task completion.",
    parameters: Type.Object({
      job_id: Type.String({ minLength: 1, maxLength: 128 }),
      session_id: Type.String({ minLength: 1, maxLength: 128 }),
      attempt_id: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await forContext(ctx).cleanAndContinue(args, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "maintenance" && event.maintenance) {
      adoptSubagentLauncher(pi, ctx, event.maintenance);
    }
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "maintenance" && event.maintenance) {
      parkSubagentLauncher(ctx, event.maintenance);
    }
  });

  pi.registerTool({
    name: "subagent_followup",
    label: "subagent_followup",
    description: "Continue a saved subagent by returned job_id/session_id. Supply the route explicitly again; it must match the saved route. Follow-ups create a fresh attempt and, in task mode, require a fresh report file. Dialogue reports return automatically at clean settlement, verbatim when small or through a readable artifact when large. The contract and monitor are armed before the mission file is pasted into the interactive pane.",
    parameters: followupSchema,
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const result = await forContext(ctx).followup(args as SubagentFollowupInput);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
