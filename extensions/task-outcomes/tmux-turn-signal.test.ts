import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import activate from "../../extensions/tmux-turn-signal.ts";

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

const wait = () => new Promise(resolve => setTimeout(resolve, 10));

test("task outcomes get a separate tmux receipt without changing legacy settlement", async t => {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const options = new Map<string, string>();
  const signals: string[] = [];
  const pane = "%task-outcome-test";
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  const key = (name: string) => `${pane}|${name}`;
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event: string, listener: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener));
      },
      emit(event: string, data: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(data);
      },
    },
    async exec(_command: string, args: string[]) {
      if (args[0] === "show-options") return { stdout: `${options.get(key(args.at(-1)!)) ?? ""}\n`, code: 0 };
      if (args[0] === "set-option") {
        const nameIndex = args.findIndex(arg => arg.startsWith("@pi_"));
        const name = args[nameIndex];
        if (args.includes("-qu")) options.delete(key(name));
        else options.set(key(name), args[nameIndex + 1]);
        return { stdout: "", code: 0 };
      }
      if (args[0] === "wait-for") {
        signals.push(args.at(-1)!);
        return { stdout: "", code: 0 };
      }
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    },
    async execChecked(command: string, args: string[]) {
      const result = await pi.exec(command, args);
      return result.code !== 0 || result.killed
        ? { ok: false, error: { command, code: result.code, killed: result.killed ?? false, diagnostic: result.stderr } }
        : { ok: true, value: result };
    },
  };
  const sessionId = "session-task-outcome";
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/tmp/session.jsonl" } };
  options.set(key("@pi_start_channel"), "legacy-start");
  options.set(key("@pi_done_channel"), "legacy-done");
  activate(pi as never);
  t.after(() => { process.env.TMUX_PANE = oldPane; });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
  for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
  assert.equal(signals.length, 3);
  assert.equal(options.get(key("@pi_session_id")), sessionId);
  assert.ok(signals.includes("legacy-start"));
  assert.ok(signals.includes("legacy-done"));
  assert.ok(signals.some(signal => signal.includes("pi-settled")));

  pi.events.emit("task-outcome", {
    sessionId,
    sessionFile: "/tmp/session.jsonl",
    jobId: "job-1",
    attemptId: "attempt-1",
    mode: "task",
    outcome: "completed",
    source: "model",
    reportPath: "/tmp/report.md",
    final: true,
  });
  for (let i = 0; i < 100 && options.get(key("@pi_outcome_generation")) !== "1"; i++) await wait();
  const receipt = JSON.parse(options.get(key("@pi_outcome"))!);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "attempt_id", "final", "job_id", "mode", "outcome", "receipt_identity", "receipt_path", "session_id", "source",
  ]);
  assert.ok(options.get(key("@pi_outcome"))!.length < 16 * 1024);
  assert.deepEqual(JSON.parse(await readFile(receipt.receipt_path, "utf8")), {
    version: 1,
    session_id: sessionId,
    job_id: "job-1",
    attempt_id: "attempt-1",
    mode: "task",
    outcome: "completed",
    source: "model",
    final: true,
    report: "/tmp/report.md",
    session_file: "/tmp/session.jsonl",
    transport_report_present: false,
  });
  assert.equal(options.get(key("@pi_outcome_generation")), "1");
  assert.equal(signals.length, 4);
  assert.ok(signals[3].includes("pi-outcome"));

  pi.events.emit("task-outcome", { sessionId: "other", jobId: "wrong", attemptId: "wrong", outcome: "completed" });
  await wait();
  assert.equal(options.get(key("@pi_outcome_generation")), "1");
});

