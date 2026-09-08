import assert from "node:assert/strict";
import test from "node:test";
import activate from "../../extensions/tmux-turn-signal.ts";

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
