import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import activate from "../tmux-turn-signal.ts";

const monitorPath = fileURLToPath(new URL("../subagent-launch/monitor.mjs", import.meta.url));
const pane = "%123";

const success = (stdout = "") => ({ ok: true as const, value: { stdout, stderr: "", code: 0, killed: false } });
const failure = () => ({
  ok: false as const,
  error: { command: "tmux", code: 23, killed: false, diagnostic: "tmux: pane unavailable" },
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("timed out");
}

test("publication failure is recorded and observed without a completion signal", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-error-delivery-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  const fakeTmux = join(binDir, "tmux");
  const sessionFile = join(dir, "session.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const reportPath = join(dir, "report.md");
  const jobId = "error-job";
  const attemptId = "fresh-attempt";
  const sessionId = "error-session";
  const oldPane = process.env.TMUX_PANE;
  const oldManifest = process.env.PI_SUBAGENT_MANIFEST;
  await mkdir(binDir);
  await mkdir(stateDir);
  const key = (option: string) => join(stateDir, option.replace(/[^A-Za-z0-9._-]/g, "_"));
  const setOption = async (option: string, value: string) => writeFile(key(option), value);
  await writeFile(fakeTmux, `#!/bin/sh
state_dir="$FAKE_TMUX_STATE"
file_for() { printf '%s/%s' "$state_dir" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"; }
case "$1" in
  show-options)
    file="$(file_for "$5")"
    if [ -f "$file" ]; then cat "$file"; else exit 1; fi
    ;;
  list-panes) printf '%s\\t0\\n' '${pane}' ;;
  wait-for) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await chmod(fakeTmux, 0o755);
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType: "pi-error/v1", data: {
    version: 1, source: "subagent", operation: "outcome_publication", message: "stale attempt",
    correlation: { session_id: sessionId, job_id: jobId, attempt_id: "old-attempt" },
  } })}\n`);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType: "pi-error/v1", data: {
    version: 1, source: "subagent", operation: "outcome_publication", message: "foreign failure",
    correlation: { session_id: "foreign-session", job_id: jobId, attempt_id: attemptId },
  } })}\n`);
  await writeFile(reportPath, "saved task evidence\n");
  await writeFile(manifestPath, JSON.stringify({ version: 1, jobId, attemptId, sessionId, mode: "task",
    reportPath, startChannel: "fake-start", startGeneration: 0, outcomeGeneration: 0 }));
  await setOption("@pi_subagent_job_id", jobId);
  await setOption("@pi_subagent_manifest", manifestPath);
  await setOption("@pi_start_generation", "1");
  await setOption("@pi_session_file", sessionFile);
  await setOption("@pi_session_id", sessionId);
  await setOption("@pi_outcome_generation", "0");
  await setOption("@pi_outcome_channel", "fake-outcome");

  const oldPath = process.env.PATH;
  process.env.TMUX_PANE = pane;
  delete process.env.PI_SUBAGENT_MANIFEST;
  const monitorEnv = { ...process.env, PATH: `${binDir}:${oldPath ?? ""}`, FAKE_TMUX_STATE: stateDir };
  delete monitorEnv.TMUX_PANE;
  delete monitorEnv.PI_SUBAGENT_MANIFEST;
  const monitor = spawn(process.execPath, [monitorPath, JSON.stringify({
    paneId: pane,
    manifestOption: "@pi_subagent_manifest",
    outcomeOption: "@pi_outcome",
    outcomeGenerationOption: "@pi_outcome_generation",
    startGenerationOption: "@pi_start_generation",
    sessionFileOption: "@pi_session_file",
    sessionIdOption: "@pi_session_id",
    outcomeChannel: "fake-outcome",
    pollMs: 10,
    startTimeoutMs: 500,
    jobId,
    attemptId,
    sessionId,
    mode: "task",
  })], { env: monitorEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  monitor.stdout!.setEncoding("utf8");
  monitor.stdout!.on("data", chunk => { output += chunk; });

  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const calls: string[][] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "show-options") {
        let value = "";
        try { value = await readFile(key(args.at(-1)!), "utf8"); } catch {}
        return { stdout: value, stderr: "", code: value ? 0 : 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    execChecked: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args.includes("@pi_outcome")) return failure();
      return success();
    },
    recordError: (record: Record<string, unknown>) => {
      const entry = `${JSON.stringify({ type: "custom", customType: "pi-error/v1", data: record })}\n`;
      appendFileSync(sessionFile, entry);
      appendFileSync(sessionFile, entry); // replayed duplicate must not double-complete the parent
      return "error-entry";
    },
    appendEntry: () => {},
    events: {
      on(event: string, listener: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(data);
      },
    },
  };
  const ctx = { mode: "tui", sessionManager: {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
  } };
  t.after(async () => {
    if (monitor.exitCode === null) {
      monitor.kill("SIGTERM");
      await new Promise<void>(resolve => monitor.once("close", () => resolve()));
    }
    process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
    if (oldManifest === undefined) delete process.env.PI_SUBAGENT_MANIFEST; else process.env.PI_SUBAGENT_MANIFEST = oldManifest;
    await rm(dir, { recursive: true, force: true });
  });

  activate(pi as never);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  await until(() => output.includes('"kind":"start"'));
  pi.events.emit("task-outcome", {
    sessionId, jobId, attemptId, mode: "task", outcome: "completed", source: "model",
    summary: "model completed", reportPath, final: true,
  });
  await until(() => output.includes('"kind":"final"'));
  const final = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(marker => marker.kind === "final");
  assert.equal(final.outcome, "failed");
  assert.equal(final.source, "transport");
  assert.equal(final.summary, "Subagent error: tmux exited 23: tmux: pane unavailable");
  const storedEntries = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(storedEntries[0].type, "session");
  const storedError = storedEntries.find(entry => entry.customType === "pi-error/v1" &&
    entry.data?.correlation?.session_id === sessionId && entry.data?.correlation?.job_id === jobId &&
    entry.data?.correlation?.attempt_id === attemptId);
  assert.equal(storedError.data.message, "tmux exited 23: tmux: pane unavailable");
  assert.deepEqual(storedError.data.correlation, { session_id: sessionId, job_id: jobId, attempt_id: attemptId });
  assert.equal(await readFile(reportPath, "utf8"), "saved task evidence\n");
  assert.equal(storedEntries.filter(entry => entry.customType === "pi-error/v1" &&
    entry.data?.correlation?.session_id === sessionId && entry.data?.correlation?.job_id === jobId &&
    entry.data?.correlation?.attempt_id === attemptId).length, 2);
  assert.equal(output.split("\n").filter(line => line.includes('"kind":"final"')).length, 1);
  assert.equal(output.includes('"kind":"evidence"'), false);
  assert.equal(calls.some(args => args[0] === "set-option" && args.includes("@pi_outcome")), true);
  assert.equal(calls.some(args => args[0] === "set-option" && args.includes("@pi_outcome_generation")), false);
  assert.equal(calls.some(args => args[0] === "wait-for" && args.includes("fake-outcome")), false);
});

test("established session header read failure preserves the actual runtime error", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-error-header-read-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  const storageDir = join(dir, "storage");
  const fakeTmux = join(binDir, "tmux");
  const sessionFile = join(storageDir, "session.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const pane = "%header-read-error";
  const jobId = "header-read-job";
  const attemptId = "header-read-attempt";
  const sessionId = "header-read-session";
  await mkdir(binDir);
  await mkdir(stateDir);
  await mkdir(storageDir);
  const key = (option: string) => join(stateDir, option.replace(/[^A-Za-z0-9._-]/g, "_"));
  const setOption = async (option: string, value: string) => writeFile(key(option), value);
  await writeFile(fakeTmux, `#!/bin/sh
