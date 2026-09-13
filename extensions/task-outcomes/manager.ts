import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, constants, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  adoptBackgroundJobManager,
  getBackgroundJobManager,
  type BackgroundJobManager,
  type BackgroundJobOutcomeStatus,
} from "../background-jobs/manager.ts";
import { assertMaintenanceAvailable, type MaintenanceHandoff, type MaintenancePhase } from "../_shared/maintenance.ts";

export const TASK_OUTCOME_ENTRY = "task-outcome/v1";
export const TASK_OUTCOME_EVENT = "task-outcome";

export type TaskMode = "task" | "dialogue";
export type DeclaredOutcome = "completed" | "blocked" | "needs_input" | "failed";
export type MonitorOutcome = DeclaredOutcome | "protocol_incomplete" | "dialogue_settled" | "transport_lost" | "context_paused" | "maintenance_paused" | "maintenance_error";
export type OutcomeSource = "model" | "technical" | "protocol" | "transport";

export interface MaintenanceLease extends MaintenanceHandoff {
  phase: MaintenancePhase;
}

export const TASK_LAUNCH_MANIFEST_OPTION = "@pi_subagent_manifest";

export interface ReportIdentity {
  dev: string;
  ino: string;
}

export interface TaskLaunchManifest extends TaskLaunchContract {
  version: 1;
  activatedAt?: number;
  startChannel?: string;
  startGeneration?: number;
  outcomeGeneration?: number;
}

export interface TaskLaunchContract {
  jobId: string;
  attemptId: string;
  mode: TaskMode;
  reportPath?: string;
  reportIdentity?: ReportIdentity;
  batchId?: string;
  parentJobId?: string;
  childJobIds?: readonly string[];
  ownerSessionId?: string;
}

export interface TaskOutcomeRecord {
  jobId: string;
  attemptId: string;
  outcome: MonitorOutcome;
  source: OutcomeSource;
  summary: string;
  reportPath?: string;
  at: string;
  final: boolean;
}

export interface TaskContractSnapshot extends Omit<TaskLaunchContract, "ownerSessionId" | "childJobIds"> {
  ownerSessionId: string;
  childJobIds: readonly string[];
  state: "active" | "awaiting_input" | "transport_lost" | "final" | "context_paused" | "maintenance_pending";
  contextPause?: { id: string; reason: string; limit: number };
  declaration?: { outcome: DeclaredOutcome; summary: string };
  pendingWork: readonly string[];
}

export interface TaskOutcomeSnapshot {
  active?: TaskContractSnapshot;
  contracts: readonly TaskContractSnapshot[];
  outcomes: readonly TaskOutcomeRecord[];
  maintenance?: MaintenanceLease & { error?: string };
}

export interface TaskDeclarationResult {
  jobId: string;
  attemptId: string;
  outcome: DeclaredOutcome;
  provisional: boolean;
  reportPath?: string;
  terminate: true;
}

interface Runtime {
  appendEntry: (customType: string, data?: unknown) => void;
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  emit: (channel: string, data: unknown) => void;
  sessionId: string;
  sessionFile?: string;
  sessionOwner: object;
  isIdle?: () => boolean;
  branchEntries: () => readonly any[];
  leafId: () => string | null;
  reloadSession?: (fallbackLeafId?: string | null, eventId?: string) => void;
}

interface ContractState extends TaskLaunchContract {
  ownerSessionId: string;
  childJobIds: string[];
  activatedAt: number;
  childGeneration: number;
  state: TaskContractSnapshot["state"];
  contextPause?: TaskContractSnapshot["contextPause"];
  declaration?: {
    outcome: DeclaredOutcome;
    summary: string;
    sequence: number;
    run: number;
    turn: number;
    workGeneration: number;
    childGeneration: number;
  };
  declarationSequence: number;
  workReadySequence: number;
  workReadyNotified: boolean;
  workReadyPendingSequence: number | undefined;
  childOutcomes: Map<string, { outcome: BackgroundJobOutcomeStatus; summary: string; source: OutcomeSource; attemptId?: string }>;
  questionNotified: boolean;
  maintenanceState?: MaintenanceLease & {
    previousState: Exclude<TaskContractSnapshot["state"], "maintenance_pending">;
    pausedNotified: boolean;
    error?: string;
  };
  cancellation?: { reason: string; source: "escape" | "task_cancel" | "extension"; eventId: string };
}

interface NotificationFlight {
  key: string;
  admissionKey: string;
  ownerSessionId: string;
  branchId: string;
  contractKey: string;
  leafId: string | null;
}

