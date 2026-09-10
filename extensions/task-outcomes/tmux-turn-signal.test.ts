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
  await wait();
  const receipt = JSON.parse(options.get(key("@pi_outcome"))!);
  assert.deepEqual(receipt, {
    session_id: sessionId,
    job_id: "job-1",
    attempt_id: "attempt-1",
    mode: "task",
    outcome: "completed",
    source: "model",
    final: true,
    report: "/tmp/report.md",
    session_file: "/tmp/session.jsonl",
  });
  assert.equal(options.get(key("@pi_outcome_generation")), "1");
  assert.equal(signals.length, 4);
  assert.ok(signals[3].includes("pi-outcome"));

  pi.events.emit("task-outcome", { sessionId: "other", jobId: "wrong", attemptId: "wrong", outcome: "completed" });
  await wait();
  assert.equal(options.get(key("@pi_outcome_generation")), "1");
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
