import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  getBackgroundJobManager,
  type BackgroundJobManager,
  type BackgroundJobOutcomeStatus,
} from "../background-jobs/manager.ts";

export const TASK_OUTCOME_ENTRY = "task-outcome/v1";
export const TASK_OUTCOME_EVENT = "task-outcome";

export type TaskMode = "task" | "dialogue";
export type DeclaredOutcome = "completed" | "blocked" | "needs_input" | "failed";
export type MonitorOutcome = DeclaredOutcome | "protocol_incomplete" | "dialogue_settled" | "transport_lost";
export type OutcomeSource = "model" | "technical" | "protocol" | "transport";

export interface TaskLaunchContract {
  jobId: string;
  attemptId: string;
  mode: TaskMode;
  reportPath?: string;
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
  state: "active" | "awaiting_input" | "transport_lost" | "final";
  declaration?: { outcome: DeclaredOutcome; summary: string };
  pendingWork: readonly string[];
}

export interface TaskOutcomeSnapshot {
  active?: TaskContractSnapshot;
  contracts: readonly TaskContractSnapshot[];
  outcomes: readonly TaskOutcomeRecord[];
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
  workReadySending: boolean;
  workReadyPendingSequence: number | undefined;
  childOutcomes: Map<string, { outcome: BackgroundJobOutcomeStatus; summary: string }>;
  questionNotified: boolean;
}

interface PersistedEvent {
  version: 1;
  eventId: string;
  branchId?: string;
  kind: "contract" | "declaration" | "declaration_invalidated" | "child_outcome" | "work_ready" | "outcome" | "transport_lost";
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

export class TaskOutcomeManager {
  private readonly contracts = new Map<string, ContractState>();
  private readonly records: TaskOutcomeRecord[] = [];
  private readonly usedReportPaths = new Set<string>();
  private activeKey: string | undefined;
  private branchId = randomUUID();
  private restored = false;
  private run = 0;
  private turn = -1;
  private lastAssistant: any;
  private lastRunFailure: string | undefined;
  private workUnsubscribe: (() => void) | undefined;
  private runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.replay();
  }

  attach(runtime: Runtime): void {
    this.runtime = runtime;
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    for (const contract of this.contracts.values()) {
      if (contract.ownerSessionId !== this.runtime.sessionId) continue;
      if (contract.state === "active" && contract.ownerSessionId === this.runtime.sessionId) {
        this.markTransportLost(contract, "monitor restarted before a final outcome");
      }
    }
    this.activeKey = undefined;
    this.retryPendingNotifications();
  }

  onSessionTree(): void {
    this.stopWatchingWork();
    this.contracts.clear();
    this.records.length = 0;
    this.usedReportPaths.clear();
    this.activeKey = undefined;
    this.branchId = randomUUID();
    this.replay();
    for (const contract of this.contracts.values()) {
      if (contract.state === "active" && contract.ownerSessionId === this.runtime.sessionId) {
        this.activeKey = this.key(contract.jobId, contract.attemptId);
        this.watchWork(contract, false);
        if (contract.workReadyPendingSequence !== undefined && !contract.workReadyNotified) {
          void this.wakeIfReady(contract);
        }
      }
    }
    this.retryPendingNotifications();
  }

