/**
 * Local LLM Progress Extension
 *
 * Reads prefill/decode progress from local model servers and shows a progress
 * line in the working indicator.
 *
 * Prefill: the engine works in bites (chunks). We learn the bite size from the
 * first completed bite, remember it per model on disk, and draw one cell per
 * bite; cells fill only when a bite really completes, and "time left" is the
 * server's measured chunk estimate. Bites below 256 tokens mean the engine is
 * running token-by-token; that path keeps the older smooth bar.
 *
 * Decode: the token counter ticks once per streamed token (like a gas pump),
 * driven by Pi's own stream events and reconciled against the server's
 * authoritative count at each poll.
 *
 * Supported admin stats shape:
 *   { active_models: { models: [{ id, prefilling: [...], generating: [...] }] },
 *     queue_depth: number, queue_position: number | null, request_state: string }
 *
 * mlx-lm (:8000) has no admin API; ds4-server polls /admin/api/stats directly.
 * /admin/api/login answers 204 because no local backend needs a session.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { PrefillProgress, CHUNK_MIN_TOKENS, formatPrefill, formatDecode, formatQueued } from "./local-llm-generation/progress.js";
export { buildChunkBar, originLabel, formatPrefill, formatDecode, formatQueued, formatPrefillChunks } from "./local-llm-generation/progress.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

const MODELS_JSON = `${process.env.HOME}/.pi/agent/models.json`;
function bitesPath(): string {
  return process.env.LOCAL_LLM_BITES_FILE
    || `${process.env.HOME}/.pi/agent/local-llm-bites.json`;
}
const POLL_MS = 250;
const ANIM_MS = 33;
/* The engine's batched bites are >= 256 tokens; anything smaller means it is
 * running token-by-token (short appends and the final tail). */
const STOPPING_STATUS = "local-llm-stopping";
const STOPPING_MESSAGE = "Local LLM stopping...";
const STOPPING_APPEAR_MS = 2_000;
const STOPPING_MAX_MS = 60_000;

// ── Types ───────────────────────────────────────────────────────────────────

interface LoadedModel {
  id: string;
  prefilling: any[];
  generating: any[];
}

interface MonitorConfig {
  providerKey: string;
  statsUrl: string;
  loginUrl?: string;
  apiKey?: string;
  modelIds: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowMs(): number {
  return (typeof performance !== "undefined" && performance.now?.()) || Date.now();
}

function adminBaseFromProviderBase(baseUrl: string): string {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/, "");
}

function numeric(value: any): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getItemSpeed(item: any): number {
  return numeric(item?.speed ?? item?.tok_s ?? item?.tokens_per_second);
}

/* Learned bite sizes per model, persisted so a reload or restart does not
 * forget them and fall back to the smooth warm-up bar. */
function loadBiteGuesses(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(bitesPath(), "utf-8")) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= CHUNK_MIN_TOKENS) out[key] = Math.round(n);
    }
    return out;
  } catch { return {}; }
}

function saveBiteGuesses(guesses: Record<string, number>): void {
  try {
    writeFileSync(bitesPath(), `${JSON.stringify(guesses, null, 2)}\n`);
  } catch { /* best effort: the ledger learns again on the next prefill */ }
}

function loadMonitorConfig(ctx: ExtensionContext): MonitorConfig | null {
  const providerKey = ctx.model?.provider;
  if (!providerKey) return null;

  let provider: any;
  try {
    const raw = readFileSync(MODELS_JSON, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, any>;
    provider = cfg.providers?.[providerKey];
  } catch { return null; }

  if (!provider?.baseUrl) return null;
  const base = adminBaseFromProviderBase(provider.baseUrl);
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base)) return null;

  const modelIds = (provider.models as any[])?.map((m: any) => m.id).filter(Boolean) || [];
  if (ctx.model?.id && modelIds.length && !modelIds.includes(ctx.model.id)) return null;

  return {
    providerKey,
    statsUrl: `${base}/admin/api/stats`,
    // Always try login for any local provider with an API key.
    // The proxy forwards to the right backend; if login isn't needed
    // (e.g. ds4-server) it fails silently and we proceed without auth.
    loginUrl: provider.apiKey ? `${base}/admin/api/login` : undefined,
    apiKey: provider.apiKey,
    modelIds: modelIds.length ? modelIds : (ctx.model?.id ? [ctx.model.id] : []),
  };
}