interface PersistedEvent {
  version: 1;
  eventId: string;
  branchId?: string;
  kind: "contract" | "declaration" | "declaration_invalidated" | "child_outcome" | "work_ready" | "outcome" | "transport_lost" | "context_pause" | "context_resume" | "maintenance_begin" | "maintenance_paused" | "maintenance_error" | "maintenance_resume" | "cancellation_requested";
  contextPause?: TaskContractSnapshot["contextPause"];
  maintenance?: MaintenanceHandoff & { phase: MaintenancePhase; previousState?: Exclude<TaskContractSnapshot["state"], "maintenance_pending">; error?: string };
  cancellation?: { reason: string; source: "escape" | "task_cancel" | "extension" };
  at: string;
  contract?: TaskLaunchContract & {
    ownerSessionId: string;
    childJobIds: string[];
    activatedAt: number;
    childGeneration?: number;
  };
  jobId?: string;
  attemptId?: string;
  outcome?: DeclaredOutcome | MonitorOutcome;
  source?: OutcomeSource;
  summary?: string;
  reportPath?: string;
  childJobId?: string;
  childAttemptId?: string;
  declarationSequence?: number;
  declarationWorkGeneration?: number;
  declarationChildGeneration?: number;
  workReadySequence?: number;
  notified?: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUMMARY_MAX = 20_000;

const assertId = (name: string, value: string): void => {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${name} must be 1-128 safe identifier characters`);
};

const assertSummary = (summary: string): string => {
  if (typeof summary !== "string" || summary.trim().length === 0) throw new Error("summary must be nonempty");
  if (summary.length > SUMMARY_MAX) throw new Error(`summary exceeds ${SUMMARY_MAX} characters`);
  return summary;
};

const isOutcome = (value: unknown): value is DeclaredOutcome =>
  value === "completed" || value === "blocked" || value === "needs_input" || value === "failed";

const isStatus = (value: unknown): value is BackgroundJobOutcomeStatus =>
  value === "completed" || value === "failed" || value === "blocked";

const isSource = (value: unknown): value is OutcomeSource =>
  value === "model" || value === "technical" || value === "protocol" || value === "transport";

const validReportIdentity = (value: unknown): value is ReportIdentity =>
  !!value && typeof value === "object" &&
  /^\d+$/.test((value as any).dev ?? "") && /^\d+$/.test((value as any).ino ?? "");

const reportIdentityMatches = (path: string, identity: ReportIdentity): boolean => {
  try {
    const info = lstatSync(path);
    return info.isFile() && String(info.dev) === identity.dev && String(info.ino) === identity.ino;
  } catch {
    return false;
  }
};

const createReportReservation = (path: string): { activatedAt: number; reportIdentity: ReportIdentity } => {
  const activatedAt = Date.now();
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("reservation is not a regular file");
    return { activatedAt, reportIdentity: { dev: String(info.dev), ino: String(info.ino) } };
  } catch (error) {
    throw new Error(`cannot reserve reportPath ${path}: ${errorMessage(error)}`);
  }
};

const cloneRecord = (record: TaskOutcomeRecord): TaskOutcomeRecord => ({ ...record });

const pathEntryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const eventPayload = (event: object): string => stableJson(Object.fromEntries(
  Object.entries(event).filter(([key]) => key !== "version" && key !== "eventId" && key !== "at" && key !== "branchId"),
));

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

export class TaskOutcomeManager {
  private readonly contracts = new Map<string, ContractState>();
  private readonly records: TaskOutcomeRecord[] = [];
  private readonly usedReportPaths = new Set<string>();
  private readonly pendingActivations = new Map<string, PersistedEvent>();
  private readonly notificationFlights = new Map<string, NotificationFlight>();
  private activeKey: string | undefined;
  private branchId = randomUUID();
  private notificationBranchId = randomUUID();
  private restored = false;
  private readonly corrections = new Map<string, { count: number; run: number }>();
  private run = 0;
  private turn = -1;
  private lastAssistant: any;
  private lastRunFailure: string | undefined;
  private lastInterruption?: { kind: "cancel" | "maintenance" | "lifecycle"; source: string; reason: string; operationId?: string };
  private maintenanceState?: MaintenanceLease & {
    previousState: Exclude<TaskContractSnapshot["state"], "maintenance_pending">;
    pausedNotified: boolean;
    error?: string;
  };
  private cancellation?: { reason: string; source: "escape" | "task_cancel" | "extension"; eventId: string };
  private workUnsubscribe: (() => void) | undefined;
  private observedLeafId: string | null;
  private runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.observedLeafId = runtime.leafId();
    this.replay();
  }

  attach(runtime: Runtime): void {
    const ownerChanged = this.runtime.sessionOwner !== runtime.sessionOwner || this.runtime.sessionId !== runtime.sessionId;
    if (ownerChanged) {
      this.pendingActivations.clear();
      this.notificationFlights.clear();
      this.branchId = randomUUID();
      this.notificationBranchId = randomUUID();
    }
    this.runtime = runtime;
    if (ownerChanged) this.observedLeafId = runtime.leafId();
  }

  adopt(runtime: Runtime, lease: MaintenanceHandoff): void {
    if (lease.sessionId !== runtime.sessionId ||
        (lease.sessionFile !== undefined && runtime.sessionFile !== undefined && resolve(lease.sessionFile) !== resolve(runtime.sessionFile)) ||
        (lease.branchAnchor !== undefined && lease.branchAnchor !== runtime.leafId())) {
      throw new Error("maintenance task manager handoff does not match the replacement session");
    }
    this.runtime = runtime;
    this.observedLeafId = runtime.leafId();
    const contract = this.activeContract();
    if (contract && contract.ownerSessionId === runtime.sessionId) {
      this.activeKey = this.key(contract.jobId, contract.attemptId);
      this.watchWork(contract, false);
    }
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    for (const contract of this.contracts.values()) {
      if (contract.ownerSessionId !== this.runtime.sessionId) continue;
      if (contract.state === "active" && !this.maintenanceState) {
        this.markTransportLost(contract, "monitor restarted before a final outcome");
      }
    }
    this.activeKey = [...this.contracts.values()]
      .filter(contract => contract.ownerSessionId === this.runtime.sessionId && contract.state === "context_paused")
      .map(contract => this.key(contract.jobId, contract.attemptId)).at(-1);
    this.retryPendingNotifications();
  }

  onSessionTree(): void {
    const nextLeafId = this.runtime.leafId();
    const branchChanged = this.observedLeafId !== nextLeafId;
    this.stopWatchingWork();
    this.contracts.clear();
    this.records.length = 0;
    this.usedReportPaths.clear();
    this.activeKey = undefined;
    this.maintenanceState = undefined;
    this.cancellation = undefined;
    this.branchId = randomUUID();
    if (branchChanged) {
      this.notificationBranchId = randomUUID();
      this.pendingActivations.clear();
      this.notificationFlights.clear();
    }
    this.observedLeafId = nextLeafId;
    this.replay();
    for (const contract of this.contracts.values()) {
      if ((contract.state === "active" || contract.state === "context_paused") && contract.ownerSessionId === this.runtime.sessionId) {
        this.activeKey = this.key(contract.jobId, contract.attemptId);
        this.watchWork(contract, false);
        if (contract.workReadyPendingSequence !== undefined && !contract.workReadyNotified) {
          void this.wakeIfReady(contract);
        }
      }
    }
    this.retryPendingNotifications();
    this.observedLeafId = this.runtime.leafId();
  }

  /**
   * Consume the launcher-written manifest before the next model request.
   * This is deliberately an extension lifecycle action, not a model/tool action.
   */
  ingestLauncherContract(): TaskContractSnapshot | undefined {
    const pane = process.env.TMUX_PANE;
    let manifestPath = process.env.PI_SUBAGENT_MANIFEST;
    if (pane) {
      try {
        const value = execFileSync("tmux", ["show-options", "-qv", "-t", pane, TASK_LAUNCH_MANIFEST_OPTION], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (value) manifestPath = value;
      } catch {
        // A normal non-tmux session, or a pane that is shutting down, has no manifest.
      }
    }
    if (!manifestPath) return undefined;
    if (!isAbsolute(manifestPath) || manifestPath.includes("\0")) {
      throw new Error("launcher manifest path must be absolute and NUL-free");
    }

    let manifest: TaskLaunchManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskLaunchManifest;
    } catch (error) {
      throw new Error(`cannot read launcher manifest ${manifestPath}: ${errorMessage(error)}`);
    }
    if (!manifest || typeof manifest !== "object" || manifest.version !== 1) {
      throw new Error(`invalid launcher manifest ${manifestPath}`);
    }
    const contract: TaskLaunchContract = {
      jobId: manifest.jobId,
      attemptId: manifest.attemptId,
      mode: manifest.mode,
      reportPath: manifest.reportPath,
      reportIdentity: manifest.reportIdentity,
      batchId: manifest.batchId,
      parentJobId: manifest.parentJobId,
      childJobIds: manifest.childJobIds,
    };
    assertId("manifest jobId", contract.jobId);
    assertId("manifest attemptId", contract.attemptId);
    const key = this.key(contract.jobId, contract.attemptId);
    const existing = this.contracts.get(key);
    const active = this.activeContract();
    const activeContinuation = !existing && active?.jobId === contract.jobId &&
      (active.state === "awaiting_input" || active.state === "transport_lost" ||
       (active.mode === "dialogue" && contract.mode === "dialogue"));
    if (active && this.key(active.jobId, active.attemptId) !== key && !activeContinuation) {
      throw new Error(`launcher manifest ${key} conflicts with active contract ${this.key(active.jobId, active.attemptId)}`);
    }
    if (existing) {
      if (stableJson(this.serializedContract(existing)) !== stableJson({
        ...contract,
        ownerSessionId: existing.ownerSessionId,
        childJobIds: [...existing.childJobIds],
        activatedAt: existing.activatedAt,
        childGeneration: existing.childGeneration,
      })) {
        throw new Error(`launcher manifest ${key} conflicts with its existing contract`);
      }
      return this.contractSnapshot(existing);
    }
    return this.activateContract({ ...contract, activatedAt: manifest.activatedAt });
  }

  activateContract(input: TaskLaunchContract & { activatedAt?: number }): TaskContractSnapshot {
    assertId("jobId", input.jobId);
    assertId("attemptId", input.attemptId);
    if (input.mode !== "task" && input.mode !== "dialogue") throw new Error("mode must be task or dialogue");
    if (input.parentJobId !== undefined) assertId("parentJobId", input.parentJobId);
    const childJobIds = [...new Set(input.childJobIds ?? [])];
    for (const childJobId of childJobIds) assertId("childJobId", childJobId);
    if (childJobIds.includes(input.jobId)) throw new Error("a task cannot be its own child");
    const key = this.key(input.jobId, input.attemptId);
    const contractEventId = `task-outcome:contract:${key}:0`;
    const pendingReservation = this.pendingActivations.get(contractEventId);
    const durableReservation = this.sidecarEvent(contractEventId) ??
      (this.activeBranchEntry(contractEventId)?.data as PersistedEvent | undefined);
    if (pendingReservation && durableReservation) this.assertEventPayload(pendingReservation, durableReservation);
    const reservation = durableReservation ?? pendingReservation;
    const reservedContract = reservation?.kind === "contract" ? reservation.contract : undefined;
    let reportPath = input.reportPath;
    let reportIdentity = input.reportIdentity ?? reservedContract?.reportIdentity;
    let activatedAt = Number.isFinite(reservedContract?.activatedAt)
      ? reservedContract!.activatedAt
      : Number.isFinite(input.activatedAt) ? input.activatedAt! : Date.now();
    if (input.mode === "task") {
      if (!reportPath || !isAbsolute(reportPath) || reportPath.includes("\0")) {
        throw new Error("task mode requires an absolute reportPath");
      }
      reportPath = resolve(reportPath);
      if (reportIdentity !== undefined && !validReportIdentity(reportIdentity)) {
        throw new Error("task reportIdentity is invalid");
      }
      const reservedReportPath = reservedContract?.reportPath
        ? resolve(reservedContract.reportPath)
        : undefined;
      let launcherReservationMatches = reportIdentity !== undefined && reportIdentityMatches(reportPath, reportIdentity);
      if (reportIdentity === undefined && !pathEntryExists(reportPath)) {
        const created = createReportReservation(reportPath);
        activatedAt = created.activatedAt;
        reportIdentity = created.reportIdentity;
        launcherReservationMatches = true;
      }
      if (reportIdentity !== undefined && !launcherReservationMatches) {
        throw new Error("task reportPath no longer matches its launch reservation");
      }
      if ((this.usedReportPaths.has(reportPath) || pathEntryExists(reportPath)) &&
          reservedReportPath !== reportPath && !launcherReservationMatches) {
        throw new Error("task reportPath must be a fresh, unused path for this attempt");
      }
    } else if (reportIdentity !== undefined) {
      throw new Error("dialogue mode must not include reportIdentity");
    }
    if (input.ownerSessionId && input.ownerSessionId !== this.runtime.sessionId) {
      throw new Error("launch contract belongs to another session");
    }

    if (this.contracts.has(key)) throw new Error(`attempt ${key} is already registered`);
    const previous = [...this.contracts.values()]
      .filter(contract => contract.jobId === input.jobId && contract.ownerSessionId === this.runtime.sessionId)
      .at(-1);
    const dialogueContinuation = previous?.mode === "dialogue" && input.mode === "dialogue";
    const finalContinuation = previous?.state === "final" && previous.mode === input.mode;
    if (previous && previous.state !== "awaiting_input" && previous.state !== "transport_lost" && !dialogueContinuation && !finalContinuation) {
      throw new Error(`job ${input.jobId} already has an active or final attempt`);
    }

    const contract: ContractState = {
      ...input,
      reportPath,
      reportIdentity,
      ownerSessionId: this.runtime.sessionId,
      childJobIds,
      activatedAt,
      childGeneration: reservedContract?.childGeneration ?? 0,
      state: "active",
      declarationSequence: 0,
      workReadySequence: 0,
      workReadyNotified: false,
      workReadyPendingSequence: undefined,
      childOutcomes: new Map(),
      questionNotified: false,
      maintenanceState: undefined,
      cancellation: undefined,
    };
    const members = contract.batchId ? [contract.jobId, ...childJobIds] : [];
    if (contract.batchId) this.background().assertCanRegisterOutcomes(contract.batchId, members);
    const contractEvent = { kind: "contract" as const, contract: this.serializedContract(contract) };
    const pending = this.pendingActivations.get(contractEventId);
    if (pending) this.assertEventPayload(pending, contractEvent);
    else this.pendingActivations.set(contractEventId, {
      version: 1,
      eventId: contractEventId,
      branchId: this.branchId,
      at: new Date().toISOString(),
      ...contractEvent,
    });
    try {
      this.persist(contractEvent, contractEventId);
      this.pendingActivations.delete(contractEventId);
    } catch (error) {
      const existing = this.durableActiveBranchEvent(contractEventId);
      if (!existing) throw error;
      this.assertEventPayload(existing, contractEvent);
      this.pendingActivations.delete(contractEventId);
    }
    if (contract.batchId) this.registerBatchMembers(contract.batchId, members);
    if (reportPath) this.usedReportPaths.add(reportPath);
    this.contracts.set(key, contract);
    this.activeKey = key;
    if (this.cancellation && this.cancellation.eventId.includes(`:${key}:`)) {
      contract.cancellation = this.cancellation;
    } else {
      this.cancellation = undefined;
    }
    this.watchWork(contract);
    return this.contractSnapshot(contract);
  }

  registerChild(parentJobId: string, childJobId: string): void {
    assertId("parentJobId", parentJobId);
    assertId("childJobId", childJobId);
    const parent = this.requireActive(parentJobId);
    if (parent.state !== "active") throw new Error(`attempt ${parent.attemptId} is not accepting new children`);
    if (parent.childJobIds.includes(childJobId)) return;
    if (childJobId === parent.jobId) throw new Error("a task cannot be its own child");
    const next = {
      ...parent,
      childJobIds: [...parent.childJobIds, childJobId],
      childGeneration: parent.childGeneration + 1,
    };
    const eventId = this.operationEventId("contract", parent, String(next.childGeneration));
    if (parent.batchId) this.background().assertCanRegisterOutcomes(parent.batchId, [childJobId]);
    const durable = this.persist({ kind: "contract", contract: this.serializedContract(next) }, eventId);
    if (!durable.contract) throw new Error("invalid durable child membership");
    const added = durable.contract.childJobIds.filter(child => !parent.childJobIds.includes(child));
    if (parent.batchId && added.length > 0) this.registerBatchMembers(parent.batchId, added);
    parent.childJobIds = [...durable.contract.childJobIds];
    parent.childGeneration = durable.contract.childGeneration ?? next.childGeneration;
  }

  recordChildOutcome(
    parentJobId: string,
    childJobId: string,
    outcome: BackgroundJobOutcomeStatus,
    summary: string,
    source: OutcomeSource = "model",
    childAttemptId?: string,
  ): void {
    assertId("parentJobId", parentJobId);
    if (childAttemptId !== undefined) assertId("childAttemptId", childAttemptId);
    assertId("childJobId", childJobId);
    if (!isStatus(outcome)) throw new Error("child outcome must be completed, failed, or blocked");
    if (!isSource(source)) throw new Error("child outcome source is invalid");
    const parent = this.requireActive(parentJobId);
    if (!parent.childJobIds.includes(childJobId)) throw new Error(`child ${childJobId} is not registered`);
    const text = assertSummary(summary);
    const outcomeKey = childAttemptId ? `${childJobId}@${childAttemptId}` : childJobId;
    const wasRecorded = parent.childOutcomes.has(outcomeKey);
    const durable = this.persist(
      {
        kind: "child_outcome",
        jobId: parent.jobId,
        attemptId: parent.attemptId,
        childJobId,
        childAttemptId,
        outcome,
        source,
        summary: text,
      },
      this.operationEventId("child_outcome", parent, outcomeKey),
    );
    if (!durable.childJobId || !isStatus(durable.outcome) || !durable.summary || !isSource(durable.source)) {
      throw new Error("invalid durable child outcome");
    }
    const durableKey = durable.childAttemptId ? `${durable.childJobId}@${durable.childAttemptId}` : durable.childJobId;
    parent.childOutcomes.set(durableKey, {
      outcome: durable.outcome,
      summary: durable.summary,
      source: durable.source,
      attemptId: durable.childAttemptId,
    });
    if (parent.batchId) {
      try {
        this.background().recordOutcome(parent.batchId, {
          id: durable.childJobId,
          status: durable.outcome,
          summary: durable.summary,
          source: durable.source,
        });
      } catch {}
    }
    if (!wasRecorded) void this.wakeIfReady(parent);
  }

  closeBatch(batchId: string): void {
    assertId("batchId", batchId);
    this.background().closeBatch(batchId);
  }

  async declare(outcome: DeclaredOutcome, summary: string): Promise<TaskDeclarationResult> {
    if (!isOutcome(outcome)) throw new Error("outcome must be completed, blocked, needs_input, or failed");
    const text = assertSummary(summary);
    const contract = this.requireActive();
    if (contract.state !== "active" || this.maintenanceState) throw new Error(`attempt ${contract.attemptId} is not active`);
    if (contract.declaration) throw new Error(`attempt ${contract.attemptId} already declared an outcome`);
    const declarationWorkGeneration = this.background().workGeneration();
    const declarationChildGeneration = contract.childGeneration;

    if (outcome === "completed") {
      await this.verifyReport(contract);
      if (this.maintenanceState || this.activeContract() !== contract || contract.state !== "active") {
        throw new Error("maintenance or finality changed while validating the report");
      }
      const pending = this.pendingWork(contract);
      if (pending.length > 0) throw new Error(`completed is premature; pending work: ${pending.join(", ")}`);
    }

    const declarationSequence = contract.declarationSequence;
    const declaration = {
      outcome,
      summary: text,
      sequence: declarationSequence,
      run: this.run,
      turn: this.turn,
      workGeneration: declarationWorkGeneration,
      childGeneration: declarationChildGeneration,
    };
    const durableDeclaration = this.persist({
      kind: "declaration",
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome,
      summary: text,
      reportPath: contract.reportPath,
      declarationSequence,
      declarationWorkGeneration: declaration.workGeneration,
      declarationChildGeneration: declaration.childGeneration,
    }, this.operationEventId("declaration", contract, String(declarationSequence)));
    if (!isOutcome(durableDeclaration.outcome) || !durableDeclaration.summary) {
      throw new Error("invalid durable declaration");
    }
    const durableDeclarationState = {
      ...declaration,
      outcome: durableDeclaration.outcome,
      summary: durableDeclaration.summary,
      workGeneration: durableDeclaration.declarationWorkGeneration ?? declaration.workGeneration,
      childGeneration: durableDeclaration.declarationChildGeneration ?? declaration.childGeneration,
    };

    if (durableDeclarationState.outcome === "needs_input") {
      const durableOutcome = this.persist({
        kind: "outcome",
        jobId: contract.jobId,
        attemptId: contract.attemptId,
        outcome: durableDeclarationState.outcome,
        source: "model",
        summary: durableDeclarationState.summary,
        reportPath: durableDeclaration.reportPath ?? contract.reportPath,
        notified: false,
      }, this.operationEventId("outcome", contract, "needs_input"));
      if (!isOutcome(durableOutcome.outcome) || !durableOutcome.summary || !durableOutcome.source) {
        throw new Error("invalid durable needs-input outcome");
      }
      const question = `Task ${contract.jobId} (attempt ${contract.attemptId}) needs human input:\n${durableOutcome.summary}`;
      contract.declaration = durableDeclarationState;
      contract.declarationSequence += 1;
      contract.state = "awaiting_input";
      contract.questionNotified = false;
      this.records.push({
        jobId: contract.jobId,
        attemptId: contract.attemptId,
        outcome: durableOutcome.outcome,
        source: durableOutcome.source,
        summary: durableOutcome.summary,
        reportPath: durableOutcome.reportPath,
        at: durableOutcome.at,
        final: false,
      });
      void this.notifyQuestion(contract, question);
      this.emitOutcome({
        contract,
        outcome: durableOutcome.outcome,
        source: durableOutcome.source,
        summary: durableOutcome.summary,
        final: false,
      });
    } else {
      contract.declaration = durableDeclarationState;
      contract.declarationSequence += 1;
    }

    return {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: durableDeclarationState.outcome,
      provisional: durableDeclarationState.outcome !== "needs_input",
      reportPath: contract.reportPath,
      terminate: true,
    };
  }

  taskInstruction(): string | undefined {
    const contract = this.activeContract();
    if (!contract || contract.mode !== "task" || contract.state !== "active") return undefined;
    return `SYSTEM TASK CONTRACT: ${contract.jobId}/${contract.attemptId}
You are a task subagent. A prose answer alone does not complete this task.
Write your report to ${JSON.stringify(contract.reportPath)}. This file is already reserved: write into it without deleting, replacing, or renaming it.
Then call report_outcome with an honest outcome and summary. Use completed only after writing a readable nonempty report and finishing all tracked child/background work. Otherwise declare blocked, needs_input, or failed with the reason; include partial findings in the report when possible. Never invent success to satisfy this contract.
The declaration is provisional until clean settlement. Do not start more work after declaring. Missing declarations trigger at most two corrective turns, then protocol failure.`;
  }

  beginMaintenance(sessionFile?: string): MaintenanceLease {
    assertMaintenanceAvailable();
    const existing = this.maintenanceState;
    if (existing) {
      if (existing.phase === "error") throw new Error(existing.error ?? "maintenance is in an error state");
      if (existing.sessionId !== this.runtime.sessionId ||
          (sessionFile !== undefined && existing.sessionFile !== undefined && resolve(existing.sessionFile) !== resolve(sessionFile))) {
        throw new Error("another maintenance operation is already in progress");
      }
      return { ...existing };
    }
    if (this.cancellation) throw new Error("cancellation is already committed; maintenance is rejected");
    const current = this.activeContract();
    const latestOwned = [...this.contracts.values()]
      .filter(contract => contract.ownerSessionId === this.runtime.sessionId)
      .at(-1);
    if (current?.state === "final" || (!current && latestOwned?.state === "final")) {
      throw new Error("cannot take over a finalized task attempt");
    }
    if (sessionFile !== undefined && this.runtime.sessionFile !== undefined &&
        resolve(sessionFile) !== resolve(this.runtime.sessionFile)) {
      throw new Error("maintenance target is not the current session file");
    }
    const maintenanceId = randomUUID();
    const lease = {
      maintenanceId,
      ownerEpoch: randomUUID(),
      sessionId: this.runtime.sessionId,
      sessionFile: sessionFile ?? this.runtime.sessionFile,
      branchAnchor: this.runtime.leafId(),
      jobId: current?.jobId,
      attemptId: current?.attemptId,
      phase: "pending" as const,
    };
    const previousState = (current?.state ?? "active") as Exclude<TaskContractSnapshot["state"], "maintenance_pending">;
    this.persist({
      kind: "maintenance_begin",
      jobId: current?.jobId,
      attemptId: current?.attemptId,
      maintenance: { ...lease, previousState },
    }, `task-outcome:maintenance_begin:${maintenanceId}`);
    this.maintenanceState = { ...lease, previousState, pausedNotified: false };
    if (current) {
      current.maintenanceState = this.maintenanceState;
      current.state = "maintenance_pending";
    }
    try {
      this.background().beginMaintenance(maintenanceId);
    } catch (error) {
      this.failMaintenance(lease, error);
      throw error;
    }
    return { ...lease };
  }

  parkMaintenance(lease: MaintenanceHandoff): void {
    if (this.maintenanceState?.maintenanceId !== lease.maintenanceId) {
      throw new Error("maintenance lease is not owned by this task manager");
    }
    this.maintenanceState.phase = "parked";
  }

  claimMaintenance(lease: MaintenanceHandoff): void {
    if (!this.maintenanceState || this.maintenanceState.maintenanceId !== lease.maintenanceId ||
        (this.maintenanceState.phase !== "parked" && this.maintenanceState.phase !== "pending")) {
      throw new Error("maintenance task manager handoff is stale");
    }
    this.maintenanceState.phase = "claimed";
  }

  requestCancellation(
    source: "escape" | "task_cancel" | "extension" = "extension",
    reason = "cancelled",
  ): void {
    const contract = this.activeContract();
    if (contract?.state === "final") throw new Error("task attempt is already final");
    if (this.cancellation) return;
    const eventId = contract
      ? this.operationEventId("cancellation_requested", contract, source)
      : `task-outcome:cancellation_requested:${this.runtime.sessionId}:${source}`;
    this.persist({
      kind: "cancellation_requested",
      jobId: contract?.jobId,
      attemptId: contract?.attemptId,
      cancellation: { source, reason },
    }, eventId);
    this.cancellation = { source, reason, eventId };
    if (contract) contract.cancellation = this.cancellation;
    if (this.maintenanceState && this.runtime.isIdle?.() && contract && contract.state !== "final") {
      this.maintenanceState = undefined;
      this.finalize(contract, "failed", "technical", `cancelled: ${reason}`);
    }
  }

  failMaintenance(lease: MaintenanceHandoff, error: unknown): void {
    const current = this.maintenanceState;
    if (!current || current.maintenanceId !== lease.maintenanceId) return;
    const summary = `maintenance_error: ${errorMessage(error)}`.slice(0, SUMMARY_MAX);
    if (current.phase === "error" && current.error === summary) return;
    const contract = this.activeContract();
    this.persist({
      kind: "maintenance_error",
      jobId: contract?.jobId ?? lease.jobId,
      attemptId: contract?.attemptId ?? lease.attemptId,
      maintenance: { ...lease, phase: "error", error: summary },
      summary,
    }, `task-outcome:maintenance_error:${lease.maintenanceId}`);
    current.phase = "error";
    current.error = summary;
    this.records.push({
      jobId: contract?.jobId ?? lease.jobId ?? "session",
      attemptId: contract?.attemptId ?? lease.attemptId ?? lease.maintenanceId,
      outcome: "maintenance_error",
      source: "technical",
      summary,
      at: new Date().toISOString(),
      final: false,
    });
    if (contract) {
      this.emitOutcome({ contract, outcome: "maintenance_error", source: "technical", summary, final: false });
    }
  }

  resumeMaintenance(lease: MaintenanceHandoff): void {
    const current = this.maintenanceState;
    if (!current || current.maintenanceId !== lease.maintenanceId) {
      throw new Error("maintenance lease is not active");
    }
    if (current.phase === "error") throw new Error(current.error ?? "maintenance failed");
    if (this.cancellation) throw new Error("maintenance was cancelled");
    const contract = this.activeContract();
    this.persist({
      kind: "maintenance_resume",
      jobId: contract?.jobId ?? lease.jobId,
      attemptId: contract?.attemptId ?? lease.attemptId,
      maintenance: { ...lease, phase: "claimed" },
    }, `task-outcome:maintenance_resume:${lease.maintenanceId}`);
    if (contract) {
      contract.state = current.previousState;
      contract.maintenanceState = undefined;
      this.activeKey = this.key(contract.jobId, contract.attemptId);
      if (contract.state === "active") {
        this.watchWork(contract, false);
        void this.wakeIfReady(contract);
      }
    }
    this.background().resumeMaintenance(lease.maintenanceId);
    this.maintenanceState = undefined;
    this.lastRunFailure = undefined;
    this.lastInterruption = undefined;
  }

  pauseForContext(reason: string, limit: number): boolean {
    const contract = this.activeContract();
    if (!contract || !["active", "context_paused"].includes(contract.state)) return false;
    if (contract.contextPause) return true;
    assertSummary(reason);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid context limit");
    const contextPause = { id: randomUUID(), reason, limit };
    this.persist({ kind: "context_pause", jobId: contract.jobId, attemptId: contract.attemptId, contextPause });
    contract.contextPause = contextPause;
    contract.state = "context_paused";
    return true;
  }

  resumeAfterContextClean(jobId: string, attemptId: string, pauseId: string, tokens: number): void {
    const contract = this.requireActive(jobId);
    if (contract.attemptId !== attemptId || contract.state !== "context_paused" || contract.contextPause?.id !== pauseId) {
      throw new Error("context recovery no longer matches the paused attempt");
    }
    if (!Number.isFinite(tokens) || tokens < 0 || tokens >= contract.contextPause.limit) {
      throw new Error("cleaned context is still over the limit; assignment remains paused");
    }
    if (this.pendingWork(contract).length > 0) throw new Error("cannot reload while child/background work is pending");
    this.persist({ kind: "context_resume", jobId, attemptId }, this.operationEventId("context_resume", contract, pauseId));
    contract.contextPause = undefined;
    contract.state = "active";
    contract.declaration = undefined;
    this.lastRunFailure = undefined;
    this.corrections.delete(this.key(jobId, attemptId));
    this.watchWork(contract);
  }

  onAgentStart(): void {
    this.run += 1;
    this.turn = -1;
    this.lastAssistant = undefined;
    this.lastRunFailure = undefined;
    this.lastInterruption = undefined;
    const contract = this.activeContract();
    if (contract) contract.workReadyNotified = false;
  }

  onTurnStart(turnIndex: number): void {
    this.turn = turnIndex;
  }

  onTurnEnd(_message: any): void {}

  onAgentEnd(
    messages: readonly any[],
    interruption?: { kind: "cancel" | "maintenance" | "lifecycle"; source: string; reason: string; operationId?: string },
  ): void {
    const assistant = [...messages].reverse().find(message => message?.role === "assistant");
    this.lastAssistant = assistant;
    this.lastInterruption = interruption;
    const contract = this.activeContract();
    if (interruption?.kind === "cancel" && contract && contract.state !== "final") {
      this.requestCancellation(
        interruption.source === "escape" || interruption.source === "task_cancel" || interruption.source === "extension"
          ? interruption.source
          : "extension",
        interruption.reason,
      );
    }
    if (!assistant) return;
    if (assistant.stopReason === "error") {
      this.lastRunFailure = assistant.errorMessage || "assistant error";
    } else if (assistant.stopReason === "aborted" && !interruption?.kind && contract?.state !== "context_paused" && !this.maintenanceState) {
      // Older hosts do not provide interruption metadata. An unmarked abort is
      // still a user cancellation, never a provider outage.
      this.requestCancellation("extension", assistant.errorMessage || "assistant aborted");
      this.lastRunFailure = undefined;
    } else if (assistant.stopReason === "aborted") {
      this.lastRunFailure = undefined;
    } else {
      this.lastRunFailure = undefined;
    }
  }

  async onAgentSettled(hasPendingMessages: boolean): Promise<void> {
    const contract = this.activeContract();
    if (this.cancellation && contract && contract.state !== "final") {
      this.maintenanceState = undefined;
      this.finalize(contract, "failed", "technical", `cancelled: ${this.cancellation.reason}`);
      return;
    }
    if (this.maintenanceState) {
      if (contract && !this.maintenanceState.pausedNotified) {
        const eventId = `task-outcome:maintenance_paused:${this.maintenanceState.maintenanceId}`;
        const durable = this.persist({
          kind: "maintenance_paused",
          jobId: contract.jobId,
          attemptId: contract.attemptId,
          maintenance: { ...this.maintenanceState, phase: this.maintenanceState.phase },
          outcome: "maintenance_paused",
          source: "technical",
          summary: "human maintenance takeover paused the current run",
        }, eventId);
        this.maintenanceState.pausedNotified = true;
        this.emitOutcome({
          contract,
          outcome: "maintenance_paused",
          source: "technical",
          summary: durable.summary ?? "human maintenance takeover paused the current run",
          final: false,
        });
      }
      return;
    }
    if (this.lastInterruption?.kind === "lifecycle") return;
    if (contract?.state === "context_paused" && contract.contextPause) {
      // A known local context block is recoverable, not a generic final abort.
      // A pause is not completion: queued input must not hide the original cause.
      // Maintenance checks idle/queue state separately before changing anything.
      this.emitOutcome({ contract, outcome: "context_paused", source: "technical",
        summary: contract.contextPause.reason, final: false });
      return;
    }
    if (!contract || contract.state !== "active" || hasPendingMessages) return;
    // Persistent SessionManager instances can hold entries in memory before Pi
    // writes the first assistant response. Do not publish a settlement that a
    // restart cannot reach; in-memory sessions have no file boundary to check.
    if (this.runtime.sessionFile && !pathEntryExists(this.runtime.sessionFile)) return;

    if (this.lastRunFailure) {
      this.finalize(contract, "failed", "technical", `provider/transport failure: ${this.lastRunFailure}`);
      return;
    }

    const declaration = contract.declaration;
    if (declaration) {
      const pending = this.pendingWork(contract);
      const workStartedAfterDeclaration = this.background().workGeneration() > declaration.workGeneration;
      const childWorkStartedAfterDeclaration = contract.childGeneration > declaration.childGeneration;
      if (declaration.outcome === "completed" &&
          (pending.length > 0 || workStartedAfterDeclaration || childWorkStartedAfterDeclaration)) {
        this.persist({
          kind: "declaration_invalidated",
          jobId: contract.jobId,
          attemptId: contract.attemptId,
          declarationSequence: declaration.sequence,
          summary: pending.length > 0
            ? `work remained at settlement: ${pending.join(", ")}`
            : "work started after the completed declaration",
        }, this.operationEventId("declaration_invalidated", contract, String(declaration.sequence)));
        contract.declaration = undefined;
        void this.wakeIfReady(contract);
        return;
      }
      if (declaration.outcome === "completed") {
        try {
          await this.verifyReport(contract);
        } catch (error) {
          if (this.maintenanceState || this.cancellation || contract.state !== "active") return;
          this.finalize(contract, "failed", "technical", `report invalid at settlement: ${errorMessage(error)}`);
          return;
        }
      }
      if (this.maintenanceState || this.cancellation || this.activeContract() !== contract || contract.state !== "active") return;
      this.finalize(contract, declaration.outcome, "model", declaration.summary);
      return;
    }

    const pending = this.pendingWork(contract);
    if (pending.length > 0) return;
    if (contract.mode === "dialogue") {
      const response = assistantText(this.lastAssistant);
      if (response === undefined) {
        this.finalize(contract, "failed", "protocol", "protocol-incomplete: settled dialogue has no valid assistant text");
      } else {
        this.finalize(contract, "dialogue_settled", "model", dialogueSummary(response), true, response);
      }
      return;
    }
    const key = this.key(contract.jobId, contract.attemptId);
    const previous = this.corrections.get(key);
    // Duplicate settlement callbacks must not consume retries or enqueue twice.
    if (previous?.run === this.run) return;
    if ((previous?.count ?? 0) >= 2) {
      this.finalize(contract, "failed", "protocol", "protocol-incomplete: task settled without a structured outcome declaration after two corrective turns");
      return;
    }
    let missing = "No accepted report_outcome declaration.";
    try { await this.verifyReport(contract); }
    catch (error) { missing += ` Report validation: ${errorMessage(error)}.`; }
    // Recheck after asynchronous validation in case shutdown or another callback intervened.
    if (this.activeContract() !== contract || contract.state !== "active" || this.maintenanceState || this.cancellation || this.corrections.get(key)?.run === this.run) return;
    const correctionNumber = (previous?.count ?? 0) + 1;
    this.corrections.set(key, { count: correctionNumber, run: this.run });
    const admissionKey = this.operationEventId("outcome", contract, `correction:${correctionNumber}`);
    const admissionGuard = () => this.activeContract() === contract && contract.state === "active";
    const failed = (error: unknown) => {
      if (this.activeContract() === contract && contract.state === "active") {
        this.finalize(contract, "failed", "protocol", `protocol-incomplete: cannot queue task correction: ${errorMessage(error)}`);
      }
    };
    try {
      const delivery = this.runtime.sendUserMessage(
        `SYSTEM (task-outcomes): Task remains incomplete. ${missing}\n${this.taskInstruction()}`,
        { deliverAs: "followUp", admissionKey, admissionGuard },
      );
      // Delivery can cover the next model run; never await it inside settlement.
      void Promise.resolve(delivery).then(result => {
        if (!admissionAccepted(result)) throw admissionError(result);
      }).catch(failed);
    } catch (error) { failed(error); }
  }

  shutdown(reason: string): void {
    const contract = this.activeContract();
    if (contract && contract.state === "active") this.markTransportLost(contract, reason);
    this.stopWatchingWork();
    this.activeKey = undefined;
    this.pendingActivations.clear();
    this.notificationFlights.clear();
  }

  snapshot(): TaskOutcomeSnapshot {
    return {
      active: this.activeContract() ? this.contractSnapshot(this.activeContract()!) : undefined,
      contracts: [...this.contracts.values()].map(contract => this.contractSnapshot(contract)),
      outcomes: this.records.map(cloneRecord),
      maintenance: this.maintenanceState ? { ...this.maintenanceState } : undefined,
    };
  }

  private contractSnapshot(contract: ContractState): TaskContractSnapshot {
    return {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      mode: contract.mode,
      reportPath: contract.reportPath,
      batchId: contract.batchId,
      parentJobId: contract.parentJobId,
      childJobIds: [...contract.childJobIds],
      ownerSessionId: contract.ownerSessionId,
      state: contract.state,
      contextPause: contract.contextPause && { ...contract.contextPause },
      declaration: contract.declaration && { outcome: contract.declaration.outcome, summary: contract.declaration.summary },
      pendingWork: this.pendingWork(contract),
    };
  }

  private activeContract(): ContractState | undefined {
    return this.activeKey ? this.contracts.get(this.activeKey) : undefined;
  }

  private requireActive(jobId?: string): ContractState {
    const contract = this.activeContract();
    if (!contract || (jobId !== undefined && contract.jobId !== jobId)) {
      throw new Error(jobId ? `no active attempt for job ${jobId}` : "no active task/dialogue contract");
    }
    return contract;
  }

  private pendingWork(contract: ContractState): string[] {
    const pending = contract.childJobIds
      .filter(childJobId => ![...contract.childOutcomes.keys()].some(key => key === childJobId || key.startsWith(`${childJobId}@`)))
      .map(childJobId => `child:${childJobId}`);
    const running = this.background().stats().running;
    if (running > 0) pending.push(`background:${running} running job(s)`);
    return pending;
  }

  private async verifyReport(contract: ContractState): Promise<void> {
    if (!contract.reportPath) throw new Error("task has no expected report path");
    if (!contract.reportIdentity) throw new Error("report reservation identity is missing");
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      throw new Error("report validation cannot safely reject links or blocking special files on this platform");
    }
    const file = await open(contract.reportPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1) throw new Error("report must be a readable nonempty file");
      if (String(info.dev) !== contract.reportIdentity.dev || String(info.ino) !== contract.reportIdentity.ino) {
        throw new Error("report no longer matches its launch reservation");
      }
      if (Number.isFinite(info.birthtimeMs) && info.birthtimeMs + 1 < contract.activatedAt) {
        throw new Error("report must be created after this attempt was activated");
      }
      const buffer = Buffer.alloc(1);
      const result = await file.read(buffer, 0, 1, 0);
      if (result.bytesRead !== 1) throw new Error("report must be a readable nonempty file");
    } finally {
      await file.close();
    }
  }

  private finalize(
    contract: ContractState,
    outcome: MonitorOutcome,
    source: OutcomeSource,
    summary: string,
    emit = true,
    reportText?: string,
  ): void {
    if (contract.state === "final" || (this.maintenanceState && !this.cancellation) || this.activeContract() !== contract) return;
    if (this.cancellation && !(outcome === "failed" && source === "technical")) return;
    const durable = this.persist({
      kind: "outcome",
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome,
      source,
      summary,
      reportPath: contract.reportPath,
    }, this.operationEventId("outcome", contract, "final"));
    if (!durable.outcome || !durable.source || !durable.summary) throw new Error("invalid durable task outcome");
    const record: TaskOutcomeRecord = {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: durable.outcome,
      source: durable.source,
      summary: durable.summary,
      reportPath: durable.reportPath,
      at: durable.at,
      final: true,
    };
    this.records.push(record);
    contract.state = "final";
    if (this.activeKey === this.key(contract.jobId, contract.attemptId)) this.activeKey = undefined;
    this.stopWatchingWork();

    if (contract.batchId && isStatus(record.outcome)) {
      try {
        this.background().recordOutcome(contract.batchId, {
          id: contract.jobId,
          status: record.outcome,
          summary: `${record.summary} (attempt ${contract.attemptId})`,
          source: record.source,
        });
      } catch {
        // The durable record and monitor event remain authoritative if a manager was replaced.
      }
    }
    if (emit) this.emitOutcome({
      contract,
      outcome: record.outcome,
      source: record.source,
      summary: record.summary,
      final: true,
      reportText,
    });
  }

  private async notifyQuestion(contract: ContractState, question: string): Promise<void> {
    const flight = this.beginNotification(contract, this.operationEventId("outcome", contract, "needs_input:attempted"));
    if (!flight) return;
    try {
      try {
        const admissionGuard = () => {
          const current = this.currentNotificationContract(flight);
          return current?.state === "awaiting_input" && !current.questionNotified;
        };
        const result = contract.batchId && this.background().getBatchStatus(contract.batchId)
          ? this.background().notifyNeedsInput(contract.batchId, question, flight.admissionKey, admissionGuard)
          : this.runtime.sendUserMessage(question, {
              deliverAs: "steer",
              admissionKey: flight.admissionKey,
              admissionGuard,
            });
        const accepted = result === undefined ? undefined : await Promise.resolve(result);
        if (!admissionAccepted(accepted)) throw admissionError(accepted);
      } catch {
        // A rejected invocation remains unaccepted and is retried by a later monitor.
        return;
      }
      const current = this.currentNotificationContract(flight);
      if (!current || current.state !== "awaiting_input" || current.questionNotified) return;
      current.questionNotified = true;
      try {
        this.persist({
          kind: "outcome",
          jobId: current.jobId,
          attemptId: current.attemptId,
          outcome: "needs_input",
          source: "model",
          summary: current.declaration?.summary ?? question,
          reportPath: current.reportPath,
          notified: true,
        }, this.operationEventId("outcome", current, "needs_input:attempted"));
      } catch {
        // The invocation was accepted, but the durable attempted marker remains retryable.
      }
    } finally {
      this.endNotification(flight);
    }
  }

  private retryPendingNotifications(): void {
    for (const contract of this.contracts.values()) {
      if (contract.ownerSessionId !== this.runtime.sessionId ||
          contract.state !== "awaiting_input" || contract.questionNotified) continue;
      const summary = contract.declaration?.summary;
      if (!summary) continue;
      void this.notifyQuestion(contract, `Task ${contract.jobId} (attempt ${contract.attemptId}) needs human input:\n${summary}`);
    }
  }

  private watchWork(contract: ContractState, resetNotification = true): void {
    this.stopWatchingWork();
    if (resetNotification) contract.workReadyNotified = false;
    this.workUnsubscribe = this.background().onJobsSettled(() => { void this.wakeIfReady(contract); });
  }

  private stopWatchingWork(): void {
    this.workUnsubscribe?.();
    this.workUnsubscribe = undefined;
  }

  private async wakeIfReady(contract: ContractState): Promise<void> {
    if (contract.ownerSessionId !== this.runtime.sessionId ||
        this.activeKey !== this.key(contract.jobId, contract.attemptId) || contract.state !== "active") return;
    if (contract.declaration || this.pendingWork(contract).length > 0 || contract.workReadyNotified) return;
    const summary = "No background or child jobs remain running for this attempt";
    const sequence = contract.workReadyPendingSequence ?? contract.workReadySequence;
    let ready: PersistedEvent;
    try {
      ready = this.persist(
        {
          kind: "work_ready",
          jobId: contract.jobId,
          attemptId: contract.attemptId,
          summary,
          workReadySequence: sequence,
          notified: false,
        },
        this.operationEventId("work_ready", contract, String(sequence)),
      );
    } catch {
      return;
    }
    contract.workReadySequence = Math.max(contract.workReadySequence, (ready.workReadySequence ?? sequence) + 1);
    if (ready.notified !== false) {
      contract.workReadyNotified = true;
      contract.workReadyPendingSequence = undefined;
      return;
    }
    contract.workReadyPendingSequence = ready.workReadySequence ?? sequence;
    const flight = this.beginNotification(
      contract,
      this.operationEventId("work_ready", contract, `${ready.workReadySequence ?? sequence}:attempted`),
    );
    if (!flight) return;
    try {
      try {
        const admissionGuard = () => {
          const current = this.currentNotificationContract(flight);
          return current?.state === "active" && !current.declaration && this.pendingWork(current).length === 0;
        };
        const result = this.runtime.sendUserMessage(`SYSTEM (task-outcomes): ${ready.summary ?? summary}.`, {
          deliverAs: "steer",
          admissionKey: flight.admissionKey,
          admissionGuard,
        });
        const accepted = result === undefined ? undefined : await Promise.resolve(result);
        if (!admissionAccepted(accepted)) throw admissionError(accepted);
      } catch {
        return;
      }
      const current = this.currentNotificationContract(flight);
      if (!current || current.state !== "active" || current.declaration || this.pendingWork(current).length > 0) return;
      try {
        this.persist(
          {
            kind: "work_ready",
            jobId: current.jobId,
            attemptId: current.attemptId,
            summary: ready.summary ?? summary,
            workReadySequence: ready.workReadySequence ?? sequence,
            notified: true,
          },
          this.operationEventId("work_ready", current, `${ready.workReadySequence ?? sequence}:attempted`),
        );
      } catch {
        // Invocation acceptance is retained in memory; a later replay may retry
        // because Pi exposes no durable reception acknowledgement.
      }
      current.workReadyNotified = true;
      current.workReadyPendingSequence = undefined;
    } finally {
      this.endNotification(flight);
    }
  }

  private beginNotification(contract: ContractState, eventId: string): NotificationFlight | undefined {
    if (contract.ownerSessionId !== this.runtime.sessionId) return undefined;
    const ownerSessionId = this.runtime.sessionId;
    const branchId = this.notificationBranchId;
    const contractKey = this.key(contract.jobId, contract.attemptId);
    const key = `${ownerSessionId}:${branchId}:${contractKey}:${eventId}`;
    if (this.notificationFlights.has(key)) return undefined;
    const flight = {
      key,
      admissionKey: `task-outcome:${ownerSessionId}:${branchId}:${contractKey}:${eventId}`,
      ownerSessionId,
      branchId,
      contractKey,
      leafId: this.runtime.leafId(),
    };
    this.notificationFlights.set(key, flight);
    return flight;
  }

  private currentNotificationContract(flight: NotificationFlight): ContractState | undefined {
    if (this.notificationFlights.get(flight.key) !== flight ||
        this.runtime.sessionId !== flight.ownerSessionId ||
        this.notificationBranchId !== flight.branchId ||
        this.runtime.leafId() !== flight.leafId) return undefined;
    const contract = this.contracts.get(flight.contractKey);
    return contract?.ownerSessionId === flight.ownerSessionId ? contract : undefined;
  }

  private endNotification(flight: NotificationFlight): void {
    if (this.notificationFlights.get(flight.key) === flight) this.notificationFlights.delete(flight.key);
  }

  private emitOutcome(input: {
    contract: ContractState;
    outcome: MonitorOutcome;
    source: OutcomeSource;
    summary: string;
    final: boolean;
    reportText?: string;
  }): void {
    this.runtime.emit(TASK_OUTCOME_EVENT, {
      sessionId: this.runtime.sessionId,
      sessionFile: this.runtime.sessionFile,
      jobId: input.contract.jobId,
      attemptId: input.contract.attemptId,
      mode: input.contract.mode,
      outcome: input.outcome,
      source: input.source,
      summary: input.summary,
      reportPath: input.contract.reportPath,
      ...(input.reportText !== undefined ? { reportText: input.reportText } : {}),
      final: input.final,
      ...(input.outcome === "context_paused" ? { pauseId: input.contract.contextPause?.id } : {}),
      ...(input.outcome === "maintenance_paused" || input.outcome === "maintenance_error"
        ? {
            maintenanceId: this.maintenanceState?.maintenanceId,
            ownerEpoch: this.maintenanceState?.ownerEpoch,
            phase: this.maintenanceState?.phase,
          }
        : {}),
    });
  }

  private markTransportLost(contract: ContractState, summary: string): void {
    if (contract.state === "final" || contract.state === "transport_lost") return;
    const durable = this.persist({
      kind: "transport_lost",
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: "transport_lost",
      source: "transport",
      summary,
    }, this.operationEventId("transport_lost", contract, "0"));
    if (!durable.summary) throw new Error("invalid durable transport-loss record");
    contract.state = "transport_lost";
    this.records.push({
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: "transport_lost",
      source: durable.source ?? "transport",
      summary: durable.summary,
      at: durable.at,
      final: false,
    });
    this.emitOutcome({
      contract,
      outcome: "transport_lost",
      source: durable.source ?? "transport",
      summary: durable.summary,
      final: false,
    });
  }

  private registerBatchMembers(batchId: string, memberIds: readonly string[]): void {
    this.background().registerOutcomes(batchId, memberIds);
  }

  private background(): BackgroundJobManager {
    return getBackgroundJobManager(
      { sendUserMessage: this.runtime.sendUserMessage } as Pick<ExtensionAPI, "sendUserMessage">,
      { sessionManager: this.runtime.sessionOwner } as any,
    );
  }

  private serializedContract(contract: ContractState): PersistedEvent["contract"] {
    return {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      mode: contract.mode,
      reportPath: contract.reportPath,
      reportIdentity: contract.reportIdentity,
      batchId: contract.batchId,
      parentJobId: contract.parentJobId,
      childJobIds: [...contract.childJobIds],
      ownerSessionId: contract.ownerSessionId,
      activatedAt: contract.activatedAt,
      childGeneration: contract.childGeneration,
    };
  }

  private key(jobId: string, attemptId: string): string {
    return `${jobId}@${attemptId}`;
  }

  private operationEventId(kind: PersistedEvent["kind"], contract: ContractState, discriminator: string): string {
    return `task-outcome:${kind}:${this.key(contract.jobId, contract.attemptId)}:${discriminator}`;
  }

  private activeBranchEntry(eventId: string): any | undefined {
    return this.runtime.branchEntries().find(item =>
      item?.type === "custom" && item.customType === TASK_OUTCOME_ENTRY && item.data?.eventId === eventId);
  }

  private assertEventPayload(existing: PersistedEvent, requested: object): void {
    if (eventPayload(existing) !== eventPayload(requested)) {
      throw new Error(`event ${existing.eventId} already exists with a different payload`);
    }
  }

  private sidecarEvent(eventId: string): PersistedEvent | undefined {
    const sidecar = this.runtime.sessionFile ? `${this.runtime.sessionFile}.task-outcomes.jsonl` : undefined;
    if (!sidecar || !pathEntryExists(sidecar)) return undefined;
    let found: PersistedEvent | undefined;
    for (const line of readFileSync(sidecar, "utf8").split("\n")) {
      let event: PersistedEvent;
      try { event = JSON.parse(line) as PersistedEvent; } catch { continue; }
      if (event?.version !== 1 || event.eventId !== eventId || event.branchId !== this.branchId) continue;
      if (found) this.assertEventPayload(found, event);
      found = event;
    }
    return found;
  }

  private sessionFileHasEvent(eventId: string, entryId?: string): boolean {
    const sessionFile = this.runtime.sessionFile;
    if (!sessionFile || !pathEntryExists(sessionFile)) return false;
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as { id?: string; type?: string; customType?: string; data?: PersistedEvent };
        if (entry.id === entryId && entry.type === "custom" && entry.customType === TASK_OUTCOME_ENTRY && entry.data?.eventId === eventId) return true;
      } catch {}
    }
    return false;
  }

  private durableActiveBranchEvent(eventId: string): PersistedEvent | undefined {
    const activeEntry = this.activeBranchEntry(eventId);
    if (!activeEntry) return undefined;
    const existing = activeEntry.data as PersistedEvent;
    const sessionFile = this.runtime.sessionFile;
    if (!sessionFile) return existing;
    if (!pathEntryExists(sessionFile) || this.sessionFileHasEvent(eventId, activeEntry.id)) return existing;
    if (!this.runtime.reloadSession) {
      throw new Error(`cannot verify durable session event ${eventId}; only an in-memory marker exists`);
    }
    const fallbackLeaf = activeEntry.parentId ?? this.runtime.leafId();
    this.runtime.reloadSession(fallbackLeaf, eventId);
    const refreshed = this.activeBranchEntry(eventId);
    if (refreshed && !this.sessionFileHasEvent(eventId, refreshed.id)) {
      throw new Error(`session event ${eventId} exists only in memory after reload`);
    }
    return refreshed?.data as PersistedEvent | undefined;
  }

  private persist(
    event: Omit<PersistedEvent, "version" | "eventId" | "at" | "branchId">,
    eventId = randomUUID(),
  ): PersistedEvent {
    // SessionManager updates its in-memory branch before its file flush. Only a
    // matching active-branch event that survives a disk read is a durable retry marker.
    const attempted = this.sidecarEvent(eventId);
    if (attempted) this.assertEventPayload(attempted, event);
    const existing = this.durableActiveBranchEvent(eventId);
    if (existing) {
      this.assertEventPayload(existing, event);
      return existing;
    }
    const data: PersistedEvent = {
      version: 1,
      eventId,
      branchId: this.branchId,
      at: new Date().toISOString(),
      ...event,
    };
    const sidecar = this.runtime.sessionFile ? `${this.runtime.sessionFile}.task-outcomes.jsonl` : undefined;
    if (sidecar && !attempted) {
      mkdirSync(dirname(sidecar), { recursive: true });
      appendFileSync(sidecar, `${JSON.stringify(data)}\n`, "utf8");
    }
    const priorLeafId = this.runtime.leafId();
    try {
      this.runtime.appendEntry(TASK_OUTCOME_ENTRY, data);
    } catch (error) {
      // SessionManager mutates its in-memory leaf before its file flush. Reload
      // through the supported API, selecting the exact appended event when it
      // reached disk or the exact prior leaf when it did not.
      try { this.runtime.reloadSession?.(priorLeafId, eventId); } catch {}
      this.observedLeafId = this.runtime.leafId();
      throw error;
    }
    this.observedLeafId = this.runtime.leafId();
    return data;
  }

  private replay(): void {
    const events: PersistedEvent[] = [];
    const branchEvents: PersistedEvent[] = [];
    const branchEventIds = new Set<string>();
    for (const entry of this.runtime.branchEntries()) {
      if (entry?.type !== "custom" || entry.customType !== TASK_OUTCOME_ENTRY) continue;
      const event = entry.data as PersistedEvent;
      if (event?.version !== 1 || !event.eventId) continue;
      branchEvents.push(event);
      branchEventIds.add(event.eventId);
      if (event.kind === "contract" && event.contract?.reportPath) this.usedReportPaths.add(resolve(event.contract.reportPath));
    }
    events.push(...branchEvents);

    const sidecar = this.runtime.sessionFile ? `${this.runtime.sessionFile}.task-outcomes.jsonl` : undefined;
    if (sidecar && existsSync(sidecar)) {
      for (const line of readFileSync(sidecar, "utf8").split("\n")) {
        try {
          const event = JSON.parse(line) as PersistedEvent;
          if (event?.version !== 1 || !event.eventId) continue;
          if (event.kind === "contract" && event.contract?.reportPath) {
            this.usedReportPaths.add(resolve(event.contract.reportPath));
          }
          // A sidecar record is usable only when the exact event was committed
          // to the active branch. A shared branch token is not an ownership proof.
          if (branchEventIds.has(event.eventId)) events.push(event);
        } catch {}
      }
    }
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      this.apply(event);
    }
  }

  private apply(event: PersistedEvent): void {
    if (event.kind === "contract" && event.contract) {
      const key = this.key(event.contract.jobId, event.contract.attemptId);
      const previous = this.contracts.get(key);
      const contract: ContractState = {
        ...event.contract,
        childJobIds: [...event.contract.childJobIds],
        activatedAt: Number.isFinite(event.contract.activatedAt)
          ? event.contract.activatedAt
          : previous?.activatedAt ?? Date.parse(event.at),
        childGeneration: event.contract.childGeneration ?? previous?.childGeneration ?? 0,
        state: previous?.state ?? "active",
        contextPause: previous?.contextPause,
        declaration: previous?.declaration,
        declarationSequence: previous?.declarationSequence ?? 0,
        workReadySequence: previous?.workReadySequence ?? 0,
        workReadyNotified: previous?.workReadyNotified ?? false,
        workReadyPendingSequence: undefined,
        childOutcomes: previous?.childOutcomes ?? new Map(),
        questionNotified: previous?.questionNotified ?? false,
        maintenanceState: previous?.maintenanceState,
        cancellation: previous?.cancellation,
      };
      this.contracts.set(key, contract);
      return;
    }
    if (event.kind === "maintenance_begin" && event.maintenance) {
      this.maintenanceState = {
        ...event.maintenance,
        previousState: event.maintenance.previousState ?? "active",
        pausedNotified: false,
      };
      const contract = event.jobId && event.attemptId
        ? this.contracts.get(this.key(event.jobId, event.attemptId))
        : undefined;
      if (contract) {
        contract.maintenanceState = this.maintenanceState;
        contract.state = "maintenance_pending";
        this.activeKey = this.key(contract.jobId, contract.attemptId);
      }
      return;
    }
    if (event.kind === "maintenance_paused" && event.maintenance) {
      if (this.maintenanceState?.maintenanceId === event.maintenance.maintenanceId) {
        this.maintenanceState.pausedNotified = true;
      }
      return;
    }
    if (event.kind === "maintenance_error" && event.maintenance) {
      this.maintenanceState = {
        ...event.maintenance,
        phase: "error",
        previousState: this.maintenanceState?.previousState ?? event.maintenance.previousState ?? "active",
        pausedNotified: true,
        error: event.maintenance.error ?? event.summary,
      };
      const contract = event.jobId && event.attemptId
        ? this.contracts.get(this.key(event.jobId, event.attemptId))
        : undefined;
      if (contract) {
        contract.maintenanceState = this.maintenanceState;
        contract.state = "maintenance_pending";
        this.activeKey = this.key(contract.jobId, contract.attemptId);
      }
      return;
    }
    if (event.kind === "maintenance_resume" && event.maintenance) {
      if (this.maintenanceState?.maintenanceId === event.maintenance.maintenanceId) {
        const contract = event.jobId && event.attemptId
          ? this.contracts.get(this.key(event.jobId, event.attemptId))
          : this.activeContract();
        if (contract) {
          contract.state = this.maintenanceState.previousState;
          contract.maintenanceState = undefined;
        }
        this.maintenanceState = undefined;
      }
      return;
    }
    if (event.kind === "cancellation_requested" && event.cancellation) {
      this.cancellation = { ...event.cancellation, eventId: event.eventId };
      if (event.jobId && event.attemptId) {
        const contract = this.contracts.get(this.key(event.jobId, event.attemptId));
        if (contract) contract.cancellation = this.cancellation;
      }
      return;
    }
    if (!event.jobId || !event.attemptId) return;
    const contract = this.contracts.get(this.key(event.jobId, event.attemptId));
    if (!contract) return;
    if (event.kind === "context_pause" && event.contextPause) {
      contract.state = "context_paused";
      contract.contextPause = event.contextPause;
    } else if (event.kind === "context_resume") {
      contract.state = "active";
      contract.contextPause = undefined;
      contract.declaration = undefined;
    } else if (event.kind === "declaration") {
      if (isOutcome(event.outcome) && event.summary) {
        const sequence = event.declarationSequence ?? contract.declarationSequence;
        contract.declaration = {
          outcome: event.outcome,
          summary: event.summary,
          sequence,
          run: 0,
          turn: -1,
          workGeneration: event.declarationWorkGeneration ?? 0,
          childGeneration: event.declarationChildGeneration ?? contract.childGeneration,
        };
        contract.declarationSequence = Math.max(contract.declarationSequence, sequence + 1);
      }
    } else if (event.kind === "declaration_invalidated") {
      contract.declaration = undefined;
    } else if (event.kind === "child_outcome" && event.childJobId && isStatus(event.outcome) && event.summary) {
      const outcomeKey = event.childAttemptId ? `${event.childJobId}@${event.childAttemptId}` : event.childJobId;
      contract.childOutcomes.set(outcomeKey, {
        outcome: event.outcome,
        summary: event.summary,
        source: isSource(event.source) ? event.source : "model",
        attemptId: event.childAttemptId,
      });
    } else if (event.kind === "work_ready") {
      const sequence = event.workReadySequence ?? 0;
      if (sequence + 1 >= contract.workReadySequence) {
        contract.workReadySequence = sequence + 1;
        contract.workReadyNotified = event.notified !== false;
        contract.workReadyPendingSequence = event.notified === false ? sequence : undefined;
      }
    } else if (event.kind === "outcome" || event.kind === "transport_lost") {
      if (!event.outcome || !event.source || !event.summary) return;
      if (contract.state === "final") return;
      if (event.kind === "outcome" && event.outcome === "needs_input" &&
          event.notified === true && event.eventId.endsWith(":needs_input:attempted")) {
        contract.state = "awaiting_input";
        contract.questionNotified = true;
        return;
      }
      const final = event.kind === "outcome" && event.outcome !== "needs_input";
      this.records.push({
        jobId: event.jobId,
        attemptId: event.attemptId,
        outcome: event.outcome,
        source: event.source,
        summary: event.summary,
        reportPath: event.reportPath,
        at: event.at,
        final,
      });
      if (event.outcome === "needs_input") {
        contract.state = "awaiting_input";
        contract.questionNotified = event.notified === true;
      } else if (event.outcome === "transport_lost") {
        contract.state = "transport_lost";
      } else {
        contract.state = "final";
      }
    }
  }
}

const assistantText = (message: any): string | undefined => {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const blocks = message.content.filter((block: any) => block?.type === "text");
  if (blocks.some((block: any) => typeof block.text !== "string")) return undefined;
  return blocks.map((block: any) => block.text).join("");
};

const dialogueSummary = (text: string): string => {
  if (text.trim().length === 0) return "dialogue_settled";
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) : text;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

type SessionOwnerContext = Pick<ExtensionContext, "sessionManager" | "isIdle">;
type TaskOutcomeAPI = Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "events">;
const registryKey = Symbol.for("pi.task-outcomes.manager-registry");
const handoffKey = Symbol.for("pi.task-outcomes.maintenance-handoffs");
const state = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, TaskOutcomeManager>;
  [handoffKey]?: Map<string, { manager: TaskOutcomeManager; lease: MaintenanceHandoff }>;
};
const managers = state[registryKey] ??= new WeakMap();
const handoffs = state[handoffKey] ??= new Map();

const runtimeFor = (pi: TaskOutcomeAPI, ctx: SessionOwnerContext): Runtime => {
  const owner = ctx.sessionManager as object;
  return {
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    sendUserMessage: pi.sendUserMessage,
    emit: (channel, data) => pi.events.emit(channel, data),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionOwner: owner,
    isIdle: ctx.isIdle,
    branchEntries: () => ctx.sessionManager.getBranch(),
    leafId: () => ctx.sessionManager.getLeafId(),
    reloadSession: (fallbackLeafId, eventId) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !pathEntryExists(sessionFile)) return;
      ctx.sessionManager.setSessionFile(sessionFile);
      const candidates = fallbackLeafId === null
        ? ctx.sessionManager.getTree().map(node => node.entry)
        : fallbackLeafId
          ? ctx.sessionManager.getChildren(fallbackLeafId)
          : ctx.sessionManager.getEntries();
      const eventEntry = eventId && candidates.find(entry =>
        entry.type === "custom" && entry.customType === TASK_OUTCOME_ENTRY && (entry.data as any)?.eventId === eventId);
      if (eventEntry) {
        ctx.sessionManager.branch(eventEntry.id);
      } else if (fallbackLeafId === null) {
        ctx.sessionManager.resetLeaf();
      } else if (fallbackLeafId && ctx.sessionManager.getEntry(fallbackLeafId)) {
        ctx.sessionManager.branch(fallbackLeafId);
      }
    },
  };
};

export function getTaskOutcomeManager(pi: TaskOutcomeAPI, ctx: SessionOwnerContext): TaskOutcomeManager {
  const owner = ctx.sessionManager as object;
  const runtime = runtimeFor(pi, ctx);
  let manager = managers.get(owner);
  if (!manager) {
    manager = new TaskOutcomeManager(runtime);
    managers.set(owner, manager);
  } else {
    manager.attach(runtime);
  }
  return manager;
}

export function parkTaskOutcomeManager(ctx: SessionOwnerContext, lease: MaintenanceHandoff): void {
  const owner = ctx.sessionManager as object;
  const manager = managers.get(owner);
  if (!manager) throw new Error("task outcome manager is unavailable for maintenance");
  manager.parkMaintenance(lease);
  handoffs.set(lease.maintenanceId, { manager, lease: { ...lease } });
}

export function adoptTaskOutcomeManager(
  pi: TaskOutcomeAPI,
  ctx: SessionOwnerContext,
  lease: MaintenanceHandoff,
): TaskOutcomeManager | undefined {
  const handoff = handoffs.get(lease.maintenanceId);
  if (!handoff) return undefined;
  if (handoff.lease.sessionId !== lease.sessionId || handoff.lease.ownerEpoch !== lease.ownerEpoch) {
    throw new Error("task outcome maintenance handoff token conflicts with its owner");
  }
  adoptBackgroundJobManager({ sendUserMessage: pi.sendUserMessage }, ctx, lease);
  const manager = handoff.manager;
  manager.adopt(runtimeFor(pi, ctx), lease);
  manager.claimMaintenance(lease);
  managers.set(ctx.sessionManager as object, manager);
  handoffs.delete(lease.maintenanceId);
  return manager;
}

// Session replacement callbacks must use the replacement owner's manager, never captured old pi/ctx.
export function existingTaskOutcomeManager(ctx: SessionOwnerContext): TaskOutcomeManager | undefined {
  return managers.get(ctx.sessionManager as object);
}

export function releaseTaskOutcomeManager(ctx: SessionOwnerContext): void {
  managers.delete(ctx.sessionManager as object);
}
