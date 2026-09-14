import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

const inheritedSubagentEnv = {
  TMUX_PANE: process.env.TMUX_PANE,
  PI_SUBAGENT_MANIFEST: process.env.PI_SUBAGENT_MANIFEST,
};
delete process.env.TMUX_PANE;
delete process.env.PI_SUBAGENT_MANIFEST;
test.after(() => {
  for (const [key, value] of Object.entries(inheritedSubagentEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const execFileAsync = promisify(execFile);

const { loadExtensions } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);
const { SessionManager } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/index.js")).href);
const backgroundPath = fileURLToPath(new URL("../background-jobs.ts", import.meta.url));
const taskPath = fileURLToPath(new URL("../task-outcomes.ts", import.meta.url));
const consumerPath = fileURLToPath(new URL("./consumer-test-extension.ts", import.meta.url));
const managerSourcePath = fileURLToPath(new URL("./manager.ts", import.meta.url));

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for task outcome state");
}

async function harness(t: any, sessionManager?: any, persistent = false) {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-test-"));
  const { extensions, errors, runtime } = await loadExtensions(
    [backgroundPath, taskPath, consumerPath],
    dir,
  );
  assert.deepEqual(errors, []);
  const sm = sessionManager ?? (persistent ? SessionManager.create(dir) : SessionManager.inMemory(dir));
  const messages: Array<{ text: string; options: any }> = [];
  const persisted: any[] = [];
  runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
  runtime.appendEntry = (type: string, data: unknown) => {
    persisted.push({ type, data });
    sm.appendCustomEntry(type, data);
  };
  const ctx: any = { cwd: dir, sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false };
  const emit = async (name: string, event: any = {}) => {
    for (const ext of extensions) {
      for (const handler of ext.handlers.get(name) ?? []) await handler(event, ctx);
    }
  };
  const call = (name: string, args: any = {}) => {
    const owner = extensions.find(ext => ext.tools.has(name));
    assert.ok(owner, `missing tool ${name}`);
    return owner.tools.get(name)!.definition.execute("test", args, undefined, undefined, ctx);
  };
  const snapshot = async () => (await call("task_outcomes_consumer", { action: "snapshot" })).details;
  const settle = async (options: { outcome?: string; summary?: string; stopReason?: string; text?: string; saveAssistant?: boolean } = {}) => {
    await emit("agent_start");
    await emit("turn_start", { turnIndex: 0 });
    if (options.outcome) {
      await call("report_outcome", { outcome: options.outcome, summary: options.summary ?? options.outcome });
    }
    const assistant = {
      role: "assistant",
      stopReason: options.stopReason ?? "toolUse",
      content: options.text !== undefined ? [{ type: "text", text: options.text }] : [],
    };
    await emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
    if (options.saveAssistant !== false) sm.appendMessage(assistant);
    await emit("agent_end", { messages: [assistant] });
    await emit("agent_settled");
  };
  await emit("session_start", { reason: "startup" });
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await delay(50);
    await rm(dir, { recursive: true, force: true });
  });
  const manager = (globalThis[Symbol.for("pi.task-outcomes.manager-registry")] as any).get(sm);
  return { dir, sm, call, emit, settle, snapshot, messages, persisted, runtime, manager };
}

const contract = (dir: string, jobId: string, attemptId: string, batchId = "batch") => ({
  action: "activate",
  job_id: jobId,
  attempt_id: attemptId,
  mode: "task",
  report_path: join(dir, `${jobId}-${attemptId}.md`),
  batch_id: batchId,
});

test("maintenance preparation seals the marker and validates single-use source-to-replacement ownership", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  await h.call("task_outcomes_consumer", contract(h.dir, "handoff", "attempt"));
  const source = h.sm.getLeafId();
  // Exercise the enabled preparation used by the human command.
  const lease = h.manager.beginMaintenance(h.sm.getSessionFile());
  assert.notEqual(lease.branchAnchor, source);
  assert.equal(lease.branchAnchor, h.sm.getLeafId());
  assert.equal(h.sm.getLeafEntry().data.kind, "maintenance_begin");
  assert.equal(h.sm.getLeafEntry().data.maintenance.branchAnchor, source);
  assert.equal(lease.reportPath, join(h.dir, "handoff-attempt.md"));
  h.manager.parkMaintenance(lease);
  assert.throws(() => h.manager.parkMaintenance(lease), /stale/);
  assert.throws(() => h.manager.claimMaintenance(lease), /owner/);
  const reopened = SessionManager.open(h.sm.getSessionFile());
  assert.equal(reopened.getSessionId(), h.sm.getSessionId());
  assert.equal(reopened.getSessionFile(), h.sm.getSessionFile());
  const outgoingRuntime = h.manager.runtime;
  const replacement = {
    ...outgoingRuntime, sessionOwner: reopened,
    leafId: () => reopened.getLeafId(), branchEntries: () => reopened.getBranch(),
    appendEntry: (type: string, data: unknown) => reopened.appendCustomEntry(type, data),
  };
  for (const field of ["maintenanceId", "ownerEpoch", "sessionId", "sessionFile", "jobId", "attemptId", "reportPath", "branchAnchor", "replacementAnchor"]) {
    assert.throws(() => h.manager.adopt(replacement, { ...lease, [field]: "wrong" }), /handoff/);
    assert.equal(h.manager.runtime, outgoingRuntime);
  }
  assert.throws(() => h.manager.adopt(outgoingRuntime, lease), /replacement session/);
  reopened.branch(source);
  reopened.appendCustomEntry("unrelated-branch", {});
  assert.throws(() => h.manager.adopt(replacement, lease), /replacement session/);
  for (const kind of ["cancellation_requested", "outcome", "maintenance_error", "message"]) {
    reopened.branch(lease.branchAnchor);
    if (kind === "message") reopened.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
    else reopened.appendCustomEntry(kind === "maintenance_error" ? "session-maintenance/v1" : "task-outcome/v1", { kind });
    assert.throws(() => h.manager.adopt(replacement, lease), /replacement session/);
  }
  reopened.branch(lease.branchAnchor);
  h.manager.adopt(replacement, lease);
  assert.throws(() => h.manager.claimMaintenance(lease), /stale/);
  assert.throws(() => h.manager.adopt(replacement, lease), /stale/);
  h.manager.resumeMaintenance(lease);
  assert.equal(h.manager.snapshot().maintenance, undefined);
  assert.throws(() => h.manager.claimMaintenance(lease), /stale/);
});

test("task lifecycle parks and adopts both owners independently of background extension order", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  await h.call("task_outcomes_consumer", contract(h.dir, "paired", "attempt"));
  const backgrounds = (globalThis as any)[Symbol.for("pi.background-jobs.manager-registry")];
  const background = backgrounds.get(h.sm);
  const lease = h.manager.beginMaintenance(h.sm.getSessionFile());
  await h.emit("session_shutdown", { reason: "maintenance", maintenance: lease });
  const sm = SessionManager.open(h.sm.getSessionFile());
  // Production 01a09e49: sdk + model-recency append metadata before task adoption.
  sm.appendModelChange("openai-codex-alt", "gpt-5.6-luna");
  sm.appendThinkingLevelChange("high");
  sm.appendCustomEntry("model-recency", { order: [] });
  sm.appendCustomEntry("model-recency", { order: [] });
  assert.notEqual(sm.getLeafId(), lease.branchAnchor);
  // Outgoing harness loads background first; the replacement loads task first.
  const loaded = await loadExtensions([taskPath, backgroundPath], h.dir);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.appendEntry = (type: string, data: unknown) => sm.appendCustomEntry(type, data);
  loaded.runtime.sendUserMessage = () => assert.fail("maintenance must not request a model turn");
  const ctx = { cwd: h.dir, sessionManager: sm };
  for (const ext of loaded.extensions) for (const handler of ext.handlers.get("session_start") ?? []) {
    await handler({ reason: "maintenance", maintenance: lease }, ctx);
  }
  assert.equal((globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")].get(sm), h.manager);
  assert.equal(backgrounds.get(sm), background);
  assert.equal(background.isInMaintenance(lease.maintenanceId), false);
  assert.equal(h.manager.snapshot().maintenance, undefined);
  assert.equal(h.manager.snapshot().active.state, "active");
  for (const key of ["pi.task-outcomes.maintenance-handoffs", "pi.background-jobs.maintenance-handoffs"]) {
    assert.equal((globalThis as any)[Symbol.for(key)].has(lease.maintenanceId), false);
  }
});

test("background failure compensates the task claim and durable error replays at session_start", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  await h.call("task_outcomes_consumer", contract(h.dir, "rollback", "attempt"));
  const lease = h.manager.prepareMaintenance(h.sm.getSessionFile());
  h.manager.parkMaintenance(lease);
  const fresh = SessionManager.open(h.sm.getSessionFile());
  const outgoing = h.manager.runtime;
  assert.throws(() => h.manager.adopt({ ...outgoing, sessionOwner: fresh,
    leafId: () => fresh.getLeafId(), branchEntries: () => fresh.getBranch(),
  }, lease, () => { throw new Error("background adoption failed"); }), /background adoption failed/);
  assert.equal(h.manager.runtime, outgoing);
  assert.equal(h.manager.snapshot().maintenance.phase, "parked");
  assert.deepEqual(h.manager.snapshot().outcomes, []);
  const { recordMaintenanceFailure } = await import(pathToFileURL(join(homedir(),
    ".local/share/pi-mono/packages/coding-agent/dist/core/agent-session-runtime.js")).href);
  recordMaintenanceFailure(h.sm.getSessionFile(), lease);
  recordMaintenanceFailure(h.sm.getSessionFile(), lease);
  assert.equal(SessionManager.open(h.sm.getSessionFile()).getBranch().filter((entry: any) =>
    entry.customType === "session-maintenance/v1").length, 1);
  const restored = await harness(t, SessionManager.open(h.sm.getSessionFile()));
  assert.equal(restored.manager.snapshot().maintenance.phase, "error");
  assert.equal(restored.manager.snapshot().active.state, "maintenance_pending");
  assert.deepEqual(restored.manager.snapshot().outcomes, []);
  await restored.emit("agent_settled");
  assert.equal(restored.manager.snapshot().outcomes.some((o: any) => o.final), false);
});