  activateContract(input: TaskLaunchContract): TaskContractSnapshot {
    assertId("jobId", input.jobId);
    assertId("attemptId", input.attemptId);
    if (input.mode !== "task" && input.mode !== "dialogue") throw new Error("mode must be task or dialogue");
    if (input.parentJobId !== undefined) assertId("parentJobId", input.parentJobId);
    const childJobIds = [...new Set(input.childJobIds ?? [])];
    for (const childJobId of childJobIds) assertId("childJobId", childJobId);
    if (childJobIds.includes(input.jobId)) throw new Error("a task cannot be its own child");
    const key = this.key(input.jobId, input.attemptId);
    const contractEventId = `task-outcome:contract:${key}:0`;
    const reservation = this.sidecarEvent(contractEventId) ??
      (this.activeBranchEntry(contractEventId)?.data as PersistedEvent | undefined);
    const reservedContract = reservation?.kind === "contract" ? reservation.contract : undefined;
    let reportPath = input.reportPath;
    if (input.mode === "task") {
      if (!reportPath || !isAbsolute(reportPath) || reportPath.includes("\0")) {
        throw new Error("task mode requires an absolute reportPath");
      }
      reportPath = resolve(reportPath);
      const reservedReportPath = reservedContract?.reportPath
        ? resolve(reservedContract.reportPath)
        : undefined;
      if ((this.usedReportPaths.has(reportPath) || pathEntryExists(reportPath)) && reservedReportPath !== reportPath) {
        throw new Error("task reportPath must be a fresh, unused path for this attempt");
      }
    }
    if (input.ownerSessionId && input.ownerSessionId !== this.runtime.sessionId) {
      throw new Error("launch contract belongs to another session");
    }

    if (this.contracts.has(key)) throw new Error(`attempt ${key} is already registered`);
    const previous = [...this.contracts.values()]
      .filter(contract => contract.jobId === input.jobId && contract.ownerSessionId === this.runtime.sessionId)
      .at(-1);
    if (previous && previous.state !== "awaiting_input" && previous.state !== "transport_lost") {
      throw new Error(`job ${input.jobId} already has an active or final attempt`);
    }

    const contract: ContractState = {
      ...input,
      reportPath,
      ownerSessionId: this.runtime.sessionId,
      childJobIds,
      activatedAt: Number.isFinite(reservedContract?.activatedAt)
        ? reservedContract!.activatedAt
        : Date.now(),
      childGeneration: reservedContract?.childGeneration ?? 0,
      state: "active",
      declarationSequence: 0,
      workReadySequence: 0,
      workReadyNotified: false,
      workReadySending: false,
      workReadyPendingSequence: undefined,
      childOutcomes: new Map(),
      questionNotified: false,
    };
    const members = contract.batchId ? [contract.jobId, ...childJobIds] : [];
    if (contract.batchId) this.background().assertCanRegisterOutcomes(contract.batchId, members);
    const contractEvent = { kind: "contract" as const, contract: this.serializedContract(contract) };
    try {
      this.persist(contractEvent, contractEventId);
    } catch (error) {
      const existing = this.durableActiveBranchEvent(contractEventId);
      if (!existing) throw error;
      this.assertEventPayload(existing, contractEvent);
    }
    if (contract.batchId) this.registerBatchMembers(contract.batchId, members);
    if (reportPath) this.usedReportPaths.add(reportPath);
    this.contracts.set(key, contract);
    this.activeKey = key;
    this.watchWork(contract);
    return this.contractSnapshot(contract);
  }

