import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
    run: number;
    turn: number;
    workGeneration: number;
    childGeneration: number;
  };
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
  private workReadyNotified = false;
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
        this.watchWork(contract);
      }
    }
  }

  activateContract(input: TaskLaunchContract): TaskContractSnapshot {
    assertId("jobId", input.jobId);
    assertId("attemptId", input.attemptId);
    if (input.mode !== "task" && input.mode !== "dialogue") throw new Error("mode must be task or dialogue");
    if (input.parentJobId !== undefined) assertId("parentJobId", input.parentJobId);
    const childJobIds = [...new Set(input.childJobIds ?? [])];
    for (const childJobId of childJobIds) assertId("childJobId", childJobId);
    if (childJobIds.includes(input.jobId)) throw new Error("a task cannot be its own child");
    let reportPath = input.reportPath;
    if (input.mode === "task") {
      if (!reportPath || !isAbsolute(reportPath) || reportPath.includes("\0")) {
        throw new Error("task mode requires an absolute reportPath");
      }
      reportPath = resolve(reportPath);
      if (this.usedReportPaths.has(reportPath) || existsSync(reportPath)) {
        throw new Error("task reportPath must be a fresh, unused path for this attempt");
      }
    }
    if (input.ownerSessionId && input.ownerSessionId !== this.runtime.sessionId) {
      throw new Error("launch contract belongs to another session");
    }

    const key = this.key(input.jobId, input.attemptId);
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
      activatedAt: Date.now(),
      childGeneration: 0,
      state: "active",
      childOutcomes: new Map(),
      questionNotified: false,
    };
    this.persist({ kind: "contract", contract: this.serializedContract(contract) });
    if (contract.batchId) {
      this.registerBatchMember(contract.batchId, contract.jobId);
      for (const childJobId of childJobIds) this.registerBatchMember(contract.batchId, childJobId);
    }
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
    const next = { ...parent, childJobIds: [...parent.childJobIds, childJobId] };
    this.persist({ kind: "contract", contract: this.serializedContract(next) });
    if (parent.batchId) this.registerBatchMember(parent.batchId, childJobId);
    parent.childJobIds.push(childJobId);
    parent.childGeneration += 1;
  }

  recordChildOutcome(parentJobId: string, childJobId: string, outcome: BackgroundJobOutcomeStatus, summary: string): void {
    assertId("parentJobId", parentJobId);
    assertId("childJobId", childJobId);
    if (!isStatus(outcome)) throw new Error("child outcome must be completed, failed, or blocked");
    const parent = this.requireActive(parentJobId);
    if (!parent.childJobIds.includes(childJobId)) throw new Error(`child ${childJobId} is not registered`);
    const text = assertSummary(summary);
    if (parent.childOutcomes.has(childJobId)) return;
    this.persist({ kind: "child_outcome", jobId: parent.jobId, attemptId: parent.attemptId, childJobId, outcome, summary: text });
    parent.childOutcomes.set(childJobId, { outcome, summary: text });
    if (parent.batchId) {
      try { this.background().recordOutcome(parent.batchId, { id: childJobId, status: outcome, summary: text }); } catch {}
    }
    this.wakeIfReady(parent);
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

    const declaration = {
      outcome,
      summary: text,
      run: this.run,
      turn: this.turn,
      workGeneration: declarationWorkGeneration,
      childGeneration: declarationChildGeneration,
    };
    this.persist({
      kind: "declaration",
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome,
      summary: text,
      reportPath: contract.reportPath,
    });

    if (outcome === "needs_input") {
      const question = `Task ${contract.jobId} (attempt ${contract.attemptId}) needs human input:\n${text}`;
      this.persist({
        kind: "outcome",
        jobId: contract.jobId,
        attemptId: contract.attemptId,
        outcome,
        source: "model",
        summary: text,
        reportPath: contract.reportPath,
        notified: true,
      });
      contract.declaration = declaration;
      contract.state = "awaiting_input";
      contract.questionNotified = true;
      this.records.push({
        jobId: contract.jobId,
        attemptId: contract.attemptId,
        outcome,
        source: "model",
        summary: text,
        reportPath: contract.reportPath,
        at: new Date().toISOString(),
        final: false,
      });
      this.notifyQuestion(contract, question);
      this.emitOutcome({ contract, outcome, source: "model", summary: text, final: false });
    } else {
      contract.declaration = declaration;
    }

    return {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome,
      provisional: outcome !== "needs_input",
      reportPath: contract.reportPath,
      terminate: true,
    };
  }

  onAgentStart(): void {
    this.run += 1;
    this.turn = -1;
    this.lastAssistant = undefined;
    this.lastRunFailure = undefined;
    this.workReadyNotified = false;
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
          summary: pending.length > 0
            ? `work remained at settlement: ${pending.join(", ")}`
            : "work started after the completed declaration",
        });
        contract.declaration = undefined;
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
    const record: TaskOutcomeRecord = {
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome,
      source,
      summary,
      reportPath: contract.reportPath,
      at: new Date().toISOString(),
      final: true,
    };
    this.persist({
      kind: "outcome",
      jobId: record.jobId,
      attemptId: record.attemptId,
      outcome: record.outcome,
      source: record.source,
      summary: record.summary,
      reportPath: record.reportPath,
    });
    this.records.push(record);
    contract.state = "final";
    if (this.activeKey === this.key(contract.jobId, contract.attemptId)) this.activeKey = undefined;
    this.stopWatchingWork();

    if (contract.batchId && isStatus(outcome)) {
      try {
        this.background().recordOutcome(contract.batchId, {
          id: contract.jobId,
          status: outcome,
          summary: `${summary} (attempt ${contract.attemptId})`,
        });
      } catch {
        // The durable record and monitor event remain authoritative if a manager was replaced.
      }
    }
    if (emit) this.emitOutcome({ contract, outcome, source, summary, final: true });
  }

  private notifyQuestion(contract: ContractState, question: string): void {
    try {
      if (contract.batchId && this.background().getBatchStatus(contract.batchId)) {
        this.background().notifyNeedsInput(contract.batchId, question);
      } else {
        this.runtime.sendUserMessage(question, { deliverAs: "steer" });
      }
    } catch {
      // The question is durable; a later monitor can inspect it without claiming delivery.
    }
  }

  private watchWork(contract: ContractState): void {
    this.stopWatchingWork();
    this.workReadyNotified = false;
    this.workUnsubscribe = this.background().onJobsSettled(() => this.wakeIfReady(contract));
  }

  private stopWatchingWork(): void {
    this.workUnsubscribe?.();
    this.workUnsubscribe = undefined;
  }

  private wakeIfReady(contract: ContractState): void {
    if (this.activeKey !== this.key(contract.jobId, contract.attemptId) || contract.state !== "active") return;
    if (contract.declaration || this.pendingWork(contract).length > 0 || this.workReadyNotified) return;
    const summary = `background/child work finished for ${contract.jobId}; inspect the retained evidence, synthesize the report, then declare an outcome`;
    try {
      this.persist({ kind: "work_ready", jobId: contract.jobId, attemptId: contract.attemptId, summary });
    } catch {
      return;
    }
    this.workReadyNotified = true;
    try {
      const result = this.runtime.sendUserMessage(`SYSTEM (task-outcomes): ${summary}.`, { deliverAs: "steer" });
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {}
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
    this.persist({
      kind: "transport_lost",
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: "transport_lost",
      source: "transport",
      summary,
    });
    contract.state = "transport_lost";
    this.records.push({
      jobId: contract.jobId,
      attemptId: contract.attemptId,
      outcome: "transport_lost",
      source: "transport",
      summary,
      at: new Date().toISOString(),
      final: false,
    });
    this.emitOutcome({ contract, outcome: "transport_lost", source: "transport", summary, final: false });
  }

  private registerBatchMember(batchId: string, memberId: string): void {
    const background = this.background();
    if (background.getBatchStatus(batchId)) {
      background.registerOutcome(batchId, memberId);
    } else {
      background.openBatch(batchId).registerOutcome(memberId);
    }
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

  private persist(event: Omit<PersistedEvent, "version" | "eventId" | "at" | "branchId">): void {
    const data: PersistedEvent = {
      version: 1,
      eventId: randomUUID(),
      branchId: this.branchId,
      at: new Date().toISOString(),
      ...event,
    };
    const sidecar = this.runtime.sessionFile ? `${this.runtime.sessionFile}.task-outcomes.jsonl` : undefined;
    if (sidecar) {
      mkdirSync(dirname(sidecar), { recursive: true });
      appendFileSync(sidecar, `${JSON.stringify(data)}\n`, "utf8");
    }
    this.runtime.appendEntry(TASK_OUTCOME_ENTRY, data);
  }

  private replay(): void {
    const events: PersistedEvent[] = [];
    const branchEvents: PersistedEvent[] = [];
    const branchIds = new Set<string>();
    for (const entry of this.runtime.branchEntries()) {
      if (entry?.type !== "custom" || entry.customType !== TASK_OUTCOME_ENTRY) continue;
      const event = entry.data as PersistedEvent;
      if (event?.version !== 1 || !event.eventId) continue;
      branchEvents.push(event);
      if (event.branchId) branchIds.add(event.branchId);
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
          // Sidecar records are only usable when their branch token is also
          // represented by a custom entry on the active branch. Legacy records
          // without a token cannot establish branch ownership safely.
          if (event.branchId && branchIds.has(event.branchId)) events.push(event);
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
      const contract: ContractState = {
        ...event.contract,
        childJobIds: [...event.contract.childJobIds],
        activatedAt: Number.isFinite(event.contract.activatedAt) ? event.contract.activatedAt : Date.parse(event.at),
        childGeneration: event.contract.childGeneration ?? 0,
        state: "active",
        childOutcomes: new Map(),
        questionNotified: false,
      };
      this.contracts.set(this.key(contract.jobId, contract.attemptId), contract);
      return;
    }
    if (!event.jobId || !event.attemptId) return;
    const contract = this.contracts.get(this.key(event.jobId, event.attemptId));
    if (!contract) return;
    if (event.kind === "declaration") {
      if (isOutcome(event.outcome) && event.summary) {
        contract.declaration = {
          outcome: event.outcome,
          summary: event.summary,
          run: 0,
          turn: -1,
          workGeneration: 0,
          childGeneration: contract.childGeneration,
        };
      }
    } else if (event.kind === "declaration_invalidated") {
      contract.declaration = undefined;
    } else if (event.kind === "child_outcome" && event.childJobId && isStatus(event.outcome) && event.summary) {
      contract.childOutcomes.set(event.childJobId, { outcome: event.outcome, summary: event.summary });
    } else if (event.kind === "outcome" || event.kind === "transport_lost") {
      if (!event.outcome || !event.source || !event.summary) return;
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
