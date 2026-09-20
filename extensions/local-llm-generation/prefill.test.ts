import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import activate from "../local-llm-generation.ts";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL = "deepseek-v4.1-flash";
const BITES_FILE = "/tmp/pi-local-llm-bites-prefill.test.json";

function resetBites() {
  process.env.LOCAL_LLM_BITES_FILE = BITES_FILE;
  try { rmSync(BITES_FILE, { force: true }); } catch {}
}

function makeHandlers() {
  return new Map<string, Handler>();
}

function makePi(handlers: Map<string, Handler>) {
  return {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
}

function makeCtx(messages: string[]) {
  return {
    model: { provider: "local", id: MODEL },
    signal: new AbortController().signal,
    ui: {
      setStatus() {},
      setWorkingMessage(message?: string) { if (message) messages.push(message); },
    },
  };
}

function stop(handlers: Map<string, Handler>, ctx: any, originalFetch: typeof fetch) {
  return async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = originalFetch;
  };
}

test("prefill estimate re-anchors without completing before the server", async (t) => {
  const handlers = makeHandlers();
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
          id: MODEL,
          prefilling: [{ processed, total: 100, speed: 1000, eta: 1 }],
          generating: [],
        }],
      },
    });
  };

  const pi = makePi(handlers);
  const ctx = makeCtx(messages);
  resetBites();
  activate(pi as never);
  t.after(stop(handlers, ctx, originalFetch));
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

test("prefill draws one cell per bite and fills only when a bite completes", async (t) => {
  const handlers = makeHandlers();
  const messages: string[] = [];
  const originalFetch = globalThis.fetch;
  let polls = 0;

  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") return new Response(null, { status: 200 });
    polls++;
    const processed = polls === 1 ? 2048 : polls === 2 ? 4096 : 6144;
    return Response.json({
      active_models: {
        models: [{
          id: MODEL,
          prefilling: [{ processed, total: 8192, speed: 300, eta: 20 }],
          generating: [],
        }],
      },
    });
  };

  const pi = makePi(handlers);
  const ctx = makeCtx(messages);
  resetBites();
  activate(pi as never);
  t.after(stop(handlers, ctx, originalFetch));
  await handlers.get("agent_start")?.({}, ctx);

  await wait(330);
  const early = messages.filter((m) => m.includes("chunks"));
  assert.ok(early.length > 0, "expected the chunk ledger");
  assert.match(early[0], /1\/4 chunks/);
  assert.match(early[0], /█ ░ ░ ░/);
  assert.match(early[0], /\(300 tok\/s\)/);
  assert.match(early[0], /20s left/);

  await wait(120); // still before the second poll (250ms cadence)
  const mid = messages.filter((m) => m.includes("chunks"));
  assert.ok(mid.length > early.length, "animation should keep rendering");
  assert.ok(mid.slice(early.length).every((m) => m === early[0]), "bar must not move between bites");

  await wait(250); // second poll has landed
  assert.ok(messages.some((m) => /2\/4 chunks/.test(m)), "second bite should advance the ledger");

  const stored = JSON.parse(readFileSync(BITES_FILE, "utf-8"));
  assert.equal(stored[MODEL], 2048, "learned bite should survive a reload");
});