state_dir="$FAKE_TMUX_STATE"
file_for() { printf '%s/%s' "$state_dir" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"; }
case "$1" in
  show-options)
    file="$(file_for "$5")"
    if [ -f "$file" ]; then cat "$file"; else exit 1; fi
    ;;
  wait-for) exit 0 ;;
  *) exit 0 ;;
esac
`);
  await chmod(fakeTmux, 0o755);
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  await writeFile(manifestPath, JSON.stringify({ version: 1, jobId, attemptId, sessionId, mode: "dialogue",
    startChannel: "fake-start", startGeneration: 0, outcomeGeneration: 0 }));
  await setOption("@pi_subagent_job_id", jobId);
  await setOption("@pi_subagent_manifest", manifestPath);
  await setOption("@pi_start_generation", "1");
  await setOption("@pi_session_file", sessionFile);
  await setOption("@pi_session_id", sessionId);
  await setOption("@pi_outcome_generation", "0");
  await setOption("@pi_outcome_channel", "fake-outcome");

  const monitorEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, FAKE_TMUX_STATE: stateDir };
  for (const key of ["TMUX", "TMUX_PANE", "PI_SUBAGENT_MANIFEST", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_PROVIDER",
    "PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT", "PI_PACKAGE_DIR", "AI_AGENT"]) delete monitorEnv[key];
  const monitor = spawn(process.execPath, [monitorPath, JSON.stringify({
    paneId: pane,
    manifestOption: "@pi_subagent_manifest",
    outcomeOption: "@pi_outcome",
    outcomeGenerationOption: "@pi_outcome_generation",
    startGenerationOption: "@pi_start_generation",
    sessionFileOption: "@pi_session_file",
    sessionIdOption: "@pi_session_id",
    outcomeChannel: "fake-outcome",
    pollMs: 10,
    startTimeoutMs: 1000,
    jobId,
    attemptId,
    sessionId,
    mode: "dialogue",
  })], { env: monitorEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  monitor.stdout!.setEncoding("utf8");
  monitor.stdout!.on("data", chunk => { output += chunk; });
  t.after(async () => {
    await chmod(storageDir, 0o700).catch(() => {});
    if (monitor.exitCode === null) {
      monitor.kill("SIGTERM");
      await new Promise<void>(resolve => monitor.once("close", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  });

  await until(() => output.includes('"kind":"start"'));
  await chmod(storageDir, 0o000);
  await until(() => output.includes('"kind":"final"'));
  const final = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(marker => marker.kind === "final");
  assert.equal(final.outcome, "transport_lost");
  assert.equal(final.source, "transport");
  assert.match(final.summary, /cannot read Pi error record: .*EACCES|cannot read Pi error record: .*permission denied/i);
});

test("failure-record storage failure is reported locally", async t => {
  const oldPane = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const options = new Map([["@pi_outcome_channel", "fake-outcome"], ["@pi_outcome_generation", "0"]]);
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "show-options") return { stdout: `${options.get(args.at(-1)!) ?? ""}\n`, stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    execChecked: async (_command: string, args: string[]) => args.includes("@pi_outcome") ? failure() : success(),
    recordError: () => { throw new Error("session storage unavailable"); },
    appendEntry: () => {},
    events: {
      on(event: string, listener: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(data);
      },
    },
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = originalError;
    if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
  });
  activate(pi as never);
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "storage-session", getSessionFile: () => undefined } };
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  pi.events.emit("task-outcome", {
    sessionId: "storage-session", jobId: "storage-job", attemptId: "storage-attempt", mode: "task",
    outcome: "completed", source: "model", final: true,
  });
  await until(() => errors.some(error => error.includes("outcome failure record unavailable")));
  assert.match(errors.join("\n"), /session storage unavailable/);
  assert.equal(options.get("@pi_outcome_generation"), "0");
});
