import assert from "node:assert/strict";
import test from "node:test";
import activate from "../local-llm-generation.ts";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("prefill estimate re-anchors without completing before the server", async (t) => {
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const originalFetch = globalThis.fetch;
  let polls = 0;
  let completedAt = -1;

  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") return new Response(null, { status: 200 });
    polls++;
    if (polls === 3) completedAt = messages.length;
    const processed = polls === 1 ? 10 : polls === 2 ? 20 : 100;
    return Response.json({
      active_models: {
        models: [{
          id: "glm-5.3-flash",
          prefilling: [{ processed, total: 100, speed: 1000, eta: 1 }],
          generating: [],
        }],
      },
    });
  };

  const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
  const ctx = {
    model: { provider: "local", id: "glm-5.3-flash" },
    signal: new AbortController().signal,
    ui: {
      setStatus() {},
      setWorkingMessage(message?: string) { if (message) messages.push(message); },
    },
  };

  activate(pi as never);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = originalFetch;
  });
  await handlers.get("agent_start")?.({}, ctx);
  await wait(850);

  assert.ok(completedAt > 0, "expected three stats polls");
  const beforeCompletion = messages.slice(0, completedAt);
  const values = beforeCompletion.flatMap((message) => {
    const match = message.match(/  (\d+)\/100 tokens/);
    return match ? [Number(match[1])] : [];
  });
  const racedAhead = values.indexOf(99);
  assert.ok(racedAhead >= 0, "synthetic estimate should race ahead");
  assert.ok(values.slice(racedAhead + 1).some((value) => value < 60), "next poll should snap the estimate back");
  assert.ok(values.every((value) => value < 100), "must not display complete before authoritative completion");
  assert.ok(beforeCompletion.every((message) => !message.includes("████████████████████")), "must not render a full bar early");
  assert.ok(messages.slice(completedAt).some((message) => message.includes("████████████████████  100/100")));
});
