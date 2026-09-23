import assert from "node:assert/strict";
import test from "node:test";
import activate, { formatQueued } from "../local-llm-generation.ts";

type Handler = (event: any, ctx: any) => Promise<void> | void;
const MODEL = "deepseek-v4.1-flash";
const models = { models: [{ id: MODEL, prefilling: [], generating: [{ generated_tokens: 99, tokens_per_second: 10 }] }] };

test("queue correlation excludes stale, unknown and colliding request progress", async (t) => {
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const intervals: (() => any)[] = [];
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let result: any = { queue_position: 2, request_state: "queued", active_models: models };
  let statsId: string | null = null;
  globalThis.setInterval = ((callback: () => any) => { intervals.push(callback); return intervals.length; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") return new Response(null, { status: 204 });
    statsId = new Headers(init?.headers).get("X-Pi-Request-Id");
    return Response.json(await result);
  };
  const ctx = {
    model: { provider: "local", id: MODEL }, signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "test-chat", getSessionName: () => "Test chat" },
    ui: { setStatus() {}, setWorkingMessage(message?: string) { messages.push(message || ""); } },
  };
  activate({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  });
  await handlers.get("agent_start")?.({}, ctx);
  const event = { headers: { "x-pi-request-id": "static", "X-Pi-Request-Id": "static" } as Record<string, string> };
  handlers.get("before_provider_headers")?.(event, ctx);
  assert.equal(event.headers["x-pi-request-id"], undefined);
  assert.notEqual(event.headers["X-Pi-Request-Id"], "static");
  const poll = intervals[0];
  await poll();
  assert.equal(messages.at(-1), "Queued (2nd)");
  assert.equal(statsId, event.headers["X-Pi-Request-Id"]);
  for (const state of ["unknown", "ambiguous", "uncertain"]) {
    result = { request_state: state, active_models: models };
    await poll();
    assert.equal(messages.at(-1), "");
  }
  let release!: (value: any) => void;
  result = new Promise((resolve) => { release = resolve; });
  const stale = poll();
  const oldId = event.headers["X-Pi-Request-Id"];
  assert.equal(event.headers["X-Pi-Chat-Id"], "test-chat");
  assert.equal(event.headers["X-Pi-Chat-Label"], "Test chat");
  handlers.get("before_provider_headers")?.(event, ctx);
  assert.notEqual(event.headers["X-Pi-Request-Id"], oldId);
  assert.equal(event.headers["X-Pi-Chat-Id"], "test-chat");
  release({ queue_position: 1, request_state: "queued", active_models: models });
  await stale;
  assert.equal(messages.at(-1), "");
  assert.ok(!messages.some((message) => message.includes("Decoding")));
  for (const [n, suffix] of [[1,"1st"], [2,"2nd"], [3,"3rd"], [11,"11th"], [12,"12th"], [13,"13th"], [21,"21st"]] as const) {
    assert.equal(formatQueued(n), `Queued (${suffix})`);
  }
});
