import assert from "node:assert/strict";
import test from "node:test";
import vegaPrompt from "../vega-prompt.ts";

test("inject acknowledges delivery, reports HTTP failures, and reconnects after server restart", async () => {
  const fetchOriginal = globalThis.fetch;
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: (...args: any[]) => any;
  const notices: string[] = [];
  const deliveries: string[] = [];
  let injectStatus = 200;
  let claims = 0;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.endsWith("/session/claim")) return Response.json({ token: `token-${++claims}` });
    if (url.endsWith("/inject")) {
      deliveries.push(String(options.body));
      assert.equal(new Headers(options.headers).get("X-Vega-Session"), `token-${claims}`);
      return Response.json({}, { status: injectStatus });
    }
    return Response.json({ text: "" });
  }) as typeof fetch;
  const ctx = {
    sessionManager: { getBranch: () => [{ type: "custom", customType: "vega-rewrite", data: { rawResponse: "raw", rewrite: "spoken" } }] },
    ui: { notify: (message: string) => notices.push(message) },
  };
  vegaPrompt({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (_name: string, value: any) => { command = value.handler; },
  } as any);
  const event = { messages: [{ role: "assistant", content: [{ type: "text", text: "raw" }] }] };
  try {
    await handlers.get("agent_end")!(event, ctx);
    assert.equal(deliveries.length, 0); // off by default
    await command!("", ctx);
    await handlers.get("agent_end")!(event, ctx);
    assert.deepEqual(deliveries, ["spoken"]);
    injectStatus = 401;
    await handlers.get("agent_end")!(event, ctx);
    assert.match(notices.at(-1)!, /delivery failed.*401/);
    injectStatus = 409;
    await handlers.get("agent_end")!(event, ctx);
    assert.match(notices.at(-1)!, /run \/vega to reconnect/);
    await handlers.get("agent_end")!(event, ctx);
    assert.equal(deliveries.length, 3); // expired token no longer used
    await command!("", ctx);
    assert.equal(claims, 2); // one toggle reconnects, not an extra OFF toggle
    injectStatus = 200;
    await handlers.get("agent_end")!(event, ctx);
    assert.equal(deliveries.length, 4);
  } finally {
    handlers.get("session_shutdown")!();
    globalThis.fetch = fetchOriginal;
  }
});
