import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type * as Cleaner from "./index.ts";

// Use the installed host's module aliases, as normal extension loading does.
const host = join(homedir(), ".local/share/pi-mono/packages/coding-agent/dist/index.js");
const require = createRequire(host);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": host,
  "@mariozechner/pi-coding-agent": host,
} });
const { default: registerCleaner, cleanRows, cleanSessionFile }: typeof Cleaner = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));

type Row = Parameters<typeof cleanRows>[0][number];
const tool = (id: string, parentId: string | null, text: string, name = "bash"): Row => ({
  type: "message", id, parentId,
  message: { role: "toolResult", toolCallId: id, toolName: name,
    content: [{ type: "text", text }], details: { preserved: true } },
});
const assistant = (id: string, parentId: string): Row => ({
  type: "message", id, parentId,
  message: { role: "assistant", content: [{ type: "thinking", thinking: "keep", thinkingSignature: "signed" }],
    stopReason: "stop", usage: { totalTokens: 99999 } },
});
const rows = (): Row[] => [
  { type: "session", version: 3, id: "session", cwd: tmpdir() },
  tool("root", null, "shared output".repeat(100)),
  tool("selected", "root", "selected output".repeat(200)),
  assistant("selected-assistant", "selected"),
  tool("keep", "selected-assistant", "ideation", "sifttext_get_node"),
  { type: "custom", id: "marker", parentId: "keep", customType: "task-outcome", data: { maintenanceId: "same" } },
  tool("other", "root", "other output".repeat(1000)),
  assistant("other-assistant", "other"),
];