  registerChild(parentJobId: string, childJobId: string): void {
    assertId("parentJobId", parentJobId);
    assertId("childJobId", childJobId);
    const parent = this.requireActive(parentJobId);
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

  recordChildOutcome(parentJobId: string, childJobId: string, outcome: BackgroundJobOutcomeStatus, summary: string): void {
    assertId("parentJobId", parentJobId);
    assertId("childJobId", childJobId);
    if (!isStatus(outcome)) throw new Error("child outcome must be completed, failed, or blocked");
    const parent = this.requireActive(parentJobId);
    if (!parent.childJobIds.includes(childJobId)) throw new Error(`child ${childJobId} is not registered`);
    const text = assertSummary(summary);
    const wasRecorded = parent.childOutcomes.has(childJobId);
    const durable = this.persist(
      { kind: "child_outcome", jobId: parent.jobId, attemptId: parent.attemptId, childJobId, outcome, summary: text },
      this.operationEventId("child_outcome", parent, childJobId),
    );
    if (!durable.childJobId || !isStatus(durable.outcome) || !durable.summary) {
      throw new Error("invalid durable child outcome");
    }
    parent.childOutcomes.set(durable.childJobId, { outcome: durable.outcome, summary: durable.summary });
    if (parent.batchId) {
      try {
        this.background().recordOutcome(parent.batchId, {
          id: durable.childJobId,
          status: durable.outcome,
          summary: durable.summary,
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
    if (contract.state !== "active") throw new Error(`attempt ${contract.attemptId} is not active`);
    if (contract.declaration) throw new Error(`attempt ${contract.attemptId} already declared an outcome`);
    const declarationWorkGeneration = this.background().workGeneration();
    const declarationChildGeneration = contract.childGeneration;

    if (outcome === "completed") {
      await this.verifyReport(contract);
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

  onAgentStart(): void {
    this.run += 1;
    this.turn = -1;
    this.lastAssistant = undefined;
    this.lastRunFailure = undefined;
    const contract = this.activeContract();
    if (contract) contract.workReadyNotified = false;
  }

  onTurnStart(turnIndex: number): void {
    this.turn = turnIndex;
  }

  onTurnEnd(message: any): void {
    if (message?.role === "assistant") this.lastAssistant = message;
  }

  onAgentEnd(messages: readonly any[]): void {
    const assistant = [...messages].reverse().find(message => message?.role === "assistant");
    if (!assistant) return;
    this.lastAssistant = assistant;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      this.lastRunFailure = assistant.errorMessage || `assistant ${assistant.stopReason}`;
    } else {
      this.lastRunFailure = undefined;
    }
  }

  async onAgentSettled(hasPendingMessages: boolean): Promise<void> {
    const contract = this.activeContract();
    if (!contract || contract.state !== "active") return;
    if (hasPendingMessages || contract.state === "awaiting_input") return;
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
          this.finalize(contract, "failed", "technical", `report invalid at settlement: ${errorMessage(error)}`);
          return;
        }
      }
      this.finalize(contract, declaration.outcome, "model", declaration.summary);
      return;
    }

    const pending = this.pendingWork(contract);
    if (pending.length > 0) return;
    if (contract.mode === "dialogue") {
      const response = assistantText(this.lastAssistant);
      this.finalize(contract, "dialogue_settled", "model", response || "Assistant settled; read the saved session response.");
      return;
    }
    this.finalize(contract, "failed", "protocol", "protocol-incomplete: task settled without a structured outcome declaration");
  }

  shutdown(reason: string): void {
    const contract = this.activeContract();
    if (contract && contract.state === "active") this.markTransportLost(contract, reason);
    this.stopWatchingWork();
    this.activeKey = undefined;
  }

  snapshot(): TaskOutcomeSnapshot {
    return {
      active: this.activeContract() ? this.contractSnapshot(this.activeContract()!) : undefined,
      contracts: [...this.contracts.values()].map(contract => this.contractSnapshot(contract)),
      outcomes: this.records.map(cloneRecord),
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
      .filter(childJobId => !contract.childOutcomes.has(childJobId))
      .map(childJobId => `child:${childJobId}`);
    const running = this.background().stats().running;
    if (running > 0) pending.push(`background:${running} running job(s)`);
    return pending;
  }

  private async verifyReport(contract: ContractState): Promise<void> {
    if (!contract.reportPath) throw new Error("task has no expected report path");
    const { open } = await import("node:fs/promises");
    const file = await open(contract.reportPath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1) throw new Error("report must be a readable nonempty file");
      if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs + 1 < contract.activatedAt) {
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
  ): void {
    if (contract.state === "final") return;
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
        });
      } catch {
        // The durable record and monitor event remain authoritative if a manager was replaced.
      }
    }
    if (emit) this.emitOutcome({ contract, outcome: record.outcome, source: record.source, summary: record.summary, final: true });
  }

  private async notifyQuestion(contract: ContractState, question: string): Promise<void> {
    try {
      const result = contract.batchId && this.background().getBatchStatus(contract.batchId)
        ? this.background().notifyNeedsInput(contract.batchId, question)
        : this.runtime.sendUserMessage(question, { deliverAs: "steer" });
      if (result !== undefined) await Promise.resolve(result);
    } catch {
      // A rejected invocation remains unaccepted and is retried by a later monitor.
      return;
    }
    contract.questionNotified = true;
    try {
      this.persist({
        kind: "outcome",
        jobId: contract.jobId,
        attemptId: contract.attemptId,
        outcome: "needs_input",
        source: "model",
        summary: contract.declaration?.summary ?? question,
        reportPath: contract.reportPath,
        notified: true,
      }, this.operationEventId("outcome", contract, "needs_input:attempted"));
    } catch {
      // The invocation was accepted, but the durable attempted marker remains retryable.
    }
  }

