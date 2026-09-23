import assert from "node:assert/strict";
import test from "node:test";
import activate from "../local-llm-generation.ts";
import { buildRequestHeaders } from "./request-headers.ts";

test("session identity survives provider wrapper and releases only at settlement/shutdown", async (t) => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const posts: { url: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LOCAL_LLM_PROXY_API_KEY;
  process.env.LOCAL_LLM_PROXY_API_KEY = "offline-test";
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer offline-test");
    posts.push({ url: String(url), body: JSON.parse(init?.body as string) });
    return Response.json({ released: true });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LOCAL_LLM_PROXY_API_KEY;
    else process.env.LOCAL_LLM_PROXY_API_KEY = originalKey;
  });
  let sessionId = "chat-a";
  const ctx = {
    model: { provider: "local", id: "qwen3.8-flash-next" },
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => "Agent A" },
    ui: { setWorkingMessage() {}, setStatus() {}, notify() {} },
  };
  activate({ on: (event: string, handler: any) => handlers.set(event, handler) } as never);
  const event = { headers: { "x-pi-chat-id": "wrong", "x-pi-chat-label": "wrong" } as Record<string, string> };
  handlers.get("before_provider_headers")!(event, ctx);
  const firstId = event.headers["X-Pi-Request-Id"];
  assert.equal(event.headers["x-pi-chat-id"], undefined);
  assert.equal(event.headers["X-Pi-Chat-Id"], "chat-a");
  assert.equal(buildRequestHeaders(event.headers)["X-Pi-Chat-Id"], "chat-a");
  assert.equal(buildRequestHeaders(event.headers)["X-Pi-Chat-Label"], "Agent A");
  handlers.get("before_provider_headers")!(event, ctx);
  assert.notEqual(event.headers["X-Pi-Request-Id"], firstId);
  assert.equal(event.headers["X-Pi-Chat-Id"], "chat-a");
  await handlers.get("agent_end")!({}, ctx);
  assert.equal(posts.length, 0);
  await handlers.get("agent_settled")!({}, ctx);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith("/admin/api/release-chat"));
  assert.equal(posts[0].body.chat_id, "chat-a");
  assert.equal(posts[0].body.request_id, event.headers["X-Pi-Request-Id"]);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(posts.length, 1);
  sessionId = "chat-b";
  handlers.get("before_provider_headers")!(event, ctx);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.chat_id, "chat-b");
});