test("large dialogue reports use protected sidecars while tmux stays bounded", async t => {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const options = new Map<string, string>();
  const pane = "%large-dialogue-test";
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  const key = (name: string) => `${pane}|${name}`;
  let outcomeListener: ((data: unknown) => void) | undefined;
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event: string, listener: (data: unknown) => void) {
        if (event === "task-outcome") outcomeListener = listener;
        return () => {};
      },
      emit(event: string, data: unknown) {
        if (event === "task-outcome") void outcomeListener?.(data);
      },
    },
    async exec(_command: string, args: string[]) {
      if (args[0] === "show-options") return { stdout: `${options.get(key(args.at(-1)!)) ?? ""}\n`, code: 0 };
      if (args[0] === "set-option") {
        const nameIndex = args.findIndex(arg => arg.startsWith("@pi_"));
        options.set(key(args[nameIndex]), args[nameIndex + 1]);
        return { stdout: "", code: 0 };
      }
      if (args[0] === "wait-for") return { stdout: "", code: 0 };
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    },
    async execChecked(command: string, args: string[]) {
      const result = await pi.exec(command, args);
      return result.code !== 0 || result.killed
        ? { ok: false, error: { command, code: result.code, killed: result.killed ?? false, diagnostic: result.stderr } }
        : { ok: true, value: result };
    },
  };
  const sessionId = "large-dialogue-session";
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } };
  activate(pi as never);
  t.after(() => { process.env.TMUX_PANE = oldPane; });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  const exact = "😀".repeat(11_000) + "\nend  ";
  pi.events.emit("task-outcome", {
    sessionId,
    jobId: "large-dialogue-job",
    attemptId: "large-dialogue-attempt",
    mode: "dialogue",
    outcome: "dialogue_settled",
    source: "model",
    summary: "dialogue_settled",
    reportText: exact,
    final: true,
  });
  for (let i = 0; i < 100 && options.get(key("@pi_outcome_generation")) !== "1"; i++) await delay(10);
  const pointer = JSON.parse(options.get(key("@pi_outcome"))!);
  assert.ok(options.get(key("@pi_outcome"))!.length < 16 * 1024);
  const stored = JSON.parse(await readFile(pointer.receipt_path, "utf8"));
  assert.equal(stored.transport_report_present, true);
  assert.equal(await readFile(stored.transport_report_path, "utf8"), exact);
});

test("settlement waits for causal outcome publication and fails closed", { timeout: 10000 }, async t => {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const options = new Map<string, string>([
    ["@pi_start_channel", "start-1"],
    ["@pi_done_channel", "done-1"],
    ["@pi_settled_channel", "settled"],
    ["@pi_start_generation", "0"],
    ["@pi_settled_generation", "0"],
    ["@pi_outcome_channel", "outcome"],
    ["@pi_outcome_generation", "0"],
  ]);
  const signals: string[] = [];
  const errors: any[] = [];
  let releasePublication!: () => void;
  const publication = new Promise<void>(resolve => { releasePublication = resolve; });
  let delayPublication = true;
  let failPublication = false;
  const pane = "%publication-barrier";
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  t.after(() => {
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
  });
  const pi: any = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event: string, listener: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(data);
      },
    },
    async exec(_command: string, args: string[]) {
      const option = args.find(value => value.startsWith("@pi_"));
      if (args[0] === "show-options") return { stdout: `${options.get(option!) ?? ""}\n`, stderr: "", code: 0, killed: false };
      if (args[0] === "set-option") {
        if (failPublication && option === "@pi_outcome") return { stdout: "", stderr: "pane unavailable", code: 23, killed: false };
        if (args.includes("-qu")) options.delete(option!);
        else options.set(option!, args.at(-1)!);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "wait-for") {
        const channel = args.at(-1)!;
        signals.push(channel);
        if (delayPublication && channel === "outcome") await publication;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      throw new Error(`unexpected tmux call: ${args.join(" ")}`);
    },
    async execChecked(command: string, args: string[]) {
      const result = await pi.exec(command, args);
      return result.code === 0
        ? { ok: true, value: result }
        : { ok: false, error: { command, code: result.code, killed: result.killed, diagnostic: result.stderr } };
    },
    recordError(record: unknown) { errors.push(record); return "error-entry"; },
  };
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "publication-session", getSessionFile: () => undefined } };
  activate(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);

  const settled = handlers.get("agent_settled")?.[0];
  assert.ok(settled);
  pi.events.emit("task-outcome", {
    sessionId: "publication-session", jobId: "initial-job", attemptId: "initial-attempt",
    mode: "task", outcome: "needs_input", source: "model", final: false, summary: "continue",
  });
  const firstSettlement = settled({}, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options.get("@pi_outcome_generation"), "0");
  assert.equal(options.get("@pi_settled_generation"), "0");
  assert.ok(Number(options.get("@pi_start_generation")) > Number(options.get("@pi_settled_generation")));
  releasePublication();
  await firstSettlement;
  assert.equal(options.get("@pi_outcome_generation"), "1");
  assert.equal(options.get("@pi_settled_generation"), "1");
  const firstPointer = JSON.parse(options.get("@pi_outcome")!);
  const firstReceipt = JSON.parse(await readFile(firstPointer.receipt_path, "utf8"));
  assert.equal(firstReceipt.attempt_id, "initial-attempt");
  assert.ok(signals.includes("outcome"));

  options.set("@pi_start_channel", "start-2");
  delayPublication = false;
  for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
  pi.events.emit("task-outcome", {
    sessionId: "publication-session", jobId: "initial-job", attemptId: "followup-attempt",
    mode: "task", outcome: "needs_input", source: "model", final: false, summary: "continue again",
  });
  await (settled({}, ctx));
  assert.equal(options.get("@pi_outcome_generation"), "2");
  assert.equal(options.get("@pi_settled_generation"), "2");
  const secondPointer = JSON.parse(options.get("@pi_outcome")!);
  assert.notEqual(secondPointer.attempt_id, firstPointer.attempt_id);
  assert.equal(JSON.parse(await readFile(firstPointer.receipt_path, "utf8")).attempt_id, "initial-attempt");

  options.set("@pi_start_channel", "start-3");
  failPublication = true;
  for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
  pi.events.emit("task-outcome", {
    sessionId: "publication-session", jobId: "initial-job", attemptId: "failed-attempt",
    mode: "dialogue", outcome: "dialogue_settled", source: "model", final: true, reportText: "not published",
  });
  await settled({}, ctx);
  assert.equal(options.get("@pi_settled_generation"), "2");
  assert.equal(options.get("@pi_outcome_generation"), "2");
  assert.deepEqual(errors[0], {
    version: 1, source: "subagent", operation: "outcome_publication", message: "tmux exited 23: pane unavailable",
    correlation: { session_id: "publication-session", job_id: "initial-job", attempt_id: "failed-attempt" },
  });
});