function saved(t: test.TestContext, input = rows()) {
  const dir = mkdtempSync(join(tmpdir(), "pi-selected-clean-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, input.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { dir, file };
}

test("cleanup targets the selected branch, not the last physical row, and is repeatable", t => {
  const original = rows();
  const { file, dir } = saved(t, original);
  const result = cleanSessionFile(file, "marker");
  assert.equal(result.changed, true);
  assert.ok(result.beforeTokens > result.afterTokens);
  const cleaned = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const index of [0, 4, 5, 6, 7]) assert.deepEqual(cleaned[index], original[index]);
  for (const index of [1, 2]) {
    assert.match(cleaned[index].message.content[0].text, /tool result cleared/);
    assert.deepEqual(cleaned[index].message.details, original[index].message.details);
  }
  assert.deepEqual(cleaned[3].message.content, original[3].message.content);
  assert.notEqual(cleaned[3].message.usage.totalTokens, 99999);
  const firstClean = readFileSync(file, "utf8");
  assert.equal(cleanSessionFile(file, "marker").changed, false);
  assert.equal(readFileSync(file, "utf8"), firstClean);
  assert.equal(readdirSync(dir).filter(name => name.endsWith(".bak")).length, 1);
});

test("an explicitly empty branch stays empty and performs no rewrite", t => {
  const { file, dir } = saved(t);
  const before = readFileSync(file, "utf8");
  const result = cleanSessionFile(file, null);
  assert.deepEqual([result.changed, result.beforeTokens, result.afterTokens], [false, 0, 0]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});

test("missing, cyclic, duplicate and broken branches reject without writes", t => {
  const inputs = [
    { input: rows(), leaf: "missing" },
    { input: [...rows(), tool("cycle", "cycle", "cycle")], leaf: "cycle" },
    { input: [...rows(), tool("orphan", "missing", "orphan")], leaf: "orphan" },
    { input: [...rows(), tool("selected", "root", "duplicate")], leaf: "selected" },
  ];
  for (const { input, leaf } of inputs) {
    const { file, dir } = saved(t, input);
    const before = readFileSync(file, "utf8");
    assert.throws(() => cleanSessionFile(file, leaf), /no cleanup performed/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  }
});

test("cleanup preflight checks feasibility without rewriting or creating a backup", t => {
  const { file, dir } = saved(t);
  const before = readFileSync(file, "utf8");
  const preview = cleanSessionFile(file, "marker", Infinity, true);
  assert.equal(preview.changed, true);
  assert.ok(preview.afterTokens < preview.beforeTokens);
  assert.throws(() => cleanSessionFile(file, "marker", 1, true), /cannot free enough context/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  assert.deepEqual(cleanSessionFile(file, "marker"), preview);
});

test("insufficient context reduction leaves the file and backups untouched", t => {
  const { file, dir } = saved(t);
  const before = readFileSync(file, "utf8");
  assert.throws(() => cleanSessionFile(file, "marker", 1), /cannot free enough context/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
});

// Command error routing: maintenance keeps the current owner authoritative.
test("manual clean routes refresh failures through the live owner", async t => {
  for (const phase of ["prepare", "create", "cancelled", "callback", "success"] as const) {
    const { file } = saved(t);
    let invalidated = false;
    let oldFailures = 0;
    let newFailures = 0;
    const notices: string[] = [];
    const diagnostics: string[] = [];
    const log = t.mock.method(console, "error", (message: string) => diagnostics.push(message));
    const assertLive = () => assert.equal(invalidated, false, "outgoing handle used after replacement");
    const owner = {
      getSessionId: () => { assertLive(); return "session"; },
      getSessionFile: () => { assertLive(); return file; },
      getLeafId: () => { assertLive(); return "marker"; },
    };
    const replacementOwner = {};
    const registry = (globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")];
    registry.set(owner, {
      attach() { assertLive(); },
      beginMaintenance() {
        if (phase === "prepare") throw new Error("marker persistence failed");
        return { maintenanceId: "lease", ownerEpoch: "epoch", sessionId: "session", phase: "pending" };
      },
      failMaintenance() { assertLive(); oldFailures++; },
      resumeMaintenance() { assertLive(); },
    });
    registry.set(replacementOwner, { failMaintenance() { newFailures++; } });
    let handler: (args: string, ctx: any) => Promise<void> = async () => { throw new Error("command missing"); };
    registerCleaner({ on() {}, registerCommand(_name: string, command: any) { handler = command.handler; } } as any);
    const ctx = {
      sessionManager: owner,
      isIdle: () => true,
      get ui() {
        assertLive();
        return { notify(message: string) { assertLive(); notices.push(message); } };
      },
      async switchSession(_path: string, options: any) {
        if (phase === "create") throw new Error("create failed before callback");
        if (phase === "cancelled") return { cancelled: true };
        await options.withSession({
          sessionManager: replacementOwner,
          ui: {
            setStatus() { if (phase === "callback") throw new Error("replacement UI failed"); },
            notify(message: string) { notices.push(message); },
          },
          sendUserMessage() { assert.fail("manual clean must not auto-continue"); },
        });
        return { cancelled: false };
      },
    };
    try {
      await handler("", ctx);
      assert.equal(oldFailures, ["create", "cancelled", "callback"].includes(phase) ? 1 : 0);
      assert.equal(newFailures, 0);
      assert.equal(diagnostics.length, 0);
      assert.equal(notices.length, 1);
      if (phase === "prepare") assert.equal(invalidated, false);
    } finally {
      registry.delete(owner);
      registry.delete(replacementOwner);
      log.mock.restore();
    }
  }
});

test("context recovery acknowledges errors using the same live maintenance manager", async t => {
  const request = { nonce: "nonce", status: "pending", jobId: "job", attemptId: "attempt", sessionId: "session", pauseId: "pause" };
  const { dir, file } = saved(t);
  const ackFile = join(dir, "acknowledgments.jsonl");
  // A local executable double: no real tmux pane or provider is contacted.
  writeFileSync(join(dir, "tmux"), `#!/bin/sh
for last do :; done
if [ "$1" = "set-option" ]; then
  printf '%s\\n' "$last" >> '${ackFile}'
elif [ "$last" = "@pi_subagent_session_id" ]; then
  printf 'session\\n'
else
  printf '%s\\n' '${JSON.stringify(request)}'
fi
`, { mode: 0o755 });
  const { registerContextRecovery } = await jiti.import(fileURLToPath(new URL("../subagent-launch/recovery.ts", import.meta.url)));
  const previousPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.TMUX_PANE = "%999999";
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousPane;
  });
  for (const phase of ["create", "cancelled", "callback"] as const) {
    let invalidated = false;
    let newFailures = 0;
    const owner = {
      getSessionFile: () => file,
      getLeafId: () => "marker",
      getSessionId: () => "session",
    };
    const replacementOwner = { getSessionId: () => "session" };
    const registry = (globalThis as any)[Symbol.for("pi.task-outcomes.manager-registry")];
    registry.set(owner, {
      // Non-empty pending work must not intercept the recovery handler: every
      // phase below still has to fail for its own reason, not the removed guard.
      snapshot: () => ({ active: { ...request, state: "context_paused", pendingWork: ["child:child"], contextPause: { id: "pause", limit: 100 } } }),
      beginMaintenance: () => ({ maintenanceId: "lease", ownerEpoch: "epoch", sessionId: "session", phase: "pending" }),
      failMaintenance() { assert.equal(invalidated, false, "outgoing failure owner used"); },
      resumeMaintenance() { assert.equal(invalidated, false, "outgoing resume owner used"); },
    });
    registry.set(replacementOwner, { failMaintenance() { newFailures++; } });
    let handler: (args: string, ctx: any) => Promise<void> = async () => { throw new Error("command missing"); };
    registerContextRecovery({ on() {}, registerCommand(_name: string, command: any) { handler = command.handler; } });
    try {
      await handler("nonce", {
        sessionManager: owner,
        isIdle: () => true,
        waitForIdle: async () => {},
        hasPendingMessages: () => false,
        model: { id: "model" },
        async switchSession(_path: string, options: any) {
          if (phase === "create") throw new Error("create failed before callback");
          if (phase === "cancelled") return { cancelled: true };
          await options.withSession({ sessionManager: replacementOwner, model: { id: "different-model" } });
          assert.fail("replacement model mismatch must reject");
        },
      });
      assert.equal(newFailures, 0);
      const acknowledgments = readFileSync(ackFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(acknowledgments.at(-1)?.status, "error");
      assert.match(acknowledgments.at(-1)?.error, phase === "create" ? /create failed/ : phase === "cancelled" ? /reload cancelled/ : /model changed/);
    } finally {
      registry.delete(owner);
      registry.delete(replacementOwner);
    }
  }
  assert.equal(readFileSync(ackFile, "utf8").trim().split("\n").length, 3);
});

test("enabled leaf command retries a historical failure and refreshes the same manager without a final", async t => {
  const { SessionManager } = await import(host);
  const task = await jiti.import(fileURLToPath(new URL("../task-outcomes/manager.ts", import.meta.url)));
  const { file } = saved(t);
  let sm = SessionManager.open(file);
  sm.branch("marker");
  const notices: string[] = [];
  let handler: any;
  const pi: any = {
    on() {}, events: { emit() {} }, sendUserMessage() { assert.fail("manual maintenance must not continue the model"); },
    appendEntry(type: string, data: unknown) { sm.appendCustomEntry(type, data); },
    registerCommand(_name: string, command: any) { handler = command.handler; },
  };
  const ctx: any = {
    sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify(text: string) { notices.push(text); }, setStatus() {} },
    async switchSession(_file: string, options: any) {
      const lease = options.maintenance.token;
      assert.equal(sm.getLeafEntry().data.kind, "maintenance_begin");
      const prepared = options.maintenance.beforeReplace();
      assert.equal(prepared.replace, true);
      const manager = task.existingTaskOutcomeManager(ctx);
      sm.setSessionFile(file);
      sm.branch(sm.getLeafId());
      assert.equal(task.existingTaskOutcomeManager(ctx), manager);
      await options.withSession(ctx);
      assert.equal(manager.snapshot().maintenance, undefined);
      assert.equal(manager.snapshot().active.state, "active");
      assert.deepEqual(manager.snapshot().outcomes, []);
      sm.appendCustomEntry("usable-after-maintenance", {});
      return { cancelled: false };
    },
  };
  registerCleaner(pi);
  task.getTaskOutcomeManager(pi, ctx).activateContract({
    jobId: "leaf", attemptId: "attempt", mode: "task", reportPath: join(file, "..", "report.md"),
  });
  const outgoing = task.getTaskOutcomeManager(pi, ctx);
  const failed = outgoing.beginMaintenance(file);
  outgoing.failMaintenance(failed, new Error("historical adoption failure"));
  sm = SessionManager.open(file);
  ctx.sessionManager = sm;
  task.getTaskOutcomeManager(pi, ctx).restore();
  await handler("", ctx);
  assert.equal(sm.getBranch().filter((entry: any) => entry.data?.kind === "maintenance_error").length, 1);
  assert.equal(notices.length, 1);
  assert.equal(sm.getLeafEntry().customType, "usable-after-maintenance");
  assert.match(readFileSync(file, "utf8"), /tool result cleared/);
});
