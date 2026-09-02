/**
 * Local LLM Progress Bar Extension
 *
 * Reads prefill/decode progress from local model servers and shows a progress
 * bar in the working indicator.
 *
 * Supported admin stats shape:
 *   { active_models: { models: [{ id, prefilling: [...], generating: [...] }] } }
 *
 * oMLX: logs in through /admin/api/login and polls /admin/api/stats.
 * ds4-server: polls /admin/api/stats directly.
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

const MODELS_JSON = `${process.env.HOME}/.pi/agent/models.json`;
const POLL_MS = 250;
const ANIM_MS = 33;
const BAR_WIDTH = 20;
const STOPPING_STATUS = "local-llm-stopping";
const STOPPING_MESSAGE = "Local LLM stopping...";
const STOPPING_APPEAR_MS = 2_000;
const STOPPING_MAX_MS = 60_000;

// ── Types ───────────────────────────────────────────────────────────────────

interface ProgressData {
  phase: "prefill" | "decode";
  processed: number;
  total: number;
  tokens: number;
  tok_s: number;
  eta?: number;
  count?: number;
  origin?: string;
}

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

const PARTIAL_BLOCKS: Record<number, string> = {
  1: "\u258F", 2: "\u258E", 3: "\u258D", 4: "\u258C",
  5: "\u258B", 6: "\u258A", 7: "\u2589",
};

function buildBar(filled: number, total: number): string {
  const pct = total > 0 ? Math.min(filled / total, 1) : 0;
  const eighths = Math.floor(pct * BAR_WIDTH * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const empty = BAR_WIDTH - full - (rem > 0 ? 1 : 0);
  return "\u2588".repeat(full) + (rem > 0 ? PARTIAL_BLOCKS[rem] : "") + "\u2591".repeat(empty);
}

function formatTokS(tok_s: number): string {
  if (tok_s <= 0) return "";
  if (tok_s >= 1000) return `${(tok_s / 1000).toFixed(1)}k tok/s`;
  return `${Math.round(tok_s)} tok/s`;
}

function formatRemaining(seconds: number): string {
  if (!seconds || seconds <= 0 || seconds > 36000) return "";
  if (seconds >= 60) return `, ${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s left`;
  return `, ${Math.round(seconds)}s left`;
}

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

let barPos     = 0;     // current bar position (tokens)
let barStart   = 0;     // when current motion segment began
let apiSpeed   = 0;     // real API tok/s (what we display as speed)
let dispSpeed  = 0;     // display speed: how fast barPos advances (tokens/s)

let gtProcessed = 0;
let gtTotal   = 0;
let gtEta: number | undefined;
let gtCount: number | undefined;
let gtOrigin: string | undefined;
let gtLastPollTime = 0;
let hasActivity = false;

function reset() {
  barPos = 0; barStart = 0; apiSpeed = 0; dispSpeed = 0;
  gtProcessed = 0; gtTotal = 0; gtEta = undefined; gtCount = undefined; gtOrigin = undefined;
  gtLastPollTime = 0; hasActivity = false;
}

function getInterpolated(now: number): number {
  if (dispSpeed <= 0) return barPos;
  const elapsed = (now - barStart) / 1000;
  const ceiling = gtProcessed < gtTotal ? gtTotal - 1 : gtTotal;
  return Math.min(barPos + dispSpeed * elapsed, ceiling);
}

// ── Display Formatting ──────────────────────────────────────────────────────

export function originLabel(origin?: string): string {
  const value = typeof origin === "string" ? origin.trim() : "";
  return !value || value.toLowerCase() === "user" ? "" : ` (${value.toUpperCase()})`;
}

export function formatPrefill(data: ProgressData, interpolated: number): string {
  const clamped = Math.min(Math.max(interpolated, 0), data.total);
  const bar = buildBar(clamped, data.total);
  const speed = formatTokS(data.tok_s);
  const clbl = (data.count != null && data.count > 1) ? ` (${data.count} PP)` : "";
  const eta = formatRemaining(data.eta ?? 0);
  const sp = speed ? `  (${speed})` : "";
  return `Prefill${originLabel(data.origin)}${clbl} ${bar}  ${Math.floor(clamped)}/${data.total} tokens${eta}${sp}`;
}

export function formatDecode(data: ProgressData): string {
  const speed = formatTokS(data.tok_s);
  const clbl = (data.count != null && data.count > 1) ? ` (${data.count})` : "";
  const sp = speed ? `  (${speed})` : "";
  return `Generating${originLabel(data.origin)}${clbl} - ${data.tokens} tokens${sp}`;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let stoppingTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionToken: {} | null = null;
  let abortedToken: {} | null = null;

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    if (stoppingTimer) { clearTimeout(stoppingTimer); stoppingTimer = null; }
    reset();
  }

  async function fetchJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    try {
      const resp = await fetch(url, { headers, signal: ctl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    } finally { clearTimeout(t); }
  }

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    sessionToken = null;
    abortedToken = null;
    stopTimers();
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
    ctx.ui.setWorkingMessage(undefined);

    const monitor = loadMonitorConfig(ctx);
    if (!monitor) return;

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

    pollTimer = setInterval(async () => {
      if (sessionToken !== myToken) return;
      try {
        const stats = await fetchJSON(monitor.statsUrl, authHeaders);
        if (sessionToken !== myToken) return;
        const models: LoadedModel[] = stats?.active_models?.models || [];
        if (updateStopping(models)) return;
        if (!models.length) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const model = findBestMatch(models, monitor.modelIds);
        if (!model) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const pf = model.prefilling || [];
        const gen = model.generating || [];
        const wasActivity = hasActivity;
        hasActivity = pf.length > 0 || gen.length > 0;

        if (!hasActivity) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const now = nowMs();

        if (pf.length > 0) {
          if (pf.length > 1) {
            gtCount = pf.length;
            gtLastPollTime = 0;
            ctx.ui.setWorkingMessage(pf.map((p: any) => formatPrefill({
              phase: "prefill", processed: numeric(p.processed), total: numeric(p.total),
              tokens: 0, tok_s: getItemSpeed(p), eta: numeric(p.eta), origin: p.origin,
            }, numeric(p.processed))).join(" | "));
            return;
          }
          const totalProcessed = pf.reduce((s: number, p: any) => s + numeric(p.processed), 0);
          const total = pf.reduce((s: number, p: any) => s + numeric(p.total), 0);
          const first = pf[0];
          const firstSpeed = getItemSpeed(first);

          if (!wasActivity || (gtCount != null && gtCount > 1)) {
            barPos = 0;
            barStart = now;
            apiSpeed = 0;
            dispSpeed = 0;
          }

          if (firstSpeed > 0) {
            apiSpeed = apiSpeed === 0 ? firstSpeed : apiSpeed + (firstSpeed - apiSpeed) * 0.2;
          }
          barPos = totalProcessed;
          barStart = now;
          dispSpeed = apiSpeed;

          gtProcessed = totalProcessed;
          gtTotal = total;
          gtEta = numeric(first.eta);
          gtCount = pf.length;
          gtOrigin = first.origin;
          gtLastPollTime = now;
        } else if (gen.length > 0) {
          reset();
          ctx.ui.setWorkingMessage(gen.map((g: any) => formatDecode({
            phase: "decode", processed: 0, total: 0,
            tokens: numeric(g.generated_tokens ?? g.tokens), tok_s: getItemSpeed(g), origin: g.origin,
          })).join(" | "));
        }
      } catch {
        if (abortedToken === myToken && Date.now() >= stoppingDeadline) clearStopping();
      }
    }, POLL_MS);

    animTimer = setInterval(() => {
      if (sessionToken !== myToken) return;
      if (gtLastPollTime === 0) return;
      if (!hasActivity || gtTotal <= 0) return;

      const now = nowMs();
      const interpolated = getInterpolated(now);

      ctx.ui.setWorkingMessage(formatPrefill({
        phase: "prefill",
        processed: interpolated,
        total: gtTotal,
        tokens: 0,
        tok_s: apiSpeed,
        eta: gtEta,
        count: gtCount,
        origin: gtOrigin,
      }, interpolated));
    }, ANIM_MS);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (abortedToken === sessionToken) {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      ctx.ui.setWorkingMessage(STOPPING_MESSAGE);
      return;
    }
    sessionToken = null;
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionToken = null;
    abortedToken = null;
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setStatus(STOPPING_STATUS, undefined);
  });
}
