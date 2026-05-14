/**
 * DFlash Progress Bar Extension
 *
 * Reads prefill/decode progress from /tmp/dflash-progress.json (written by
 * Rapid-MLX server) and shows a progress bar in the working indicator.
 *
 * During prefill:  ████████░░░░░░░░  6144/12000 tokens  (12345 tok/s)
 * During decode:   Generating · 247 tokens  (32 tok/s, 46% acc)
 *
 * Mid-chunk extrapolation: Because prefill_progress events fire only at
 * chunk boundaries (every few seconds), the bar extrapolates linearly using
 * the last measured tok/s between real events. Shows " est." tag while
 * estimating. Snaps to ground truth on every new event.
 *
 * Usage:
 *   Add to your pi config or load via --extension:
 *   pi --extension ~/.pi/agent/extensions/dflash-progress.ts
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

const PROGRESS_FILE = "/tmp/dflash-progress.json";
const POLL_MS = 100;
const BAR_WIDTH = 20;
const SAFETY_FACTOR = 0.9; // Extrapolate at 90% of measured speed so bar lags behind reality

// Partial block characters for sub-character resolution (1/8 to 7/8)
const PARTIAL_BLOCKS: Record<number, string> = {
  1: "\u258F", // ▏ 1/8
  2: "\u258E", // ▎ 2/8
  3: "\u258D", // ▍ 3/8
  4: "\u258C", // ▌ 4/8
  5: "\u258B", // ▋ 5/8
  6: "\u258A", // ▊ 6/8
  7: "\u2589", // ▉ 7/8
};

interface ProgressData {
  phase: "prefill" | "prefill_done" | "decode";
  processed?: number;
  total?: number;
  tokens?: number;
  tok_s?: number;
  acceptance_pct?: number;
}

function buildBar(filled: number, total: number): string {
  const pct = total > 0 ? filled / total : 0;
  const totalEighths = Math.round(pct * BAR_WIDTH * 8);
  const fullBlocks = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;
  const emptyBlocks = BAR_WIDTH - fullBlocks - (remainder > 0 ? 1 : 0);

  const full = "\u2588".repeat(fullBlocks);
  const partial = remainder > 0 ? PARTIAL_BLOCKS[remainder] : "";
  const empty = "\u2591".repeat(emptyBlocks);
  return full + partial + empty;
}

function formatTokS(tok_s: number | undefined): string {
  if (tok_s === undefined || tok_s <= 0) return "";
  if (tok_s >= 1000) return `${(tok_s / 1000).toFixed(1)}k tok/s`;
  return `${Math.round(tok_s)} tok/s`;
}

function formatPrefill(
  processed: number,
  total: number,
  tok_s: number | undefined,
  extrapolating: boolean,
): string {
  const clamped = Math.min(Math.max(Math.round(processed), 0), total);
  const bar = buildBar(clamped, total);
  const speed = formatTokS(tok_s);
  const tag = extrapolating ? " est." : "";
  return `Prefill ${bar}  ${clamped}/${total} tokens${tag}${speed ? `  (${speed})` : ""}`;
}

function formatProgress(data: ProgressData, extrapolating?: boolean): string {
  switch (data.phase) {
    case "prefill": {
      return formatPrefill(data.processed ?? 0, data.total ?? 0, data.tok_s, !!extrapolating);
    }
    case "prefill_done": {
      const total = data.total ?? 0;
      const speed = formatTokS(data.tok_s);
      return `Prefill done \xb7 ${total} tokens${speed ? `  (${speed})` : ""}`;
    }
    case "decode": {
      const tokens = data.tokens ?? 0;
      const speed = formatTokS(data.tok_s);
      const acc = data.acceptance_pct !== undefined ? `${Math.round(data.acceptance_pct)}% acc` : "";
      const extras = [speed, acc].filter(Boolean).join(", ");
      return `Generating \xb7 ${tokens} tokens${extras ? `  (${extras})` : ""}`;
    }
  }
}

// Extrapolation state — persists across poll ticks during a prefill phase
let anchorProcessed = 0;
let anchorTotal = 0;
let anchorSpeed = 0;       // tok/s computed from delta between consecutive real events
let anchorTimestamp = 0;    // performance.now() of last real event

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastData: string | null = null;

  function readProgress(): ProgressData | null {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      if (raw === lastData) return null;
      lastData = raw;
      return JSON.parse(raw) as ProgressData;
    } catch {
      return null;
    }
  }

  function resetAnchors() {
    anchorProcessed = 0;
    anchorTotal = 0;
    anchorSpeed = 0;
    anchorTimestamp = 0;
  }

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    lastData = null;
    resetAnchors();

    function tryExtrapolate(ctx: ExtensionContext): boolean {
      if (anchorSpeed > 0 && anchorTimestamp > 0) {
        const now = performance.now();
        const elapsed = (now - anchorTimestamp) / 1000;
        // Safety factor: extrapolate slower than measured speed
        // so the bar lags behind reality and catches up on next real event
        const estimated = anchorProcessed + anchorSpeed * elapsed * SAFETY_FACTOR;
        const clamped = Math.min(estimated, anchorTotal);
        ctx.ui.setWorkingMessage(formatPrefill(clamped, anchorTotal, anchorSpeed, true));
        return true;
      }
      return false;
    }

    pollTimer = setInterval(() => {
      const data = readProgress();

      if (data && data.phase === "prefill") {
        const processed = data.processed ?? 0;
        const total = data.total ?? 0;

        if (processed > 0 && total > 0) {
          // ----- New ground-truth event arrived -----
          const now = performance.now();

          // Compute instantaneous speed from delta between this event and the previous anchor
          if (anchorTimestamp > 0) {
            const dt = (now - anchorTimestamp) / 1000; // ms -> s
            if (dt > 0) {
              // Safety factor applied only during extrapolation, not to ground truth
              anchorSpeed = (processed - anchorProcessed) / dt;
            }
          }

          // Refresh anchor to this new real data point
          anchorProcessed = processed;
          anchorTotal = total;
          anchorTimestamp = now;

          // Show ground truth immediately
          ctx.ui.setWorkingMessage(formatPrefill(processed, total, anchorSpeed, false));
        } else if (!tryExtrapolate(ctx)) {
          // processed <= 0 or total <= 0, no anchors yet — render raw
          ctx.ui.setWorkingMessage(formatProgress(data));
        }
      } else if (data) {
        // prefill_done or decode phase — reset extrapolation, render normally
        resetAnchors();
        ctx.ui.setWorkingMessage(formatProgress(data));
      } else {
        // No new data — extrapolate from last known anchor
        tryExtrapolate(ctx);
      }
    }, POLL_MS);
  });

  pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    resetAnchors();
    // Restore default working message
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    resetAnchors();
  });
}