function findBestMatch(loaded: LoadedModel[], ids: string[]): LoadedModel | null {
  for (const m of loaded) { if (ids.includes(m.id)) return m; }
  return null;
}

function hasStoppingActivity(loaded: LoadedModel[]): boolean {
  return loaded.some((m) => [...(m.prefilling || []), ...(m.generating || [])]
    .some((activity) => activity?.stopping === true));
}

// ── State ───────────────────────────────────────────────────────────────────

// Smooth prefill (warm-up and token-level trickle)
const prefill = new PrefillProgress();
let hasActivity = false;

// Decode odometer
let decodeTokens = 0;
let decodeSpeed  = 0;
let decodeOrigin: string | undefined;
let decodeCount: number | undefined;

// Local-provider gate for the decode odometer and stream events
let isLocalModel = false;

function resetDecode() {
  decodeTokens = 0; decodeSpeed = 0; decodeOrigin = undefined; decodeCount = undefined;
}

function reset() {
  prefill.reset();
  resetDecode();
  hasActivity = false;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let stoppingTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionToken: {} | null = null;
  let abortedToken: {} | null = null;
  let phase: "prefill" | "decode" | null = null;
  let requestId: string | undefined;
  let chatRequest: { url: string; chat_id: string; request_id: string } | undefined;
  const biteGuesses = loadBiteGuesses();

  function rememberBite(modelId: string, bite: number) {
    if (!modelId || bite <= 0 || biteGuesses[modelId] === bite) return;
    biteGuesses[modelId] = bite;
    saveBiteGuesses(biteGuesses);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    if (stoppingTimer) { clearTimeout(stoppingTimer); stoppingTimer = null; }
    reset();
    phase = null;
  }

  async function fetchJSON(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    try {
      const resp = await fetch(url, { ...init, headers, signal: ctl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    } finally { clearTimeout(t); }
  }

  async function releaseChat(ctx: ExtensionContext) {
    const target = chatRequest;
    if (!target) return;
    try {
      const key = process.env.LOCAL_LLM_PROXY_API_KEY
        || readFileSync(`${process.env.HOME}/.pi/agent/.proxy-key`, "utf8").trim();
      await fetchJSON(target.url, {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      }, { method: "POST", body: JSON.stringify(target) });
      if (chatRequest === target) chatRequest = undefined;
    } catch (error) {
      // Expired/released/replaced ownership is already safe. Other failures keep
      // the target for shutdown retry; the server lease/operator action remain.
      if (String(error).includes("HTTP 409")) {
        if (chatRequest === target) chatRequest = undefined;
      } else {
        ctx.ui.notify?.(`Chat release failed: ${error}; lease/operator release remains available`, "warning");
      }
    }
  }

  function renderDecode(): string {
    return formatDecode({
      phase: "decode",
      processed: 0,
      total: 0,
      tokens: decodeTokens,
      tok_s: decodeSpeed,
      origin: decodeOrigin,
      count: decodeCount,
    });
  }

  // Mark Pi's local requests so ds4-server streams a plain answer live instead
  // of holding it behind its second-reasoning guard.
  pi.on("before_provider_headers", (event, _ctx: ExtensionContext) => {
    const monitor = loadMonitorConfig(_ctx);
    if (!monitor) return;
    // Fresh request correlation, stable saved-session identity across tool calls.
    for (const name of Object.keys(event.headers)) {
      if (["x-pi-request-id", "x-pi-chat-id", "x-pi-chat-label"].includes(name.toLowerCase())) delete event.headers[name];
    }
    requestId = randomUUID();
    const chatId = _ctx.sessionManager.getSessionId();
    event.headers["X-Pi-Chat-Id"] = chatId;
    event.headers["X-Pi-Chat-Label"] = (_ctx.sessionManager.getSessionName() || chatId).replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
    chatRequest = { url: monitor.statsUrl.replace(/\/stats$/, "/release-chat"), chat_id: chatId, request_id: requestId };
    reset(); phase = null;
    _ctx.ui.setWorkingMessage(undefined);
    event.headers["X-Pi-Request-Id"] = requestId;
    event.headers["X-Pi-Live-Answer"] = "1";
  });

  // Pi stream events: one delta per generated token. They tick the decode
  // counter at the real token cadence.
  pi.on("message_update", async (event, ctx: ExtensionContext) => {
    if (sessionToken === null || !isLocalModel) return;
    if ((event as any).message?.role !== "assistant") return;
    const ame: any = (event as any).assistantMessageEvent;
    if (!ame) return;
    const isDelta = ame.type === "text_delta" || ame.type === "thinking_delta" || ame.type === "toolcall_delta";
    if (!isDelta) return;

    decodeTokens += 1;
    if (phase === "decode") ctx.ui.setWorkingMessage(renderDecode());
  });

  pi.on("message_start", async (event, _ctx: ExtensionContext) => {
    if ((event as any).message?.role !== "assistant") return;
    resetDecode();
  });

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    sessionToken = null;
    abortedToken = null;
    stopTimers();
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
    ctx.ui.setWorkingMessage(undefined);
    isLocalModel = false;
    requestId = undefined;

    // Ownership headers and release hooks still run in SDK/print mode. Progress
    // timers are terminal-only and must not outlive a disposed headless session.
    if (ctx.mode !== "tui") return;

    const monitor = loadMonitorConfig(ctx);
    if (!monitor) return;
    isLocalModel = true;

    const myToken = {};
    sessionToken = myToken;
    let stoppingSeen = false;
    let stoppingWaitUntil = 0;
    let stoppingDeadline = 0;

    const showStopping = () => {
      ctx.ui.setWorkingMessage(STOPPING_MESSAGE);
      ctx.ui.setStatus(STOPPING_STATUS, STOPPING_MESSAGE);
    };
    const clearStopping = () => {
      if (sessionToken !== myToken) return;
      abortedToken = null;
      stopTimers();
      ctx.ui.setWorkingMessage(undefined);
      ctx.ui.setStatus(STOPPING_STATUS, undefined);
    };
    const updateStopping = (models: LoadedModel[]) => {
      if (abortedToken !== myToken) return false;
      const now = Date.now();
      const present = hasStoppingActivity(models);
      if (present) stoppingSeen = true;
      if (now < stoppingDeadline && (present || (!stoppingSeen && now < stoppingWaitUntil))) {
        showStopping();
      } else {
        clearStopping();
      }
      return true;
    };
    const onAbort = () => {
      if (sessionToken !== myToken) return;
      abortedToken = myToken;
      stoppingWaitUntil = Date.now() + STOPPING_APPEAR_MS;
      stoppingDeadline = Date.now() + STOPPING_MAX_MS;
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      stoppingTimer = setTimeout(clearStopping, STOPPING_MAX_MS);
      showStopping();
    };
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });

    let cookieValue: string | null = null;
    if (monitor.loginUrl && monitor.apiKey) {
      try {
        const r = await fetch(monitor.loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: monitor.apiKey }),
        });
        if (r.ok) cookieValue = r.headers.get("Set-Cookie") || null;
      } catch { /* login is optional for proxy/llama.cpp-backed local servers */ }
    }
    if (sessionToken !== myToken) return;

    const authHeaders = cookieValue ? { Cookie: cookieValue } : {};

    let polling = false;
    pollTimer = setInterval(async () => {
      if (sessionToken !== myToken || polling) return;
      const polledId = requestId;
      polling = true;
      try {
        const headers = polledId ? { ...authHeaders, "X-Pi-Request-Id": polledId } : authHeaders;
        const stats = await fetchJSON(monitor.statsUrl, headers);
        if (sessionToken !== myToken || polledId !== requestId) return;
        const queuePosition = numeric(stats?.queue_position);
        if (queuePosition > 0) {
          reset(); phase = null;
          ctx.ui.setWorkingMessage(formatQueued(queuePosition));
          return;
        }
        if (stats?.request_state !== undefined && stats.request_state !== "active") {
          reset(); phase = null;
          ctx.ui.setWorkingMessage(undefined);
          return;
        }
        const models: LoadedModel[] = stats?.active_models?.models || [];
        if (updateStopping(models)) return;
        if (!models.length) { ctx.ui.setWorkingMessage(undefined); reset(); phase = null; return; }

        const model = findBestMatch(models, monitor.modelIds);
        if (!model) { ctx.ui.setWorkingMessage(undefined); reset(); phase = null; return; }

        const pf = model.prefilling || [];
        const gen = model.generating || [];
        const wasActivity = hasActivity;
        hasActivity = pf.length > 0 || gen.length > 0;

        if (!hasActivity) { ctx.ui.setWorkingMessage(undefined); reset(); phase = null; return; }

        const now = nowMs();

        if (pf.length > 0) {
          if (pf.length > 1) {
            prefill.gtCount = pf.length;
            prefill.gtLastPollTime = 0;
            phase = "prefill";
            ctx.ui.setWorkingMessage(pf.map((p: any) => formatPrefill({
              phase: "prefill", processed: numeric(p.processed), total: numeric(p.total),
              tokens: 0, tok_s: getItemSpeed(p), eta: numeric(p.eta), origin: p.origin,
            }, numeric(p.processed))).join(" | "));
            return;
          }

          const first = pf[0];
          prefill.observe(first, pf.length, now, wasActivity, (bite) => rememberBite(ctx.model?.id || "", bite), biteGuesses[ctx.model?.id || ""] || 0);
          phase = "prefill";
          ctx.ui.setWorkingMessage(prefill.text(now));
          return;
        }

        if (gen.length > 0) {
          prefill.reset();
          phase = "decode";
          if (gen.length > 1) {
            ctx.ui.setWorkingMessage(gen.map((g: any) => formatDecode({
              phase: "decode", processed: 0, total: 0,
              tokens: numeric(g.generated_tokens ?? g.tokens), tok_s: getItemSpeed(g), origin: g.origin,
            })).join(" | "));
          } else {
            const g = gen[0];
            decodeSpeed = getItemSpeed(g);
            decodeOrigin = g.origin;
            decodeCount = gen.length;
            // Seed once before the stream starts ticking; never re-snap, so the
            // count advances one token at a time instead of jumping each poll.
            if (decodeTokens === 0) {
              decodeTokens = numeric(g.generated_tokens ?? g.tokens);
            }
            ctx.ui.setWorkingMessage(renderDecode());
          }
        }
      } catch {
        if (abortedToken === myToken && Date.now() >= stoppingDeadline) clearStopping();
      } finally {
        polling = false;
      }
    }, POLL_MS);

    animTimer = setInterval(() => {
      if (sessionToken !== myToken) return;
      if (phase === "prefill" && prefill.gtTotal > 0 && prefill.gtLastPollTime > 0) {
        ctx.ui.setWorkingMessage(prefill.text(nowMs()));
      } else if (phase === "decode" && decodeTokens > 0) {
        ctx.ui.setWorkingMessage(renderDecode());
      }
    }, ANIM_MS);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (sessionToken !== null && abortedToken === sessionToken) {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      ctx.ui.setWorkingMessage(STOPPING_MESSAGE);
      return;
    }
    sessionToken = null;
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
  });

  // Switching to a non-local provider ends this chat's claim on the local engine.
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "local") await releaseChat(ctx);
  });

  // agent_end may be followed by automatic continuation. Only settlement is
  // the explicit end of the whole run, including all local tool round trips.
  pi.on("agent_settled", async (_event, ctx) => { await releaseChat(ctx); });

  pi.on("session_shutdown", async (_event, ctx) => {
    await releaseChat(ctx);
    sessionToken = null;
    abortedToken = null;
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
  });
}