test("historical maintenance errors retry append-only and stay released after replay", async t => {
  for (const mode of ["session", "task", "final"]) {
    const h = await harness(t, undefined, true);
    await h.settle({ text: "saved", stopReason: "stop" });
    if (mode !== "session") await h.call("task_outcomes_consumer", contract(h.dir, "retry", "attempt"));
    if (mode === "task") h.manager.pauseForContext("preserve paused task", 256000);
    if (mode === "final") {
      await writeFile(join(h.dir, "retry-attempt.md"), "verified report");
      await h.settle({ outcome: "completed" });
    }
    const outcomes = h.manager.snapshot().outcomes;
    const failed = h.manager.beginMaintenance();
    const { recordMaintenanceFailure } = await import(pathToFileURL(join(homedir(),
      ".local/share/pi-mono/packages/coding-agent/dist/core/agent-session-runtime.js")).href);
    recordMaintenanceFailure(h.sm.getSessionFile(), failed);
    const restored = await harness(t, SessionManager.open(h.sm.getSessionFile()));
    const before = await readFile(h.sm.getSessionFile(), "utf8");
    const error = restored.sm.getBranch().find((e: any) => e.customType === "session-maintenance/v1");
    assert.equal(restored.manager.snapshot().maintenance.phase, "error");
    const retry = restored.manager.beginMaintenance();
    assert.notEqual(retry.maintenanceId, failed.maintenanceId);
    assert.notEqual(retry.ownerEpoch, failed.ownerEpoch);
    assert.throws(() => restored.manager.resumeMaintenance(failed), /not active/);
    restored.manager.resumeMaintenance(retry);
    if (mode === "task") assert.equal(restored.manager.snapshot().active.state, "context_paused");
    assert.ok((await readFile(h.sm.getSessionFile(), "utf8")).startsWith(before));
    restored.manager.onSessionTree();
    assert.equal(restored.manager.snapshot().maintenance, undefined);
    assert.deepEqual(restored.sm.getBranch().find((e: any) => e.id === error.id), error);
    const again = restored.manager.beginMaintenance();
    restored.manager.resumeMaintenance(again);
    assert.equal(restored.messages.length, 0);
    const replayed = await harness(t, SessionManager.open(h.sm.getSessionFile()));
    assert.equal(replayed.manager.snapshot().maintenance, undefined);
    const next = replayed.manager.beginMaintenance();
    replayed.manager.resumeMaintenance(next);
    if (mode === "final") {
      assert.deepEqual(replayed.manager.snapshot().outcomes, outcomes);
      assert.equal(replayed.manager.snapshot().contracts.at(-1).state, "final");
      await assert.rejects(() => replayed.call("report_outcome", { outcome: "failed", summary: "again" }), /active|final/);
    }
  }
});

test("maintenance error retry keeps idle, cancellation, work, persistence and owner fences", async t => {
  for (const scenario of ["busy", "queued", "cancellation", "child", "background", "owner", "other-lease", "write-failure"]) {
    const h = await harness(t, undefined, true);
    await h.settle({ text: "saved", stopReason: "stop" });
    const failed = h.manager.beginMaintenance();
    h.manager.failMaintenance(failed, new Error("original failure"));
    const restored = scenario === "owner" ? h : await harness(t, SessionManager.open(h.sm.getSessionFile()));
    if (scenario === "busy") restored.manager.runtime.isIdle = () => false;
    if (scenario === "queued") restored.manager.runtime.hasPendingMessages = () => true;
    if (scenario === "cancellation") restored.manager.requestCancellation("escape", "later cancellation");
    if (scenario === "child") {
      await restored.call("task_outcomes_consumer", { ...contract(restored.dir, "pending", "attempt"), children: ["child"] });
    }
    if (scenario === "background") restored.manager.background = () => ({
      isInMaintenance: () => false, stats: () => ({ running: 1 }),
    });
    if (scenario === "other-lease") restored.manager.background().beginMaintenance("another-live-lease");
    if (scenario === "write-failure") restored.manager.runtime.appendEntry = () => { throw new Error("disk unavailable"); };
    const before = restored.sm.getLeafId();
    assert.throws(() => restored.manager.beginMaintenance(), /idle|cancellation|pending|outstanding|disk unavailable|does not belong/);
    assert.equal(restored.sm.getLeafId(), before);
    assert.equal(restored.manager.snapshot().maintenance.phase, "error");
  }
});

test("maintenance no-change releases its lease; finality, pending work and cancellation still fence preparation", async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", contract(h.dir, "no-change", "attempt"));
  const lease = h.manager.prepareMaintenance();
  h.manager.resumeMaintenance(lease);
  assert.equal(h.manager.snapshot().maintenance, undefined);
  const next = h.manager.prepareMaintenance();
  assert.notEqual(next.ownerEpoch, lease.ownerEpoch);
  assert.throws(() => h.manager.parkMaintenance(lease), /stale/);
  h.manager.requestCancellation("task_cancel", "human cancelled");
  assert.throws(() => h.manager.parkMaintenance(next), /stale/);
  await h.emit("agent_settled");
  assert.equal((await h.snapshot()).contracts.at(-1).state, "final");
  assert.throws(() => h.manager.prepareMaintenance(), /cancellation|finalized/);

  const pending = await harness(t);
  await pending.call("task_outcomes_consumer", { ...contract(pending.dir, "pending", "attempt"), children: ["child"] });
  const before = pending.sm.getLeafId();
  assert.throws(() => pending.manager.prepareMaintenance(), /child\/background work is pending/);
  assert.equal(pending.sm.getLeafId(), before);

  const final = await harness(t);
  await final.call("task_outcomes_consumer", contract(final.dir, "final", "attempt"));
  await writeFile(join(final.dir, "final-attempt.md"), "verified report");
  await final.settle({ outcome: "completed" });
  assert.throws(() => final.manager.resumeAfterContextClean("final", "attempt", 0), /paused|final/);
  const sessionLease = final.manager.prepareMaintenance();
  assert.equal(sessionLease.jobId, undefined);
  final.manager.resumeMaintenance(sessionLease);
  assert.equal((await final.snapshot()).contracts.at(-1).state, "final");
});

test("historical session cancellation releases durably without deleting history; later cancellation invalidates the lease", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  h.manager.requestCancellation("task_cancel", "Jack's persisted cancellation");
  const cancellation = JSON.parse(JSON.stringify(h.sm.getLeafEntry().data));
  const restored = await harness(t, SessionManager.open(h.sm.getSessionFile()));
  const lease = restored.manager.beginMaintenance();
  assert.equal(lease.jobId, undefined);
  assert.equal(lease.attemptId, undefined);
  assert.equal(lease.reportPath, undefined);
  assert.equal(restored.sm.getLeafEntry().data.releasedCancellationEventId, cancellation.eventId);
  restored.manager.resumeMaintenance(lease);
  const replayed = await harness(t, SessionManager.open(h.sm.getSessionFile()));
  assert.equal(replayed.manager.cancellation, undefined);
  assert.deepEqual(replayed.sm.getBranch().find((e: any) => e.data?.eventId === cancellation.eventId).data, cancellation);
  const next = replayed.manager.beginMaintenance();
  replayed.manager.parkMaintenance(next);
  const fresh = SessionManager.open(h.sm.getSessionFile());
  replayed.manager.adopt({ ...replayed.manager.runtime, sessionOwner: fresh,
    branchEntries: () => fresh.getBranch(), leafId: () => fresh.getLeafId(),
    appendEntry: (type: string, data: unknown) => fresh.appendCustomEntry(type, data),
  }, next);
  replayed.manager.resumeMaintenance(next);
  const race = replayed.manager.beginMaintenance();
  replayed.manager.requestCancellation("task_cancel", "later cancellation");
  assert.notEqual(replayed.manager.cancellation.eventId, cancellation.eventId);
  assert.throws(() => replayed.manager.parkMaintenance(race), /stale/);
  assert.throws(() => replayed.manager.resumeMaintenance(race), /cancelled/);
  assert.throws(() => replayed.manager.beginMaintenance(), /cancellation/);
  assert.equal(replayed.manager.snapshot().outcomes.length, 0);
});

test("untasked typed terminal cancellation is persisted so the new session-only lease can acknowledge it", async t => {
  const h = await harness(t);
  await h.emit("agent_end", { messages: [], interruption: { kind: "cancel", source: "extension", reason: "extension requested cancellation" } });
  await h.emit("agent_settled");
  const event = h.persisted.find(row => row.data.kind === "cancellation_requested").data;
  assert.equal(event.jobId, undefined);
  const lease = h.manager.beginMaintenance();
  assert.equal(h.sm.getLeafEntry().data.releasedCancellationEventId, event.eventId);
  h.manager.resumeMaintenance(lease);
  assert.equal(h.manager.snapshot().outcomes.length, 0);
});

test("legacy session-only cancellation IDs release on replay without rewriting the historical event", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  const legacy = {
    version: 1, eventId: `task-outcome:cancellation_requested:${h.sm.getSessionId()}:extension`,
    at: new Date().toISOString(), kind: "cancellation_requested",
    cancellation: { source: "extension", reason: "assistant aborted" },
  };
  h.runtime.appendEntry("task-outcome/v1", legacy);
  h.manager.onSessionTree();
  const before = await readFile(h.sm.getSessionFile(), "utf8");
  const lease = h.manager.beginMaintenance();
  assert.equal(h.sm.getLeafEntry().data.releasedCancellationEventId, legacy.eventId);
  h.manager.resumeMaintenance(lease);
  assert.ok((await readFile(h.sm.getSessionFile(), "utf8")).startsWith(before));
  h.manager.onSessionTree();
  assert.equal(h.manager.cancellation, undefined);
  assert.deepEqual(h.sm.getBranch().find((e: any) => e.data?.eventId === legacy.eventId).data, legacy);
});