test("restart transport loss waits for tmux owner initialization", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "task-outcome-tmux-restart-"));
  const stateDir = join(dir, "tmux-state");
  const binDir = join(dir, "bin");
  const tmux = join(binDir, "tmux");
  await mkdir(binDir);
  await writeFile(tmux, `#!/bin/sh
state_dir="$PI_FAKE_TMUX_STATE"
mkdir -p "$state_dir"
last=""
key=""
for arg in "$@"; do
  last="$arg"
  case "$arg" in @pi_*) key="$arg"; break ;; esac
done
file="$state_dir/$(printf '%s' "\${TMUX_PANE:-pane}|$key" | tr -c 'A-Za-z0-9._-' '_')"
case "$1" in
  show-options) test -f "$file" && cat "$file" ;;
  set-option)
    if [ "$2" = "-qu" ]; then rm -f "$file"; exit 0; fi
    value=""
    take=0
    for arg in "$@"; do
      if [ "$take" = 1 ]; then value="$arg"; break; fi
      [ "$arg" = "$key" ] && take=1
    done
    printf '%s' "$value" > "$file"
    ;;
  wait-for) printf '%s\\n' "$last" >> "$state_dir/signals" ;;
esac
`, "utf8");
  await chmod(tmux, 0o755);
  const oldPath = process.env.PATH;
  const oldPane = process.env.TMUX_PANE;
  const oldState = process.env.PI_FAKE_TMUX_STATE;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.TMUX_PANE = "%restart-outcome";
  process.env.PI_FAKE_TMUX_STATE = stateDir;
  t.after(async () => {
    process.env.PATH = oldPath;
    process.env.TMUX_PANE = oldPane;
    process.env.PI_FAKE_TMUX_STATE = oldState;
    await rm(dir, { recursive: true, force: true });
  });

  const { loadExtensions } = await import(pathToFileURL(join(homedir(),
    ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);
  const { SessionManager } = await import(pathToFileURL(join(homedir(),
    ".local/share/pi-mono/packages/coding-agent/dist/index.js")).href);
  const taskPath = fileURLToPath(new URL("../task-outcomes.ts", import.meta.url));
  const tmuxPath = fileURLToPath(new URL("../tmux-turn-signal.ts", import.meta.url));
  await mkdir(stateDir);
  const sm = SessionManager.create(dir);
  const event = {
    version: 1,
    eventId: randomUUID(),
    kind: "contract",
    at: new Date().toISOString(),
    branchId: "restart-branch",
    contract: {
      jobId: "restart-job",
      attemptId: "restart-attempt",
      mode: "task",
      reportPath: join(dir, "restart-report.md"),
      ownerSessionId: sm.getSessionId(),
      childJobIds: [],
    },
  };
  sm.appendCustomEntry("task-outcome/v1", event);
  sm.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as any);
  await writeFile(`${sm.getSessionFile()}.task-outcomes.jsonl`, `${JSON.stringify(event)}\\n`);

  const loaded = await loadExtensions([taskPath, tmuxPath], dir);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.appendEntry = (type: string, data: unknown) => { sm.appendCustomEntry(type, data); };
  loaded.runtime.sendUserMessage = () => {};
  const ctx: any = { cwd: dir, mode: "tui", sessionManager: sm, hasPendingMessages: () => false };
  for (const extension of loaded.extensions) {
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  }
  await delay(100);
  const files = await readdir(stateDir);
  const values = await Promise.all(files.filter(file => file !== "signals").map(file => readFile(join(stateDir, file), "utf8")));
  assert.ok(values.some(value => value.includes("transport_lost")));
  assert.match(await readFile(join(stateDir, "signals"), "utf8"), /pi-outcome/);
});
