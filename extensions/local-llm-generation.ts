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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

const MODELS_JSON = `${process.env.HOME}/.pi/agent/models.json`;
const POLL_MS = 100;
const ANIM_MS = 33;
const BAR_WIDTH = 20;

// ── Types ───────────────────────────────────────────────────────────────────

interface ProgressData {
  phase: "prefill" | "decode";
  processed: number;
  total: number;
  tokens: number;
  tok_s: number;
  eta?: number;
  count?: number;
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
  const eighths = Math.round(pct * BAR_WIDTH * 8);
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

// ── State ───────────────────────────────────────────────────────────────────

let barPos     = 0;     // current bar position (tokens)
let barStart   = 0;     // when current motion segment began
let apiSpeed   = 0;     // real API tok/s (what we display as speed)
let dispSpeed  = 0;     // display speed: how fast barPos advances (tokens/s)

let catchUpEnd    = 0;
let catchUpTarget = 0;

let gtTotal   = 0;
let gtEta: number | undefined;
let gtCount: number | undefined;
let gtLastPollTime = 0;
let hasActivity = false;

function reset() {
  barPos = 0; barStart = 0; apiSpeed = 0; dispSpeed = 0;
  catchUpEnd = 0; catchUpTarget = 0;
  gtTotal = 0; gtEta = undefined; gtCount = undefined;
  gtLastPollTime = 0; hasActivity = false;
}

function inCatchUp(now: number): boolean {
  return catchUpEnd > 0 && now < catchUpEnd;
}

function getInterpolated(now: number): number {
  if (inCatchUp(now)) {
    const t = (now - barStart) / 100; // 0..1 over 100ms
    return Math.min(catchUpTarget * t, gtTotal);
  }
  if (dispSpeed <= 0) return barPos;
  const elapsed = (now - barStart) / 1000;
  return Math.min(barPos + dispSpeed * elapsed, gtTotal);
}

// ── Display Formatting ──────────────────────────────────────────────────────

function formatPrefill(data: ProgressData, interpolated: number): string {
  const clamped = Math.min(Math.max(interpolated, 0), data.total);
  const bar = buildBar(clamped, data.total);
  const speed = formatTokS(data.tok_s);
  const clbl = (data.count != null && data.count > 1) ? ` (${data.count} PP)` : "";
  const eta = formatRemaining(data.eta ?? 0);
  const sp = speed ? `  (${speed})` : "";
  return `Prefill${clbl} ${bar}  ${Math.round(clamped)}/${data.total} tokens${eta}${sp}`;
}

function formatDecode(data: ProgressData): string {
  const speed = formatTokS(data.tok_s);
  const clbl = (data.count != null && data.count > 1) ? ` (${data.count})` : "";
  const sp = speed ? `  (${speed})` : "";
  return `Generating${clbl} - ${data.tokens} tokens${sp}`;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let sessionToken: {} | null = null;

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
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
    stopTimers();
    const myToken = {};
    sessionToken = myToken;
    ctx.ui.setWorkingMessage(undefined);

    const monitor = loadMonitorConfig(ctx);
    if (!monitor) return;

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

    const authHeaders = cookieValue ? { Cookie: cookieValue } : {};

    pollTimer = setInterval(async () => {
      if (sessionToken !== myToken) return;
      try {
        const stats = await fetchJSON(monitor.statsUrl, authHeaders);
        const models: LoadedModel[] = stats?.active_models?.models || [];
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
          const totalProcessed = pf.reduce((s: number, p: any) => s + numeric(p.processed), 0);
          const maxTotal = Math.max(...pf.map((p: any) => numeric(p.total)));
          const first = pf[0];
          const firstSpeed = getItemSpeed(first);

          if (!wasActivity) {
            barPos = 0;
            barStart = now;
            apiSpeed = 0;
            dispSpeed = 0;
          }

          if (apiSpeed === 0 && firstSpeed > 0) {
            apiSpeed = firstSpeed;
            catchUpTarget = totalProcessed + apiSpeed * 0.1;
            catchUpEnd = now + 100;
            dispSpeed = catchUpTarget / 0.1;
            barPos = 0;
            barStart = now;
          }

          if (!inCatchUp(now) && apiSpeed > 0) {
            const elapsed = (now - barStart) / 1000;
            barPos = barPos + dispSpeed * elapsed;
            barStart = now;

            const target = firstSpeed || apiSpeed;
            apiSpeed += (target - apiSpeed) * 0.2;
            dispSpeed = apiSpeed;
          }

          gtTotal = maxTotal;
          gtEta = numeric(first.eta);
          gtCount = pf.length;
          gtLastPollTime = now;
        } else if (gen.length > 0) {
          reset();
          const totalTokens = gen.reduce((s: number, g: any) => s + numeric(g.generated_tokens ?? g.tokens), 0);
          let wSpeed = 0, wTime = 0;
          for (const g of gen) {
            const e = numeric(g.elapsed_seconds) || 1;
            wSpeed += getItemSpeed(g) * e;
            wTime += e;
          }
          const avg = wTime > 0 ? wSpeed / wTime : 0;
          ctx.ui.setWorkingMessage(formatDecode({
            phase: "decode", processed: 0, total: 0,
            tokens: totalTokens, tok_s: avg, count: gen.length,
          }));
        }
      } catch { /* stats fetch failed */ }
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
      }, interpolated));
    }, ANIM_MS);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimers();
    ctx.ui.setWorkingMessage(undefined);
  });
}