test("settled cancelled attempts allow only session cleaning, and new attempt activation is replay symmetric", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "saved", stopReason: "stop" });
  await h.call("task_outcomes_consumer", contract(h.dir, "cancelled", "A"));
  h.manager.pauseForContext("Luna guard", 256000);
  h.manager.requestCancellation("extension", "extension requested cancellation");
  await h.emit("agent_settled");
  const final = h.manager.snapshot().outcomes;
  const replayed = await harness(t, SessionManager.open(h.sm.getSessionFile()));
  const lease = replayed.manager.beginMaintenance();
  assert.equal(lease.jobId, undefined);
  replayed.manager.resumeMaintenance(lease);
  assert.deepEqual(replayed.manager.snapshot().outcomes, final);
  assert.throws(() => replayed.manager.resumeAfterContextClean("cancelled", "A", 1), /paused|final|no active/);
  await assert.rejects(() => replayed.call("report_outcome", { outcome: "failed", summary: "again" }), /active|final/);
  assert.equal(replayed.messages.length, 0);

  // Test activation retirement independently of the maintenance release.
  await h.call("task_outcomes_consumer", contract(h.dir, "next", "B", "batch-B"));
  assert.equal(h.manager.cancellation, undefined);
  h.manager.onSessionTree();
  assert.equal(h.manager.cancellation, undefined);
  assert.equal(h.manager.snapshot().active.attemptId, "B");
  h.manager.requestCancellation("escape", "escape B");
  const oldLatch = h.manager.cancellation;
  const activation = h.sm.getBranch().find((e: any) => e.data?.contract?.attemptId === "B").data;
  h.manager.apply({ ...activation, eventId: "membership-update", contract: { ...activation.contract, childJobIds: ["child"] } });
  assert.deepEqual(h.manager.cancellation, oldLatch);
  assert.deepEqual(h.manager.contracts.get("next@B").cancellation, oldLatch);
});

test("historical release eligibility and persistence fail closed before any new marker", async t => {
  for (const scenario of ["nonfinal", "queued", "busy", "child", "background", "write-failure"]) {
    const h = await harness(t, undefined, true);
    await h.settle({ text: "saved", stopReason: "stop" });
    if (scenario === "nonfinal" || scenario === "child") {
      await h.call("task_outcomes_consumer", { ...contract(h.dir, scenario, "A"), ...(scenario === "child" ? { children: ["pending-child"] } : {}) });
    }
    const gate = join(h.dir, "release-background");
    if (scenario === "background") await h.call("task_outcomes_consumer", {
      action: "background", batch_id: "running-batch", job_id: "running-job",
      command: `while [ ! -f '${gate}' ]; do sleep .02; done`,
    });
    h.manager.requestCancellation("task_cancel", scenario);
    if (scenario === "child") await h.emit("agent_settled");
    if (scenario === "queued") h.manager.runtime.hasPendingMessages = () => true;
    if (scenario === "busy") h.manager.runtime.isIdle = () => false;
    if (scenario === "write-failure") h.runtime.appendEntry = () => { throw new Error("marker storage failed"); };
    const before = await readFile(h.sm.getSessionFile(), "utf8");
    const latch = h.manager.cancellation;
    assert.throws(() => h.manager.beginMaintenance(), /cancellation|queued|idle|pending|marker storage failed/);
    assert.equal(await readFile(h.sm.getSessionFile(), "utf8"), before);
    assert.deepEqual(h.manager.cancellation, latch);
    if (scenario === "background") {
      await writeFile(gate, "");
      await until(() => h.manager.background().stats().running === 0);
    }
    if (scenario === "write-failure") {
      const replayed = await harness(t, SessionManager.open(h.sm.getSessionFile()));
      assert.deepEqual(replayed.manager.cancellation, latch);
    }
  }
});

test("Luna guard uses the real interactive abort binding at 271925, not at 255999", async t => {
  const core = join(homedir(), ".local/share/pi-mono/packages/coding-agent/dist");
  const { InteractiveMode } = await import(pathToFileURL(join(core, "modes/interactive/interactive-mode.js")).href);
  const { AgentSession } = await import(pathToFileURL(join(core, "core/agent-session.js")).href);
  for (const [tokens, failPause] of [[255999, false], [271925, false], [271925, true]] as const) {
    const h = await harness(t);
    await h.call("task_outcomes_consumer", contract(h.dir, "guard", "A"));
    const loaded = await loadExtensions([fileURLToPath(new URL("../openai-272k-guard.ts", import.meta.url))], h.dir);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = h.runtime.appendEntry;
    loaded.runtime.sendUserMessage = h.runtime.sendUserMessage;
    let abortAction: any;
    let aborts = 0;
    const session: any = {
      _runId: 42,
      requestExtensionAbort: AgentSession.prototype.requestExtensionAbort,
      requestCancellation: AgentSession.prototype.requestCancellation,
      bindExtensions: (binding: any) => { abortAction = binding.abortHandler; },
      resourceLoader: { getThemes: () => ({ themes: [] }) },
      agent: { abort: () => { aborts++; } },
    };
    const mode = Object.create(InteractiveMode.prototype);
    Object.defineProperty(mode, "session", { value: session });
    Object.defineProperty(mode, "agent", { value: session.agent });
    Object.assign(mode, {
      createExtensionUIContext: () => ({}), setupAutocompleteProvider: () => {},
      setupExtensionShortcuts: () => {}, showLoadedResources: () => {}, showStartupNoticesIfNeeded: () => {},
      clearAllQueues: () => ({ steering: [], followUp: [] }), updatePendingMessagesDisplay: () => {},
    });
    await mode.bindCurrentSessionExtensions();
    const handler = loaded.extensions[0].handlers.get("before_provider_request")[0];
    const payload = { input: ["private"], tools: [{}] };
    const ctx = {
      sessionManager: h.sm, isIdle: () => true, hasPendingMessages: () => false,
      model: { provider: "openai-codex-personal", id: "gpt-5.6-luna", contextWindow: 272000, cost: {} },
      getContextUsage: () => ({ tokens }), ui: { setStatus: () => {}, notify: () => {} }, abort: abortAction,
    };
    if (failPause) loaded.runtime.appendEntry = () => { throw new Error("pause save failed"); };
    const result = await handler({ payload }, ctx);
    loaded.runtime.appendEntry = h.runtime.appendEntry;
    assert.equal(aborts, tokens === 271925 ? 1 : 0);
    if (tokens === 255999) { assert.equal(result, undefined); continue; }
    assert.deepEqual(result, { input: [], tools: [] });
    assert.equal(session._interruption.kind, "context");
    assert.equal(session._interruption.runId, 42);
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }], interruption: session._interruption });
    await h.emit("agent_settled");
    assert.equal(h.persisted.filter(e => e.data.kind === "context_pause").length, failPause ? 0 : 1);
    assert.equal(h.persisted.filter(e => e.data.kind === "cancellation_requested").length, 0);
    const finals = h.manager.snapshot().outcomes.filter((o: any) => o.final);
    assert.equal(finals.length, failPause ? 1 : 0);
    if (failPause) assert.match(finals[0].summary, /no saved recoverable pause/);
    assert.equal(h.messages.length, 0);
    session.requestCancellation("escape", "real Escape");
    abortAction({ kind: "context", reason: "late guard" });
    assert.equal(session._interruption.kind, "cancel");
    assert.equal(session._interruption.source, "escape");
  }
});

test("friendly forceStop saves before typed abort and still aborts if pause storage fails", async t => {
  for (const failPause of [false, true]) {
    const h = await harness(t);
    await h.call("task_outcomes_consumer", contract(h.dir, "friendly", "A"));
    const savedEnv = { PI_RLM_FRIENDLY_STOP_TOKENS: process.env.PI_RLM_FRIENDLY_STOP_TOKENS, PI_RLM_ROLLOVER_DIR: process.env.PI_RLM_ROLLOVER_DIR };
    let loaded: any;
    try {
      Object.assign(process.env, { PI_RLM_FRIENDLY_STOP_TOKENS: "40", PI_RLM_ROLLOVER_DIR: h.dir });
      loaded = await loadExtensions([fileURLToPath(new URL("../../optional-extensions/rlm-friendly-stop.ts", import.meta.url))], h.dir);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    assert.deepEqual(loaded.errors, []);
    const appendEntry = h.runtime.appendEntry;
    loaded.runtime.appendEntry = appendEntry;
    const aborts: any[] = [];
    if (failPause) h.runtime.appendEntry = () => { throw new Error("pause storage failed"); };
    const ctx: any = {
      sessionManager: h.sm, getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
      abort: (options: any) => {
        assert.equal(h.persisted.some(row => row.data.kind === "context_pause"), !failPause);
        aborts.push(options);
      },
    };
    const stop = loaded.extensions[0].handlers.get("context")[0]({ messages: [] }, ctx);
    try {
      if (failPause) await assert.rejects(stop, /pause storage failed/);
      else await stop;
    } finally {
      h.runtime.appendEntry = appendEntry;
    }
    assert.equal(aborts.length, 1);
    assert.equal(aborts[0].kind, "context");
    assert.match(aborts[0].reason, /upper boundary/);
  }
});

test("typed context stops retain pauses while every terminal source wins exactly once", async t => {
  for (const phase of ["context", "pending", "parked"]) for (const source of [undefined, "escape", "task_cancel", "extension"]) {
    const h = await harness(t);
    await h.call("task_outcomes_consumer", contract(h.dir, "typed", "A"));
    h.manager.pauseForContext("guard at 271925", 256000);
    const lease = phase === "context" ? undefined : h.manager.beginMaintenance();
    if (phase === "parked") h.manager.parkMaintenance(lease);
    const interruption = source
      ? { kind: "cancel", source, reason: "terminal" }
      : { kind: "context", source: "context", reason: "guard at 271925" };
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }], interruption });
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    assert.equal(h.persisted.filter(e => e.data.kind === "context_pause").length, 1);
    assert.equal(h.persisted.filter(e => e.data.kind === "cancellation_requested").length, source ? 1 : 0);
    const finals = h.manager.snapshot().outcomes.filter((o: any) => o.final);
    assert.equal(finals.length, source ? 1 : 0);
    if (source) {
      assert.equal(finals[0].source, "technical");
      assert.equal(finals[0].outcome, "failed");
      if (lease) {
        assert.throws(() => h.manager.resumeMaintenance(lease), /cancelled/);
        assert.throws(() => h.manager.beginMaintenance(), /cancellation/);
      }
    }
    assert.equal(h.messages.length, 0);
  }
});

