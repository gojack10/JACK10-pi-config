/**
 * OMLX Progress Bar Extension
 *
 * Reads prefill/decode progress from oMLX's admin API and shows a progress
 * bar in the working indicator.
 *
 * During prefill:  ████████░░░░░░░░  6144/12000 tokens (488 tok/s, 2.1s left)
 * During decode:   Generating · 247 tokens  (32 tok/s)
 *
 * Strategy:
 *   1. Wait at 0% until first real tok/s arrives from API.
 *   2. On first tok/s: calculate where ground truth will be in 100ms
 *      (currentProcessed + tok_s * 0.1). Animate bar from 0% to that
 *      point over exactly 100ms.
 *   3. When catch-up finishes, bar and ground truth are naturally aligned
 *      (ground truth advanced at the same tok/s for the same 100ms).
 *   4. Resume: bar moves at the API's real tok/s. Polls gently correct
 *      speed. NEVER lie about tok/s — always display the real API value.
 *
 * Usage:
 *   pi --extension ~/.pi/agent/extensions/local-llm-generation.ts
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

const OMLX_BASE = "http://localhost:8000";
const OMLX_LOGIN = `${OMLX_BASE}/admin/api/login`;
const OMLX_STATS = `${OMLX_BASE}/admin/api/stats`;
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

// ── State ───────────────────────────────────────────────────────────────────
//
//   Waiting  (apiSpeed === 0):     bar sits at 0, nothing displayed
//   Catch-up (catchUpEnd > 0):     bar animates from 0 → catchUpTarget over 100ms
//   Running  (apiSpeed > 0):       bar advances at apiSpeed (corrected by polls)

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
    // Linear animation from 0 → catchUpTarget over 100ms
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
  return `Generating${clbl} · ${data.tokens} tokens${sp}`;
}

// ── Model Matching ──────────────────────────────────────────────────────────

interface LoadedModel {
  id: string;
  prefilling: any[];
  generating: any[];
}

function findBestMatch(loaded: LoadedModel[], ids: string[]): LoadedModel | null {
  for (const m of loaded) { if (ids.includes(m.id)) return m; }
  return null;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let cookieValue: string | null = null;

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
    reset();
    cookieValue = null;

    // ── Config ──
    let apiKey: string;
    let configModelIds: string[] = [];
    try {
      const raw = readFileSync(MODELS_JSON, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, any>;
      const lp = cfg.providers?.local;
      if (!lp) return;
      apiKey = lp.apiKey;
      if (!apiKey) return;
      configModelIds = (lp.models as any[])?.map((m: any) => m.id) || [];
    } catch { return; }

    // ── Login ──
    try {
      const r = await fetch(OMLX_LOGIN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      if (!r.ok) return;
      cookieValue = r.headers.get("Set-Cookie") || null;
      if (!cookieValue) return;
    } catch { return; }

    const authHeaders = cookieValue ? { Cookie: cookieValue } : {};

    // ── 3. Poll ──
    pollTimer = setInterval(async () => {
      try {
        const stats = await fetchJSON(OMLX_STATS, authHeaders);
        const models: LoadedModel[] = stats?.active_models?.models || [];
        if (!models.length) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const model = findBestMatch(models, configModelIds);
        if (!model) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const pf = model.prefilling || [];
        const gen = model.generating || [];
        const wasActivity = hasActivity;
        hasActivity = pf.length > 0 || gen.length > 0;

        if (!hasActivity) { ctx.ui.setWorkingMessage(undefined); reset(); return; }

        const now = nowMs();

        // ── Prefill ──
        if (pf.length > 0) {
          const totalProcessed = pf.reduce((s: number, p: any) => s + (p.processed || 0), 0);
          const maxTotal = Math.max(...pf.map((p: any) => p.total || 0));
          const first = pf[0];

          // First poll: bar sits at 0, waiting for tok/s
          if (!wasActivity) {
            barPos = 0;
            barStart = now;
            apiSpeed = 0;
            dispSpeed = 0;
          }

          // First time we see a real tok/s → start catch-up
          if (apiSpeed === 0 && first.speed > 0) {
            apiSpeed = first.speed;               // REAL tok/s — never lie
            // Where ground truth will be in 100ms at the real tok/s
            catchUpTarget = totalProcessed + apiSpeed * 0.1;
            catchUpEnd = now + 100;
            dispSpeed = catchUpTarget / 0.1;      // speed to reach target in 100ms
            barPos = 0;
            barStart = now;
          }

          // After catch-up: preserve accumulated position, correct speed
          if (!inCatchUp(now) && apiSpeed > 0) {
            // Preserve position from whatever dispSpeed was active
            const elapsed = (now - barStart) / 1000;
            barPos = barPos + dispSpeed * elapsed;
            barStart = now;

            // Correct display speed toward real API tok/s (20% per poll)
            const target = first.speed || apiSpeed;
            apiSpeed += (target - apiSpeed) * 0.2;
            dispSpeed = apiSpeed;
          }

          gtTotal = maxTotal;
          gtEta = first.eta;
          gtCount = pf.length;
          gtLastPollTime = now;
        }
        // ── Decode ──
        else if (gen.length > 0) {
          reset();
          const totalTokens = gen.reduce((s: number, g: any) => s + (g.generated_tokens || 0), 0);
          let wSpeed = 0, wTime = 0;
          for (const g of gen) {
            const e = g.elapsed_seconds || 0;
            wSpeed += (g.tokens_per_second || 0) * e;
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

    // ── 4. Animation ──
    animTimer = setInterval(() => {
      if (gtLastPollTime === 0) return;
      if (!hasActivity || gtTotal <= 0) return;

      const now = nowMs();
      const interpolated = getInterpolated(now);

      ctx.ui.setWorkingMessage(formatPrefill({
        phase: "prefill",
        processed: interpolated,
        total: gtTotal,
        tokens: 0,
        tok_s: apiSpeed,       // <— always the REAL API tok/s
        eta: gtEta,
        count: gtCount,
      }, interpolated));
    }, ANIM_MS);
  });

  pi.on("agent_end", async () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    reset();
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    reset();
  });
}
