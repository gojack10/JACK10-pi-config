/**
 * DFlash Progress Bar Extension
 *
 * Reads prefill/decode progress from /tmp/dflash-progress.json (written by
 * Rapid-MLX server) and shows a progress bar in the working indicator.
 *
 * During prefill:  ████████░░░░░░░░  6144/12000 tokens  (12345 tok/s)
 * During decode:   Generating · 247 tokens  (32 tok/s, 46% acc)
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
  const filledBlocks = Math.round(pct * BAR_WIDTH);
  const emptyBlocks = BAR_WIDTH - filledBlocks;
  return "█".repeat(filledBlocks) + "░".repeat(emptyBlocks);
}

function formatTokS(tok_s: number | undefined): string {
  if (tok_s === undefined || tok_s <= 0) return "";
  if (tok_s >= 1000) return `${(tok_s / 1000).toFixed(1)}k tok/s`;
  return `${Math.round(tok_s)} tok/s`;
}

function formatProgress(data: ProgressData): string {
  switch (data.phase) {
    case "prefill": {
      const processed = data.processed ?? 0;
      const total = data.total ?? 0;
      const bar = buildBar(processed, total);
      const speed = formatTokS(data.tok_s);
      return `Prefill ${bar}  ${processed}/${total} tokens${speed ? `  (${speed})` : ""}`;
    }
    case "prefill_done": {
      const total = data.total ?? 0;
      const speed = formatTokS(data.tok_s);
      return `Prefill done · ${total} tokens${speed ? `  (${speed})` : ""}`;
    }
    case "decode": {
      const tokens = data.tokens ?? 0;
      const speed = formatTokS(data.tok_s);
      const acc = data.acceptance_pct !== undefined ? `, ${Math.round(data.acceptance_pct)}% acc` : "";
      return `Generating · ${tokens} tokens${speed ? `  (${speed}${acc})` : ""}`;
    }
  }
}

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

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    lastData = null;
    pollTimer = setInterval(() => {
      const data = readProgress();
      if (data) {
        ctx.ui.setWorkingMessage(formatProgress(data));
      }
    }, POLL_MS);
  });

  pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // Restore default working message
    ctx.ui.setWorkingMessage(undefined);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}