test("pending-work maintenance rejects before persistence and preserves later child/background results", async t => {
  const h = await harness(t);
  const gate = join(h.dir, "maintenance-background-release");
  await h.call("task_outcomes_consumer", {
    ...contract(h.dir, "maintenance-parent", "attempt", "maintenance-batch"), children: ["child"],
  });
  await h.call("task_outcomes_consumer", {
    action: "background", batch_id: "maintenance-batch", job_id: "background",
    command: `while [ ! -f '${gate}' ]; do sleep .02; done; printf preserved`,
  });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "maintenance-batch" });
  const before = await h.snapshot();
  const persisted = h.persisted.length;
  for (let i = 0; i < 2; i++) {
    assert.throws(() => h.manager.beginMaintenance(), /child\/background work is pending/);
    assert.deepEqual(await h.snapshot(), before);
    assert.equal(h.persisted.length, persisted, "no marker or false final may be written");
    assert.equal(h.messages.length, 0);
  }
  for (let i = 0; i < 2; i++) {
    h.manager.recordChildOutcome("maintenance-parent", "child", "completed", "child survived", "model", "child-attempt");
  }
  await writeFile(gate, "");
  await until(async () => (await h.snapshot()).active.pendingWork.length === 0);
  await until(() => h.messages.length === 1);
  assert.equal(h.persisted.filter(row => row.data.kind === "child_outcome").length, 1);
  assert.equal((await h.snapshot()).outcomes.length, 0);
});

test("launcher ingestion preserves durable dynamic child membership", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  const jobId = "manifest-parent";
  const attemptId = "manifest-attempt";
  const batchId = "manifest-batch";
  const reportPath = join(h.dir, "manifest-parent.md");
  const manifestPath = join(h.dir, "manifest.json");
  await h.call("task_outcomes_consumer", { action: "batch_open", batch_id: batchId, expected: 3 });
  const activatedAt = Date.now();
  await writeFile(reportPath, "");
  const report = await lstat(reportPath);
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    jobId,
    attemptId,
    mode: "task",
    reportPath,
    reportIdentity: { dev: String(report.dev), ino: String(report.ino) },
    activatedAt,
    batchId,
    parentJobId: "outer-parent",
    childJobIds: [],
  }));
  const oldManifest = process.env.PI_SUBAGENT_MANIFEST;
  process.env.PI_SUBAGENT_MANIFEST = manifestPath;
  try {
    assert.deepEqual(h.manager.ingestLauncherContract()?.childJobIds, []);
    h.manager.registerChild(jobId, "child-one");
    h.manager.registerChild(jobId, "child-two");
    await h.emit("session_tree");
    const reingested = h.manager.ingestLauncherContract();
    assert.deepEqual(reingested?.childJobIds, ["child-one", "child-two"]);
    assert.deepEqual((await h.snapshot()).active.childJobIds, ["child-one", "child-two"]);
    h.manager.recordChildOutcome(jobId, "child-one", "completed", "child one done");
    h.manager.recordChildOutcome(jobId, "child-two", "completed", "child two done");
    await h.call("task_outcomes_consumer", { action: "close", batch_id: batchId });
    await writeFile(reportPath, "final report");
    await h.settle({ outcome: "completed", summary: "parent done" });
    const final = h.manager.ingestLauncherContract();
    assert.equal(final?.state, "final");
    assert.deepEqual(final?.childJobIds, ["child-one", "child-two"]);
    assert.throws(() => h.manager.registerChild(jobId, "late-child"), /no active/);
  } finally {
    if (oldManifest === undefined) delete process.env.PI_SUBAGENT_MANIFEST;
    else process.env.PI_SUBAGENT_MANIFEST = oldManifest;
  }
});

 test("launcher ingestion still rejects immutable manifest changes", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  const base = {
    version: 1,
    jobId: "manifest-check",
    attemptId: "manifest-attempt",
    mode: "task",
    reportPath: join(h.dir, "manifest-check.md"),
    batchId: "manifest-check-batch",
    parentJobId: "outer-parent",
    childJobIds: [] as string[],
  };
  const manifestPath = join(h.dir, "manifest-check.json");
  await h.call("task_outcomes_consumer", { action: "batch_open", batch_id: base.batchId, expected: 3 });
  const activatedAt = Date.now();
  await writeFile(base.reportPath, "");
  const report = await lstat(base.reportPath);
  const withReservation = {
    ...base,
    reportIdentity: { dev: String(report.dev), ino: String(report.ino) },
    activatedAt,
  };
  const writeManifest = async (changes: Record<string, unknown> = {}) =>
    writeFile(manifestPath, JSON.stringify({ ...withReservation, ...changes }));
  await writeManifest();
  const oldManifest = process.env.PI_SUBAGENT_MANIFEST;
  process.env.PI_SUBAGENT_MANIFEST = manifestPath;
  try {
    assert.deepEqual(h.manager.ingestLauncherContract()?.childJobIds, []);
    h.manager.registerChild(base.jobId, "manifest-child");
    for (const [name, changes] of [
      ["job", { jobId: "different-job" }],
      ["attempt", { attemptId: "different-attempt" }],
      ["mode", { mode: "dialogue" }],
      ["report path", { reportPath: join(h.dir, "different-report.md") }],
      ["report reservation", { reportIdentity: { dev: "0", ino: "0" } }],
      ["parent", { parentJobId: "different-parent" }],
      ["batch", { batchId: "different-batch" }],
    ] as const) {
      await writeManifest(changes);
      assert.throws(() => h.manager.ingestLauncherContract(), /conflicts with/, `${name} mismatch was accepted`);
    }
    await writeManifest({ childJobIds: ["stale-manifest-child"] });
    assert.deepEqual(h.manager.ingestLauncherContract()?.childJobIds, ["manifest-child"]);
    assert.throws(() => h.manager.registerChild(base.jobId, base.jobId), /own child/);
    await assert.rejects(
      h.call("task_outcomes_consumer", {
        action: "activate", job_id: "reservation-other", attempt_id: "other-attempt", mode: "task",
        report_path: base.reportPath, batch_id: base.batchId,
      }),
      /fresh|unused|report/i,
    );
  } finally {
    if (oldManifest === undefined) delete process.env.PI_SUBAGENT_MANIFEST;
    else process.env.PI_SUBAGENT_MANIFEST = oldManifest;
  }
});

 test("pending child and bash_bg work hold the parent until fresh declaration", { timeout: 15000 }, async t => {
  const h = await harness(t);
  const gate = join(h.dir, "release-g");
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "P", "p1", "P-batch"), children: ["K"] });
  await h.call("task_outcomes_consumer", {
    action: "background", batch_id: "P-batch", job_id: "G",
    command: `while [ ! -f '${gate}' ]; do sleep .02; done; printf G`,
  });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "P-batch" });
  await writeFile(join(h.dir, "P-p1.md"), "provisional report");
  await assert.rejects(
    h.call("report_outcome", { outcome: "completed", summary: "premature" }),
    /premature|pending work/,
  );
  await h.settle();
  assert.equal(h.messages.length, 0);
  assert.equal((await h.snapshot()).outcomes.length, 0);

  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "P", child_job_id: "K", status: "completed", summary: "K done",
  });
  await writeFile(gate, "");
  await until(async () => (await h.snapshot()).active.pendingWork.length === 0);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].text, /No background or child jobs remain running for this attempt/);
  await writeFile(join(h.dir, "P-p1.md"), "full report");
  await h.settle({ outcome: "completed", summary: "P synthesized" });
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].text, /P synthesized/);
  assert.match(h.messages[1].text, /job_1|exit 0/);
});

test("report verification is tied to the active attempt and settlement", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "F", "f1", "F-batch") });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "F-batch" });
  await writeFile(join(h.dir, "F-f1.md"), "provisional");
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "declared" });
  await unlink(join(h.dir, "F-f1.md"));
  await h.emit("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse", content: [] }] });
  await h.emit("agent_settled");
  const failed = (await h.snapshot()).outcomes.at(-1);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.source, "technical");
  assert.match(failed.summary, /report invalid/);

  await h.call("task_outcomes_consumer", { ...contract(h.dir, "N", "n1") });
  await h.settle();
  await h.settle();
  await h.settle();
  const incomplete = (await h.snapshot()).outcomes.at(-1);
  assert.equal(incomplete.outcome, "failed");
  assert.equal(incomplete.source, "protocol");
  assert.match(incomplete.summary, /protocol-incomplete/);

  await h.call("task_outcomes_consumer", { ...contract(h.dir, "W", "w1", "W-batch") });
  await writeFile(join(h.dir, "other.md"), "wrong attempt artifact");
  await assert.rejects(
    h.call("report_outcome", { outcome: "completed", summary: "wrong artifact" }),
    /ENOENT|no such file|report/,
  );
});

