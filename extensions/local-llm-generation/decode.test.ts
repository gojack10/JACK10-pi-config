import assert from "node:assert/strict";
import test from "node:test";
import activate from "../local-llm-generation.ts";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL = "deepseek-v4.1-flash";

test("decode odometer ticks once per streamed token and never re-snaps", async (t) => {
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const originalFetch = globalThis.fetch;
  let polls = 0;

  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") return new Response(null, { status: 200 });
    polls++;
    const tokens = polls === 1 ? 3 : 50;
    return Response.json({
      active_models: {
        models: [{
          id: MODEL,
          prefilling: [],
          generating: [{ generated_tokens: tokens, tokens_per_second: 10 }],
        }],
      },
    });
  };

  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
  const ctx = {
    model: { provider: "local", id: MODEL },
    signal: new AbortController().signal,
    ui: {
      setStatus() {},
      setWorkingMessage(message?: string) { if (message) messages.push(message); },
    },
  };

  process.env.LOCAL_LLM_BITES_FILE = "/tmp/pi-local-llm-bites-decode.test.json";
  activate(pi as never);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = originalFetch;
  });
  await handlers.get("agent_start")?.({}, ctx);
  await wait(300);
  assert.ok(
    messages.some((m) => m.includes("Decoding") && m.includes("- 3 tokens")),
    "server count should seed the odometer",
  );

  const delta = () => handlers.get("message_update")?.({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "abcd" },
  }, ctx);

  await delta();
  await delta();
  await delta();
  assert.ok(messages.some((m) => m.includes("- 4 tokens")), "first token should tick the counter");
  assert.ok(messages.some((m) => m.includes("- 5 tokens")));
  assert.ok(messages.some((m) => m.includes("- 6 tokens")));

  await wait(300);
  assert.ok(!messages.some((m) => m.includes("- 50 tokens")), "a later server count must not jump the odometer");
  assert.ok(
    messages.some((m) => m.includes("Decoding") && m.includes("- 6 tokens")),
    "count stays at the last streamed token",
  );
});