  private retryPendingNotifications(): void {
    for (const contract of this.contracts.values()) {
      if (contract.state !== "awaiting_input" || contract.questionNotified) continue;
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
    if (this.activeKey !== this.key(contract.jobId, contract.attemptId) || contract.state !== "active") return;
    if (contract.declaration || this.pendingWork(contract).length > 0 || contract.workReadyNotified || contract.workReadySending) return;
    const summary = `background/child work finished for ${contract.jobId}; inspect the retained evidence, synthesize the report, then declare an outcome`;
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
    contract.workReadySending = true;
    try {
      const result = this.runtime.sendUserMessage(`SYSTEM (task-outcomes): ${ready.summary ?? summary}.`, { deliverAs: "steer" });
      if (result !== undefined) await Promise.resolve(result);
    } catch {
      contract.workReadySending = false;
      return;
    }
    contract.workReadySending = false;
    try {
      this.persist(
        {
          kind: "work_ready",
          jobId: contract.jobId,
          attemptId: contract.attemptId,
          summary: ready.summary ?? summary,
          workReadySequence: ready.workReadySequence ?? sequence,
          notified: true,
        },
        this.operationEventId("work_ready", contract, `${ready.workReadySequence ?? sequence}:attempted`),
      );
      contract.workReadyNotified = true;
      contract.workReadyPendingSequence = undefined;
    } catch {
      // Invocation acceptance is retained in memory; a later replay may retry
      // because Pi exposes no durable reception acknowledgement.
      contract.workReadyNotified = true;
      contract.workReadyPendingSequence = undefined;
    }
  }

  private emitOutcome(input: { contract: ContractState; outcome: MonitorOutcome; source: OutcomeSource; summary: string; final: boolean }): void {
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
      final: input.final,
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
      throw error;
    }
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
        declaration: previous?.declaration,
        declarationSequence: previous?.declarationSequence ?? 0,
        workReadySequence: previous?.workReadySequence ?? 0,
        workReadyNotified: previous?.workReadyNotified ?? false,
        workReadySending: false,
        workReadyPendingSequence: undefined,
        childOutcomes: previous?.childOutcomes ?? new Map(),
        questionNotified: previous?.questionNotified ?? false,
      };
      this.contracts.set(key, contract);
      return;
    }
    if (!event.jobId || !event.attemptId) return;
    const contract = this.contracts.get(this.key(event.jobId, event.attemptId));
    if (!contract) return;
    if (event.kind === "declaration") {
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
      contract.childOutcomes.set(event.childJobId, { outcome: event.outcome, summary: event.summary });
    } else if (event.kind === "work_ready") {
      const sequence = event.workReadySequence ?? 0;
      if (sequence + 1 >= contract.workReadySequence) {
        contract.workReadySequence = sequence + 1;
        contract.workReadyNotified = event.notified !== false;
        contract.workReadyPendingSequence = event.notified === false ? sequence : undefined;
      }
    } else if (event.kind === "outcome" || event.kind === "transport_lost") {
      if (!event.outcome || !event.source || !event.summary) return;
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

const assistantText = (message: any): string => {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("").trim();
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

type SessionOwnerContext = Pick<ExtensionContext, "sessionManager">;
const registryKey = Symbol.for("pi.task-outcomes.manager-registry");
const state = globalThis as typeof globalThis & { [registryKey]?: WeakMap<object, TaskOutcomeManager> };
const managers = state[registryKey] ??= new WeakMap();

export function getTaskOutcomeManager(pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "events">, ctx: SessionOwnerContext): TaskOutcomeManager {
  const owner = ctx.sessionManager as object;
  const runtime: Runtime = {
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    sendUserMessage: pi.sendUserMessage,
    emit: (channel, data) => pi.events.emit(channel, data),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionOwner: owner,
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
  let manager = managers.get(owner);
  if (!manager) {
    manager = new TaskOutcomeManager(runtime);
    managers.set(owner, manager);
  } else {
    manager.attach(runtime);
  }
  return manager;
}

export function releaseTaskOutcomeManager(ctx: SessionOwnerContext): void {
  const owner = ctx.sessionManager as object;
  managers.delete(owner);
}