test("final task attempts can be followed up in the same saved session", async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "continue", "c1", "continue-batch-1") });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "continue-batch-1" });
  await writeFile(join(h.dir, "continue-c1.md"), "first report");
  await h.settle({ outcome: "completed", summary: "first attempt" });
  assert.equal((await h.snapshot()).active, undefined);

  const next = await h.call("task_outcomes_consumer", { ...contract(h.dir, "continue", "c2", "continue-batch-2") });
  assert.equal(next.details.state, "active");
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "continue-batch-2" });
  await writeFile(join(h.dir, "continue-c2.md"), "second report");
  await h.settle({ outcome: "completed", summary: "second attempt" });

  const records = (await h.snapshot()).outcomes.filter((item: any) => item.jobId === "continue");
  assert.deepEqual(records.map((item: any) => [item.attemptId, item.outcome]), [["c1", "completed"], ["c2", "completed"]]);
});

test("task contracts inject instructions and correct missing declarations without duplicate wakes", async t => {
  const h = await harness(t);
  assert.equal(h.manager.taskInstruction(), undefined);
  await h.call("task_outcomes_consumer", contract(h.dir, "repair", "r1"));
  assert.match(h.manager.taskInstruction(), /report_outcome/);
  assert.ok(h.manager.taskInstruction().includes(JSON.stringify(join(h.dir, "repair-r1.md"))));
  await h.settle({ stopReason: "stop", text: "Done" });
  assert.equal((await h.snapshot()).outcomes.length, 0);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /Report validation/);
  assert.equal(h.messages[0].options.deliverAs, "followUp");
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 1);
  await writeFile(join(h.dir, "repair-r1.md"), "verified findings");
  await h.settle({ outcome: "completed", summary: "repaired" });
  assert.equal((await h.snapshot()).outcomes.at(-1).outcome, "completed");
  assert.equal(h.manager.taskInstruction(), undefined);
});

test("missing declarations stop after two corrective turns", async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", contract(h.dir, "limit", "l1"));
  await h.settle({ stopReason: "stop", text: "first" });
  await h.settle({ stopReason: "stop", text: "second" });
  assert.equal(h.messages.length, 2);
  await h.settle({ stopReason: "stop", text: "third" });
  const outcome = (await h.snapshot()).outcomes.at(-1);
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.source, "protocol");
  assert.match(outcome.summary, /after two corrective turns/);
  assert.equal(h.messages.length, 2);
});

test("dialogue and technical failures never trigger task corrections", async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { action: "activate", job_id: "chat", attempt_id: "c1", mode: "dialogue" });
  assert.equal(h.manager.taskInstruction(), undefined);
  await h.settle({ stopReason: "stop", text: "hello" });
  assert.equal((await h.snapshot()).outcomes.at(-1).outcome, "dialogue_settled");
  await h.call("task_outcomes_consumer", contract(h.dir, "abort", "a1"));
  await h.settle({ stopReason: "aborted" });
  assert.equal((await h.snapshot()).outcomes.at(-1).source, "technical");
  assert.equal(h.messages.length, 0);
});

test("batch failures wait for siblings and needs_input is non-final until a fresh attempt", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "A", "a1", "batch-ab"), children: ["B"] });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "batch-ab" });
  await h.settle({ outcome: "failed", summary: "A failed semantically" });
  assert.equal(h.messages.length, 0);

  await h.call("task_outcomes_consumer", { ...contract(h.dir, "B", "b1", "batch-ab") });
  await h.settle({ outcome: "needs_input", summary: "choose a continuation" });
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /choose a continuation/);
  const before = (await h.snapshot()).outcomes.filter((item: any) => item.outcome === "needs_input");
  assert.equal(before.length, 1);

  await assert.rejects(
    h.call("report_outcome", { outcome: "needs_input", summary: "duplicate question" }),
    /no active|not active|already declared/,
  );
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "B", "b2", "batch-ab") });
  await writeFile(join(h.dir, "B-b2.md"), "B report");
  await h.settle({ outcome: "completed", summary: "B resolved" });
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].text, /A failed semantically/);
  assert.match(h.messages[1].text, /B resolved/);
  const records = (await h.snapshot()).outcomes;
  assert.ok(records.some((item: any) => item.attemptId === "b1" && item.outcome === "needs_input"));
  assert.ok(records.some((item: any) => item.attemptId === "b2" && item.outcome === "completed"));
});

test("retry success does not become failure; abort after a provisional completion is technical", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "R", "r1") });
  await writeFile(join(h.dir, "R-r1.md"), "R report");
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable", content: [] }] });
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "retry recovered" });
  await h.emit("turn_end", {
    turnIndex: 0,
    message: { role: "assistant", stopReason: "toolUse", content: [] },
    toolResults: [{ isError: true }],
  });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse", content: [] }] });
  await h.emit("agent_settled");
  assert.equal((await h.snapshot()).outcomes.at(-1).outcome, "completed");

  await h.call("task_outcomes_consumer", { ...contract(h.dir, "X", "x1") });
  await writeFile(join(h.dir, "X-x1.md"), "X report");
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "will abort" });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "user abort", content: [] }] });
  await h.emit("agent_settled");
  assert.equal((await h.snapshot()).outcomes.at(-1).outcome, "failed");
  assert.equal((await h.snapshot()).outcomes.at(-1).source, "technical");
});

test("dialogue mode saves a settled assistant response without a report or command fabrication", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "D", attempt_id: "d1", mode: "dialogue",
  });
  assert.equal((await h.snapshot()).outcomes.length, 0);
  await h.settle({ text: "saved dialogue response", stopReason: "stop" });
  const outcome = (await h.snapshot()).outcomes.at(-1);
  assert.equal(outcome.outcome, "dialogue_settled");
  assert.match(outcome.summary, /saved dialogue response/);
  assert.equal(h.messages.length, 0);
  assert.deepEqual((await h.snapshot()).events.map((event: any) => event.outcome), ["dialogue_settled"]);
});

test("dialogue reports preserve text blocks, explicit empty output, and absent output is not success", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { action: "activate", job_id: "verbatim", attempt_id: "v1", mode: "dialogue" });
  const assistant = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "  leading\n" }, { type: "text", text: "unicode 😀\ntrailing  " }],
  };
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
  h.sm.appendMessage(assistant as any);
  await h.emit("agent_end", { messages: [assistant] });
  assert.equal((await h.snapshot()).outcomes.length, 0);
  await h.emit("agent_settled");
  const event = (await h.snapshot()).events.at(-1);
  assert.equal(event.reportText, "  leading\nunicode 😀\ntrailing  ");
  assert.equal((await h.snapshot()).outcomes.at(-1).summary, event.reportText);

  await h.call("task_outcomes_consumer", { action: "activate", job_id: "verbatim", attempt_id: "v2", mode: "dialogue" });
  await h.settle();
  const emptyEvent = (await h.snapshot()).events.at(-1);
  assert.equal(emptyEvent.outcome, "dialogue_settled");
  assert.equal(emptyEvent.reportText, "");

  await h.call("task_outcomes_consumer", { action: "activate", job_id: "absent", attempt_id: "a1", mode: "dialogue" });
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.emit("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_settled");
  const absent = (await h.snapshot()).outcomes.at(-1);
  assert.equal(absent.outcome, "failed");
  assert.equal(absent.source, "protocol");
  assert.match(absent.summary, /no valid assistant text/);
  assert.equal(Object.prototype.hasOwnProperty.call((await h.snapshot()).events.at(-1), "reportText"), false);
});

test("dialogue reports keep large text separate from bounded status", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { action: "activate", job_id: "large", attempt_id: "l1", mode: "dialogue" });
  const exact = "😀".repeat(11_000) + "\nend  ";
  await h.settle({ text: exact });
  const outcome = (await h.snapshot()).outcomes.at(-1);
  const event = (await h.snapshot()).events.at(-1);
  assert.equal(event.reportText, exact);
  assert.ok(Buffer.byteLength(exact) > 16 * 1024);
  assert.ok(outcome.summary.length <= 20_000);
  assert.notEqual(outcome.summary, exact);
});

test("durable records precede notification and restart does not claim stale ownership", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-durable-"));
  const sm = SessionManager.create(dir);
  const h = await harness(t, sm);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "D", "d1", "durable") });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "durable" });
  await writeFile(join(h.dir, "D-d1.md"), "durable report");
  await h.settle({ outcome: "completed", summary: "durably complete" });
  assert.equal(h.persisted.at(-1).type, "task-outcome/v1");
  assert.equal(h.persisted.at(-1).data.kind, "outcome");
  assert.equal(h.messages.length, 1);
  const sidecar = `${sm.getSessionFile()}.task-outcomes.jsonl`;
  assert.ok(sm.getSessionFile());
  assert.match(await readFile(sidecar, "utf8"), /durably complete/);

  await h.emit("session_shutdown", { reason: "reload" });
  const restarted = await harness(t, sm);
  const restored = await restarted.snapshot();
  assert.ok(restored.outcomes.some((item: any) => item.outcome === "completed" && item.attemptId === "d1"));
  assert.equal(restored.active, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("sidecar replay stays on the active session branch", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-branch-"));
  const sm = SessionManager.create(dir);
  const h = await harness(t, sm);
  const report = join(dir, "branch-a1.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "branch-job", attempt_id: "a1", mode: "task", report_path: report,
  });
  await writeFile(report, "branch report");
  await h.settle({ outcome: "completed", summary: "abandoned branch outcome" });
  // Make the session file authoritative, then move the real manager to an empty branch.
  sm.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as any);
  sm.resetLeaf();
  const reopened = SessionManager.open(sm.getSessionFile()!);
  reopened.resetLeaf();
  const fresh = await harness(t, reopened);
  const snapshot = await fresh.snapshot();
  assert.equal(snapshot.outcomes.length, 0);
  assert.equal(snapshot.contracts.length, 0);
  await fresh.call("task_outcomes_consumer", {
    action: "activate", job_id: "branch-job", attempt_id: "a2", mode: "task",
    report_path: join(dir, "branch-a2.md"),
  });
});

