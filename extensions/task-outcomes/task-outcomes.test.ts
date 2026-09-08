import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const { loadExtensions } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);
const { SessionManager } = await import(pathToFileURL(join(homedir(),
  ".local/share/pi-mono/packages/coding-agent/dist/index.js")).href);
const backgroundPath = fileURLToPath(new URL("../background-jobs.ts", import.meta.url));
const taskPath = fileURLToPath(new URL("../task-outcomes.ts", import.meta.url));
const consumerPath = fileURLToPath(new URL("./consumer-test-extension.ts", import.meta.url));

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for task outcome state");
}

async function harness(t: any, sessionManager?: any) {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-test-"));
  const { extensions, errors, runtime } = await loadExtensions(
    [backgroundPath, taskPath, consumerPath],
    dir,
  );
  assert.deepEqual(errors, []);
  const sm = sessionManager ?? SessionManager.inMemory(dir);
  const messages: Array<{ text: string; options: any }> = [];
  const persisted: any[] = [];
  runtime.sendUserMessage = (text: string, options: any) => messages.push({ text, options });
  runtime.appendEntry = (type: string, data: unknown) => {
    persisted.push({ type, data });
    sm.appendCustomEntry(type, data);
  };
  const ctx: any = { cwd: dir, sessionManager: sm, hasPendingMessages: () => false };
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
  const settle = async (options: { outcome?: string; summary?: string; stopReason?: string; text?: string } = {}) => {
    await emit("agent_start");
    await emit("turn_start", { turnIndex: 0 });
    if (options.outcome) {
      await call("report_outcome", { outcome: options.outcome, summary: options.summary ?? options.outcome });
    }
    const assistant = {
      role: "assistant",
      stopReason: options.stopReason ?? "toolUse",
      content: options.text ? [{ type: "text", text: options.text }] : [],
    };
    await emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
    await emit("agent_end", { messages: [assistant] });
    await emit("agent_settled");
  };
  await emit("session_start", { reason: "startup" });
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await delay(50);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, sm, call, emit, settle, snapshot, messages, persisted };
}

const contract = (dir: string, jobId: string, attemptId: string, batchId = "batch") => ({
  action: "activate",
  job_id: jobId,
  attempt_id: attemptId,
  mode: "task",
  report_path: join(dir, `${jobId}-${attemptId}.md`),
  batch_id: batchId,
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
  assert.match(h.messages[0].text, /work finished/);
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