test("a fresh attempt rejects a reused report path", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const report = join(h.dir, "reused.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "reuse", attempt_id: "a1", mode: "task", report_path: report,
  });
  await writeFile(report, "old attempt report");
  await h.settle({ outcome: "needs_input", summary: "choose a continuation" });
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "reuse", attempt_id: "a2", mode: "task", report_path: report,
    }),
    /fresh|reuse|exist|report/i,
  );
});

test("work that starts and finishes after declaration invalidates completion", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const report = join(h.dir, "same-run.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "same-run", attempt_id: "a1", mode: "task", report_path: report,
  });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "batch" });
  await writeFile(report, "same run report");
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "declared before work" });
  const job = await h.call("bash_bg", { command: "true", label: "after declaration" });
  await until(async () => (await h.call("bash_tail", { job_id: job.details.job_id })).details.alive === false);
  const assistant = { role: "assistant", stopReason: "toolUse", content: [] };
  await h.emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
  await h.emit("agent_end", { messages: [assistant] });
  await h.emit("agent_settled");
  const snapshot = await h.snapshot();
  assert.equal(snapshot.outcomes.filter((item: any) => item.attemptId === "a1" && item.final).length, 0);
  assert.equal(snapshot.active.declaration, undefined);
});

test("failed durable child persistence remains retryable", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "mut", attempt_id: "a1", mode: "dialogue", children: ["child"],
  });
  const append = h.runtime.appendEntry;
  h.runtime.appendEntry = (type: string, data: unknown) => {
    append(type, data);
    throw new Error("append unavailable");
  };
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "child_outcome", job_id: "mut", child_job_id: "child", status: "completed", summary: "child done",
    }),
    /append unavailable/,
  );
  assert.match(await readFile(`${h.sm.getSessionFile()}.task-outcomes.jsonl`, "utf8"), /child done/);
  assert.deepEqual((await h.snapshot()).active.pendingWork, ["child:child"]);
  h.runtime.appendEntry = append;
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "mut", child_job_id: "child", status: "completed", summary: "child done",
  });
  assert.deepEqual((await h.snapshot()).active.pendingWork, []);
});

test("session loss is transport evidence, not semantic success", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "lost", "l1") });
  const replacementSm = SessionManager.inMemory(h.dir, { id: "replacement-owner" }, h.sm.getEntries());
  const replacement = await harness(t, replacementSm);
  assert.equal((await replacement.snapshot()).active, undefined);
  await h.emit("session_shutdown", { reason: "reload" });
  const record = (await h.snapshot()).outcomes.at(-1);
  assert.equal(record.outcome, "transport_lost");
  assert.equal(record.source, "transport");
  assert.equal(record.final, false);
});

test("sidecar replay requires the exact active-branch event, not its inherited token", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-branch-diverge-"));
  const sm = SessionManager.create(dir);
  const h = await harness(t, sm);
  const report = join(dir, "branch-diverge.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "branch-job", attempt_id: "a1", mode: "task", report_path: report,
  });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "batch" });
  await writeFile(report, "branch report");
  await h.settle({ outcome: "completed", summary: "abandoned branch outcome" });
  const contractEntry = sm.getEntries().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "contract");
  assert.ok(contractEntry);
  sm.branch(contractEntry.id);
  sm.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as any);
  await h.emit("session_tree");
  const snapshot = await h.snapshot();
  assert.equal(snapshot.outcomes.length, 0);
  assert.equal(snapshot.contracts.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("failed activation does not persist a contract or partial batch membership", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", { action: "batch_open", batch_id: "overflow", expected: 1 });
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "overflow-job", attempt_id: "o1", mode: "dialogue", batch_id: "overflow",
      children: ["overflow-child"],
    }),
    /Unknown|batch|members|already has/i,
  );
  const overflow = await h.call("task_outcomes_consumer", { action: "batch_stats", batch_id: "overflow" });
  assert.equal(overflow.details.members, 0);
  assert.equal(overflow.details.open, true);

  await h.call("task_outcomes_consumer", { action: "activate", job_id: "seed", attempt_id: "s1", mode: "dialogue", batch_id: "closed-batch" });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "closed-batch" });
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "closed-job", attempt_id: "c1", mode: "dialogue", batch_id: "closed-batch",
    }),
    /closed|complete/i,
  );
  assert.equal((await h.snapshot()).contracts.some((item: any) => /overflow-job|closed-job/.test(item.jobId)), false);
  assert.equal(h.sm.getBranch().some(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" &&
    /overflow-job|closed-job/.test((entry.data as any).contract?.jobId ?? "")), false);
  assert.doesNotMatch(await readFile(`${h.sm.getSessionFile()}.task-outcomes.jsonl`, "utf8"), /overflow-job|closed-job/);
});

test("a final append that throws after mutation is idempotent on retry", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", { ...contract(h.dir, "partial", "p1", "partial-batch") });
  await h.call("task_outcomes_consumer", { action: "close", batch_id: "partial-batch" });
  await writeFile(join(h.dir, "partial-p1.md"), "partial report");
  const append = h.runtime.appendEntry;
  let fail = true;
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (fail && data?.kind === "outcome" && data?.outcome === "completed") {
      fail = false;
      throw new Error("storage unavailable after final append");
    }
  };
  await assert.rejects(h.settle({ outcome: "completed", summary: "retry me" }), /storage unavailable/);
  h.runtime.appendEntry = append;
  await h.settle();
  const outcomeEntries = h.sm.getEntries().filter(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "outcome");
  assert.equal(outcomeEntries.length, 1);
  assert.equal((await h.snapshot()).outcomes.filter((item: any) => item.final).length, 1);

  await h.emit("session_shutdown", { reason: "reload" });
  const restarted = await harness(t, h.sm);
  assert.equal((await restarted.snapshot()).outcomes.filter((item: any) => item.final).length, 1);
});

test("replay preserves child evidence and the generation boundary", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "parent", attempt_id: "p1", mode: "task",
    report_path: join(h.dir, "parent-p1.md"), children: ["early"],
  });
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "parent", child_job_id: "early", status: "completed", summary: "early done",
  });
  await h.call("task_outcomes_consumer", { action: "child", job_id: "parent", child_job_id: "late" });
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "parent", child_job_id: "late", status: "completed", summary: "late done",
  });
  await writeFile(join(h.dir, "parent-p1.md"), "parent report");
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "all children done" });
  await h.emit("session_tree");
  const replayed = await h.snapshot();
  assert.deepEqual(replayed.active.pendingWork, []);
  assert.deepEqual(replayed.active.childJobIds, ["early", "late"]);
  assert.equal(replayed.active.declaration.outcome, "completed");
  const membership = h.sm.getBranch().filter(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "contract").at(-1);
  assert.equal((membership?.data as any).contract.childGeneration, 1);
  const assistant = { role: "assistant", stopReason: "stop", content: [] };
  await h.emit("turn_end", { turnIndex: 0, message: assistant });
  h.sm.appendMessage(assistant as any);
  await h.emit("agent_end", { messages: [assistant] });
  await h.emit("agent_settled");
  assert.equal((await h.snapshot()).outcomes.at(-1).outcome, "completed");
});

test("dangling report symlinks are not fresh report paths", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const report = join(h.dir, "dangling-report.md");
  await symlink(join(h.dir, "missing-target"), report);
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "dangling", attempt_id: "d1", mode: "task", report_path: report,
    }),
    /fresh|unused|report/i,
  );
});

test("a nonempty report symlink cannot satisfy completion", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const report = join(h.dir, "symlink-report.md");
  const target = join(h.dir, "unrelated.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "symlink", attempt_id: "s1", mode: "task", report_path: report,
  });
  await writeFile(target, "unrelated nonempty target");
  await unlink(report);
  await symlink(target, report);
  await assert.rejects(
    h.call("report_outcome", { outcome: "completed", summary: "symlink must fail" }),
    /report|symlink|ELOOP/i,
  );
});

test("task report validation rejects a FIFO without waiting for a writer", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const report = join(h.dir, "fifo-report.md");
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "fifo", attempt_id: "f1", mode: "task", report_path: report,
  });
  await unlink(report);
  await execFileAsync("mkfifo", [report]);
  const result = await Promise.race([
    h.call("report_outcome", { outcome: "completed", summary: "fifo must fail" }).then(() => "accepted", () => "rejected"),
    delay(500).then(() => "blocked"),
  ]);
  assert.equal(result, "rejected");
});

test("child work after completion declaration wakes the fresh settlement boundary", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "child-wake", attempt_id: "cw1", mode: "task",
    report_path: join(h.dir, "child-wake-cw1.md"),
  });
  await writeFile(join(h.dir, "child-wake-cw1.md"), "child wake report");
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  await h.call("report_outcome", { outcome: "completed", summary: "declared too early" });
  await h.call("task_outcomes_consumer", { action: "child", job_id: "child-wake", child_job_id: "new-child" });
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "child-wake", child_job_id: "new-child", status: "completed", summary: "child done",
  });
  await h.emit("turn_end", { turnIndex: 0, message: { role: "assistant", content: [] } });
  await h.emit("agent_end", { messages: [{ role: "assistant", content: [] }] });
  await h.emit("agent_settled");
  assert.equal((await h.snapshot()).active.declaration, undefined);
  assert.equal(h.messages.filter(message => /task-outcomes/.test(message.text)).length, 1);
});

test("replayed work_ready is an intentional deduplicated wake, not a second delivery", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "wake", attempt_id: "w1", mode: "dialogue",
  });
  const contractEntry = h.sm.getEntries().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "contract");
  assert.ok(contractEntry);
  const data = contractEntry.data as any;
  h.sm.appendCustomEntry("task-outcome/v1", {
    version: 1,
    eventId: randomUUID(),
    branchId: data.branchId,
    kind: "work_ready",
    at: new Date().toISOString(),
    jobId: "wake",
    attemptId: "w1",
    summary: "previous wake was durably recorded",
    workReadySequence: 0,
    notified: true,
  });
  await h.emit("session_tree");
  await h.call("task_outcomes_consumer", { action: "background", batch_id: "unrelated", command: "true" });
  await until(() => h.messages.length > 0);
  await delay(50);
  assert.equal(h.messages.filter(message => /task-outcomes/.test(message.text)).length, 0);
});

test("activation recovers a post-mutation marker without a missing helper", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const append = h.runtime.appendEntry;
  let fail = true;
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (fail && data?.kind === "contract") {
      fail = false;
      throw new Error("activation append failed after mutation");
    }
  };
  const result = await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "activation-retry", attempt_id: "a1", mode: "dialogue",
  });
  assert.equal(result.details.jobId, "activation-retry");
  assert.equal((await h.snapshot()).active.state, "active");
});

test("an append failure before mutation leaves child membership retryable", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "before-mutation", attempt_id: "b1", mode: "dialogue",
  });
  const append = h.runtime.appendEntry;
  h.runtime.appendEntry = () => { throw new Error("append failed before mutation"); };
  await assert.rejects(
    h.call("task_outcomes_consumer", { action: "child", job_id: "before-mutation", child_job_id: "child-a" }),
    /before mutation/,
  );
  assert.deepEqual((await h.snapshot()).active.childJobIds, []);
  h.runtime.appendEntry = append;
  await h.call("task_outcomes_consumer", { action: "child", job_id: "before-mutation", child_job_id: "child-a" });
  assert.deepEqual((await h.snapshot()).active.childJobIds, ["child-a"]);
});

test("stable operation IDs reject changed declaration, membership, and child payloads", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "payload", attempt_id: "p1", mode: "dialogue",
  });
  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  const append = h.runtime.appendEntry;
  let failKind = "declaration";
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (data?.kind === failKind) {
      failKind = "never";
      throw new Error(`${data.kind} append failed after mutation`);
    }
  };
  await assert.rejects(
    h.call("report_outcome", { outcome: "failed", summary: "durable declaration" }),
    /after mutation/,
  );
  h.runtime.appendEntry = append;
  await assert.rejects(
    h.call("report_outcome", { outcome: "blocked", summary: "different declaration" }),
    /different payload/,
  );
  await h.call("report_outcome", { outcome: "failed", summary: "durable declaration" });

  let failMembership = true;
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (failMembership && data?.kind === "contract" && data.contract?.childJobIds?.includes("child-a")) {
      failMembership = false;
      throw new Error("membership append failed after mutation");
    }
  };
  await assert.rejects(
    h.call("task_outcomes_consumer", { action: "child", job_id: "payload", child_job_id: "child-a" }),
    /after mutation/,
  );
  h.runtime.appendEntry = append;
  await assert.rejects(
    h.call("task_outcomes_consumer", { action: "child", job_id: "payload", child_job_id: "child-b" }),
    /different payload/,
  );
  await h.call("task_outcomes_consumer", { action: "child", job_id: "payload", child_job_id: "child-a" });

  let failChild = true;
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (failChild && data?.kind === "child_outcome") {
      failChild = false;
      throw new Error("child append failed after mutation");
    }
  };
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "child_outcome", job_id: "payload", child_job_id: "child-a", status: "completed", summary: "durable child",
    }),
    /after mutation/,
  );
  h.runtime.appendEntry = append;
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "child_outcome", job_id: "payload", child_job_id: "child-a", status: "blocked", summary: "different child",
    }),
    /different payload/,
  );
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "payload", child_job_id: "child-a", status: "completed", summary: "durable child",
  });
  const live = await h.snapshot();
  assert.equal(live.active.declaration.summary, "durable declaration");
  assert.deepEqual(live.active.childJobIds, ["child-a"]);

  await h.emit("session_tree");
  const replayed = await h.snapshot();
  assert.equal(replayed.active.declaration.summary, "durable declaration");
  assert.deepEqual(replayed.active.childJobIds, ["child-a"]);
});

test("real session-file append failure is retried only after disk recovery", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "persist first", timestamp: Date.now() } as any);
  h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  const sessionFile = h.sm.getSessionFile();
  assert.ok(sessionFile);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "disk-retry", attempt_id: "d1", mode: "dialogue",
  });
  await chmod(sessionFile, 0o444);
  await assert.rejects(h.settle({ text: "old final", saveAssistant: false }), /EACCES|permission denied/);
  const failedDisk = await readFile(sessionFile, "utf8");
  assert.doesNotMatch(failedDisk, /dialogue_settled/);
  assert.match(await readFile(`${sessionFile}.task-outcomes.jsonl`, "utf8"), /dialogue_settled/);

  await chmod(sessionFile, 0o644);
  await h.settle({ text: "old final" });
  assert.match(await readFile(sessionFile, "utf8"), /dialogue_settled/);
  const restarted = await harness(t, SessionManager.open(sessionFile));
  assert.equal((await restarted.snapshot()).outcomes.at(-1).outcome, "dialogue_settled");
  assert.equal((await restarted.snapshot()).outcomes.at(-1).summary, "old final");
});

test("a durable but unattempted work_ready wake is retried after replay", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "wake-retry", attempt_id: "w1", mode: "dialogue", children: ["child"],
  });
  const append = h.runtime.appendEntry;
  let fail = true;
  h.runtime.appendEntry = (type: string, data: any) => {
    append(type, data);
    if (fail && data?.kind === "work_ready") {
      fail = false;
      throw new Error("work_ready append failed after mutation");
    }
  };
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "wake-retry", child_job_id: "child", status: "completed", summary: "child done",
  });
  assert.equal(h.messages.filter(message => /task-outcomes/.test(message.text)).length, 0);
  h.runtime.appendEntry = append;
  await h.emit("session_tree");
  await h.call("task_outcomes_consumer", { action: "background", batch_id: "wake-unrelated", command: "true" });
  await until(() => h.messages.filter(message => /task-outcomes/.test(message.text)).length === 1);
});

test("persistent settlement before assistant materialization stays provisional", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  const sessionFile = h.sm.getSessionFile();
  assert.ok(sessionFile);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "lazy", attempt_id: "a1", mode: "dialogue",
  });
  await h.settle({ text: "not actually saved", saveAssistant: false });
  assert.equal((await h.snapshot()).outcomes.length, 0);
  await assert.rejects(readFile(sessionFile), /ENOENT|no such file/);
});

test("dialogue settlement after an assistant is saved survives reload", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  const sessionFile = h.sm.getSessionFile();
  assert.ok(sessionFile);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "saved-dialogue", attempt_id: "a1", mode: "dialogue",
  });
  await h.settle({ text: "saved dialogue" });
  assert.match(await readFile(sessionFile, "utf8"), /saved dialogue/);
  const restarted = await harness(t, SessionManager.open(sessionFile));
  const outcome = (await restarted.snapshot()).outcomes.at(-1);
  assert.equal(outcome.outcome, "dialogue_settled");
  assert.match(outcome.summary, /saved dialogue/);
});

test("activation retry reuses its reserved timestamp but rejects changed input", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  const sessionFile = h.sm.getSessionFile();
  assert.ok(sessionFile);
  const original = h.runtime.appendEntry;
  h.runtime.appendEntry = () => { throw new Error("activation failed before mutation"); };
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "retry-activation", attempt_id: "a1", mode: "dialogue",
    }),
    /before mutation/,
  );
  const sidecar = `${sessionFile}.task-outcomes.jsonl`;
  const first = JSON.parse((await readFile(sidecar, "utf8")).trim());
  h.runtime.appendEntry = original;
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "retry-activation", attempt_id: "a1", mode: "task",
      report_path: join(h.dir, "changed.md"),
    }),
    /different payload/,
  );
  const result = await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "retry-activation", attempt_id: "a1", mode: "dialogue",
  });
  assert.equal(result.details.jobId, "retry-activation");
  const entries = (await readFile(sidecar, "utf8")).trim().split("\\n").map(line => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].contract.activatedAt, first.contract.activatedAt);
});

test("failed append reload restores the selected branch before retry", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as any);
  h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  const sessionFile = h.sm.getSessionFile();
  assert.ok(sessionFile);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "branch-retry", attempt_id: "a1", mode: "dialogue",
  });
  const contractEntry = h.sm.getEntries().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "contract");
  assert.ok(contractEntry);
  h.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "abandoned" }], stopReason: "stop" } as any);
  h.sm.branch(contractEntry.id);
  await h.emit("session_tree");

  await h.emit("agent_start");
  await h.emit("turn_start", { turnIndex: 0 });
  const assistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "selected" }] };
  await h.emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
  h.sm.appendMessage(assistant as any);
  const intendedLeaf = h.sm.getLeafId();
  const original = h.runtime.appendEntry;
  h.runtime.appendEntry = (type: string, data: any) => {
    original(type, data);
    if (data?.kind === "outcome") throw new Error("final append failed after mutation");
  };
  await chmod(sessionFile, 0o444);
  await assert.rejects(
    h.emit("agent_end", { messages: [assistant] }).then(() => h.emit("agent_settled")),
    /final append failed after mutation|EACCES|permission denied/,
  );
  await chmod(sessionFile, 0o644);
  h.runtime.appendEntry = original;
  await h.emit("agent_settled");

  const outcome = h.sm.getEntries().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "outcome");
  assert.ok(outcome);
  assert.equal(outcome.parentId, intendedLeaf);
  assert.equal(h.sm.getLeafId(), outcome.id);
});

test("finality rejects a work-ready admission that is still preflighted", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  let releaseAdmission!: () => void;
  let admissionStarted = false;
  h.runtime.sendUserMessage = async (_text: string, options: any) => {
    admissionStarted = true;
    await new Promise<void>(resolve => { releaseAdmission = resolve; });
    if (options.admissionGuard?.() === false) {
      return { status: "rejected", reason: "finality", error: "attempt is final" };
    }
    return { status: "admitted", delivery: "steer" };
  };
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "finality-fence", attempt_id: "a1", mode: "dialogue", children: ["child"],
  });
  h.manager.recordChildOutcome("finality-fence", "child", "completed", "child done");
  await until(() => admissionStarted);
  await h.settle({ stopReason: "stop", text: "dialogue is final" });
  releaseAdmission();
  await delay(0);
  const snapshot = await h.snapshot();
  assert.equal(snapshot.active, undefined);
  assert.ok(snapshot.outcomes.some((item: any) => item.attemptId === "a1" && item.final));
  assert.equal(h.persisted.filter(entry => entry.data?.kind === "work_ready" && entry.data.notified === true).length, 0);
});

test("rejected work-ready notification remains retryable without duplicate sends", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as any);
  h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "wake-retry", attempt_id: "a1", mode: "dialogue", children: ["child"],
  });
  h.runtime.sendUserMessage = () => { throw new Error("notifier unavailable"); };
  await h.call("task_outcomes_consumer", {
    action: "child_outcome", job_id: "wake-retry", child_job_id: "child", status: "completed", summary: "child done",
  });
  await delay(30);
  assert.equal(h.messages.length, 0);
  assert.equal(h.persisted.filter(entry => entry.data?.kind === "work_ready" && entry.data.notified === true).length, 0);

  h.runtime.sendUserMessage = (text: string, options: any) => {
    h.messages.push({ text, options });
    return Promise.resolve();
  };
  await h.emit("session_tree");
  await until(() => h.messages.filter(message => /task-outcomes/.test(message.text)).length === 1);
  assert.equal(h.messages[0].text, "SYSTEM (task-outcomes): No background or child jobs remain running for this attempt.");
  assert.equal(h.persisted.filter(entry => entry.data?.kind === "work_ready" && entry.data.notified === false).length, 1);
  assert.equal(h.persisted.filter(entry => entry.data?.kind === "work_ready" && entry.data.notified === true).length, 1);
});

test("rejected needs-input notification replays the question", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as any);
  h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "question-retry", attempt_id: "a1", mode: "dialogue",
  });
  h.runtime.sendUserMessage = () => { throw new Error("question notifier unavailable"); };
  await h.call("report_outcome", { outcome: "needs_input", summary: "choose a continuation" });
  const outcome = h.sm.getBranch().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "outcome");
  assert.equal((outcome?.data as any).notified, false);
  assert.equal((await h.snapshot()).active.state, "awaiting_input");

  h.runtime.sendUserMessage = (text: string, options: any) => {
    h.messages.push({ text, options });
    return Promise.resolve();
  };
  await h.emit("session_tree");
  await until(() => h.messages.filter(message => /choose a continuation/.test(message.text)).length === 1);
  assert.equal(h.persisted.filter(entry => entry.data?.kind === "outcome" && entry.data.notified === true).length, 1);
});

test("replacement owners do not replay another owner's pending question", { timeout: 10000 }, async t => {
  const h = await harness(t);
  const oldOwnerSessionId = h.sm.getSessionId();
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "replacement-question", attempt_id: "a1", mode: "dialogue",
  });
  h.runtime.sendUserMessage = () => { throw new Error("question notifier unavailable"); };
  await h.call("report_outcome", { outcome: "needs_input", summary: "old owner's question" });
  await delay(20);

  const replacementSm = SessionManager.inMemory(h.dir, { id: "replacement-owner" }, h.sm.getEntries());
  const replacement = await harness(t, replacementSm);
  await delay(20);

  assert.equal(replacement.messages.length, 0);
  assert.equal(replacement.sm.getEntries().filter(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" &&
    (entry.data as any).kind === "outcome" && (entry.data as any).notified === true,
  ).length, 0);
  const snapshot = await replacement.snapshot();
  assert.equal(snapshot.active, undefined);
  const restored = snapshot.contracts.find((item: any) => item.jobId === "replacement-question");
  assert.equal(restored.ownerSessionId, oldOwnerSessionId);
  assert.equal(restored.state, "awaiting_input");
  assert.ok(snapshot.outcomes.some((item: any) => item.attemptId === "a1" && item.outcome === "needs_input"));
});

test("in-memory activation reserves identity without activating or leaking batch membership", { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.call("task_outcomes_consumer", { action: "batch_open", batch_id: "memory-batch" });
  const original = h.runtime.appendEntry;
  let first: any;
  h.runtime.appendEntry = (_type: string, data: any) => {
    first = data;
    throw new Error("activation failed before mutation");
  };
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "memory-retry", attempt_id: "a1", mode: "dialogue", batch_id: "memory-batch",
    }),
    /before mutation/,
  );
  assert.equal((await h.snapshot()).active, undefined);
  assert.equal((await h.snapshot()).contracts.length, 0);
  assert.equal((await h.call("task_outcomes_consumer", { action: "batch_stats", batch_id: "memory-batch" })).details.members, 0);

  h.runtime.appendEntry = original;
  await assert.rejects(
    h.call("task_outcomes_consumer", {
      action: "activate", job_id: "memory-retry", attempt_id: "a1", mode: "task",
      report_path: join(h.dir, "changed.md"), batch_id: "memory-batch",
    }),
    /different payload/,
  );
  const result = await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "memory-retry", attempt_id: "a1", mode: "dialogue", batch_id: "memory-batch",
  });
  assert.equal(result.details.jobId, "memory-retry");
  assert.equal(result.details.state, "active");
  assert.equal(first.contract.activatedAt, h.sm.getBranch().find(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" && (entry.data as any).kind === "contract",
  )?.data.contract.activatedAt);
  assert.equal((await h.call("task_outcomes_consumer", { action: "batch_stats", batch_id: "memory-batch" })).details.members, 1);
});

test("pending question notification is deduplicated across replay and cannot mark a new branch", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as any);
  const seedLeaf = h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "question-flight", attempt_id: "a1", mode: "dialogue",
  });
  let calls = 0;
  let resolvePending!: () => void;
  const pending = new Promise<void>(resolve => { resolvePending = resolve; });
  h.manager.runtime.sendUserMessage = () => { calls++; return pending; };
  await h.manager.declare("needs_input", "first question");
  h.manager.onSessionTree();
  h.manager.onSessionTree();
  assert.equal(calls, 1);

  h.manager.activateContract({ jobId: "question-flight", attemptId: "a2", mode: "dialogue" });
  await h.manager.declare("needs_input", "second question");
  assert.equal(calls, 2);

  h.sm.branch(seedLeaf);
  h.manager.onSessionTree();
  resolvePending();
  await delay(0);
  await delay(0);
  const accepted = h.sm.getEntries().filter(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" &&
    (entry.data as any).kind === "outcome" && (entry.data as any).notified === true,
  );
  assert.equal(accepted.length, 0);
  assert.equal((await h.snapshot()).active, undefined);
});

test("pending work-ready notification is deduplicated across replay and cannot mark a new branch", { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, true);
  h.sm.appendMessage({ role: "user", content: "seed", timestamp: Date.now() } as any);
  const seedLeaf = h.sm.appendMessage({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as any);
  await h.call("task_outcomes_consumer", {
    action: "activate", job_id: "work-flight", attempt_id: "a1", mode: "dialogue", children: ["child"],
  });
  let calls = 0;
  let resolvePending!: () => void;
  const pending = new Promise<void>(resolve => { resolvePending = resolve; });
  h.manager.runtime.sendUserMessage = () => { calls++; return pending; };
  h.manager.recordChildOutcome("work-flight", "child", "completed", "child done");
  await delay(0);
  h.manager.onSessionTree();
  h.manager.onSessionTree();
  assert.equal(calls, 1);

  h.sm.branch(seedLeaf);
  h.manager.onSessionTree();
  resolvePending();
  await delay(0);
  await delay(0);
  const accepted = h.sm.getEntries().filter(entry =>
    entry.type === "custom" && entry.customType === "task-outcome/v1" &&
    (entry.data as any).kind === "work_ready" && (entry.data as any).notified === true,
  );
  assert.equal(accepted.length, 0);
  assert.equal((await h.snapshot()).active, undefined);
});

test("durable pause wins report-validation race; final-first rejects pause and duplicate settlement", async t => {
  const h = await harness(t, undefined, true);
  await h.settle({ text: "seed", stopReason: "stop" });
  await h.call("task_outcomes_consumer", contract(h.dir, "race", "attempt"));
  await writeFile(join(h.dir, "race-attempt.md"), "report");
  await h.call("report_outcome", { outcome: "completed", summary: "done" });
  let release!: () => void;
  const verification = new Promise<void>(resolve => { release = resolve; });
  const original = h.manager.verifyReport;
  h.manager.verifyReport = () => verification;
  const settling = h.manager.onAgentSettled(false);
  assert.equal(h.manager.pauseForContext("clean first", 100), true);
  const pause = h.manager.snapshot().active.contextPause;
  release(); await settling;
  assert.equal(h.manager.snapshot().active.state, "context_paused");
  assert.equal(h.manager.snapshot().outcomes.filter(o => o.final).length, 0);
  const path = `${h.sm.getSessionFile()}.task-monitor-attempt.json`;
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(receipt.state, "context_paused");
  assert.equal(receipt.payload.pause_id, pause.id);
  h.manager.verifyReport = original;
  h.manager.resumeAfterContextClean("race", "attempt", pause.id, 0);
  await h.call("report_outcome", { outcome: "completed", summary: "done" });
  await h.manager.onAgentSettled(false);
  const final = JSON.parse(await readFile(path, "utf8"));
  assert.equal(final.state, "final");
  assert.equal(h.manager.pauseForContext("too late", 100), false);
  await h.manager.onAgentSettled(false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, final.revision);
  assert.equal(h.manager.snapshot().outcomes.filter(o => o.final).length, 1);
});

test("every direct transition helper call has a declared method", async () => {
  const source = await readFile(managerSourcePath, "utf8");
  const called = new Set([...source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]));
  const declared = new Set([...source.matchAll(/^\s*(?:private|protected|public)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map(match => match[1]));
  for (const name of called) assert.ok(declared.has(name), `this.${name}() has no declared method`);
});
