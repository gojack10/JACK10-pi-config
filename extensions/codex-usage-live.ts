/**
 * Codex Usage Live Extension
 *
 * Shows ChatGPT/Codex quota headers in Pi's working indicator during Codex
 * calls. Uses the same progress-bar style as local-llm-generation.ts.
 *
 * Requires Codex responses to use SSE so HTTP response headers are available.
 * This machine's ~/.pi/agent/settings.json is set to { "transport": "sse" }.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const BAR_WIDTH = 10;
const CACHE_PATH = join(homedir(), ".pi", "agent", "codex-usage-cache.json");
const OBSERVABILITY_PATH = join(homedir(), ".pi", "agent", "codex-usage-observability.jsonl");

const PARTIAL_BLOCKS: Record<number, string> = {
	1: "▏",
	2: "▎",
	3: "▍",
	4: "▌",
	5: "▋",
	6: "▊",
	7: "▉",
};

interface LimitSnapshot {
	plan: string;
	activeLimit: string;
	primaryUsed: number | null;
	secondaryUsed: number | null;
	primaryWindow: string;
	secondaryWindow: string;
	primaryResetSeconds: number | null;
	secondaryResetSeconds: number | null;
	primaryResetAt: number | null;
	secondaryResetAt: number | null;
	creditsBalance: string | null;
	creditsHasCredits: boolean | null;
	creditsUnlimited: boolean | null;
	primaryOverSecondaryLimitPercent: number | null;
	status: number;
	capturedAtMs: number;
	rawHeaders?: Record<string, string>;
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers || {})) {
		out[key.toLowerCase()] = value;
	}
	return out;
}

function num(value: string | undefined): number | null {
	if (value == null || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: string | undefined): boolean | null {
	if (value == null || value === "") return null;
	if (/^true$/i.test(value)) return true;
	if (/^false$/i.test(value)) return false;
	return null;
}

function usageHeaders(headers: Record<string, string>): Record<string, string> {
	const h = lowerHeaders(headers);
	const interesting = new Set([
		"retry-after",
		"retry-after-ms",
		"x-request-id",
		"openai-processing-ms",
	]);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(h)) {
		if (key.startsWith("x-codex-") || interesting.has(key)) out[key] = value;
	}
	return out;
}

function getSnapshot(status: number, headers: Record<string, string>): LimitSnapshot | null {
	const h = lowerHeaders(headers);
	const rawHeaders = usageHeaders(headers);
	if (!h["x-codex-plan-type"] && !h["x-codex-primary-used-percent"] && !h["x-codex-secondary-used-percent"]) {
		return null;
	}
	return {
		status,
		plan: h["x-codex-plan-type"] || "?",
		activeLimit: h["x-codex-active-limit"] || "?",
		primaryUsed: num(h["x-codex-primary-used-percent"]),
		secondaryUsed: num(h["x-codex-secondary-used-percent"]),
		primaryWindow: h["x-codex-primary-window-minutes"] || "?",
		secondaryWindow: h["x-codex-secondary-window-minutes"] || "?",
		primaryResetSeconds: num(h["x-codex-primary-reset-after-seconds"]),
		secondaryResetSeconds: num(h["x-codex-secondary-reset-after-seconds"]),
		primaryResetAt: num(h["x-codex-primary-reset-at"]),
		secondaryResetAt: num(h["x-codex-secondary-reset-at"]),
		creditsBalance: h["x-codex-credits-balance"] ?? null,
		creditsHasCredits: bool(h["x-codex-credits-has-credits"]),
		creditsUnlimited: bool(h["x-codex-credits-unlimited"]),
		primaryOverSecondaryLimitPercent: num(h["x-codex-primary-over-secondary-limit-percent"]),
		capturedAtMs: Date.now(),
		rawHeaders,
	};
}

function buildBarPercent(percent: number): string {
	const pct = Math.max(0, Math.min(percent, 100)) / 100;
	const eighths = Math.round(pct * BAR_WIDTH * 8);
	const full = Math.floor(eighths / 8);
	const rem = eighths % 8;
	const empty = BAR_WIDTH - full - (rem > 0 ? 1 : 0);
	return "█".repeat(full) + (rem > 0 ? PARTIAL_BLOCKS[rem] : "") + "░".repeat(empty);
}

function remainingFromUsed(used: number | null): number | null {
	if (used == null) return null;
	return Math.max(0, Math.min(100, 100 - used));
}

function liveResetSeconds(snapshot: LimitSnapshot, seconds: number | null, resetAt: number | null): number | null {
	// Prefer absolute server reset epoch. Relative reset-after values can jitter
	// between responses; reset-at is stable and keeps the display monotonic.
	if (resetAt != null && resetAt > 0) {
		return Math.max(0, Math.ceil(resetAt - Date.now() / 1000));
	}
	if (seconds == null || seconds < 0) return null;
	const capturedAtMs = snapshot.capturedAtMs || Date.now();
	const elapsed = Math.max(0, Math.floor((Date.now() - capturedAtMs) / 1000));
	return Math.max(0, seconds - elapsed);
}

function formatResetClock(seconds: number | null): string {
	if (seconds == null || seconds < 0) return "??:??:??";
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatLimit(
	label: string,
	used: number | null,
	resetSeconds: number | null,
	resetAt: number | null,
	snapshot: LimitSnapshot,
): string {
	const remaining = remainingFromUsed(used);
	if (remaining == null) return `${label} ${buildBarPercent(0)} ? left / RESET ??:??:??`;
	return `${label} ${buildBarPercent(remaining)} ${Math.round(remaining)}% left / RESET ${formatResetClock(liveResetSeconds(snapshot, resetSeconds, resetAt))}`;
}

function isCodexProvider(provider: string | undefined): boolean {
	return !!provider?.startsWith("openai-codex");
}

function providerLabel(provider: string, snapshot: LimitSnapshot): string {
	if (provider === "openai-codex-alt") return "Codex Alt EDU";
	if (provider === "openai-codex-team") return "Codex Team";
	if (provider === "openai-codex") return `Codex ${snapshot.plan.toUpperCase()}`;
	return `Codex ${snapshot.plan.toUpperCase()}`;
}

function formatSnapshot(provider: string, snapshot: LimitSnapshot): string {
	const limited = snapshot.status === 429 ? " LIMIT" : "";
	const hasCreditHeaders =
		snapshot.creditsBalance != null || snapshot.creditsHasCredits != null || snapshot.creditsUnlimited != null;
	const hasWindowLimits = snapshot.primaryWindow !== "0" || snapshot.secondaryWindow !== "0";
	if (hasCreditHeaders && !hasWindowLimits) {
		const balance = snapshot.creditsBalance ?? "?";
		const hasCredits = snapshot.creditsHasCredits == null ? "?" : snapshot.creditsHasCredits ? "yes" : "no";
		const unlimited = snapshot.creditsUnlimited == null ? "?" : snapshot.creditsUnlimited ? "yes" : "no";
		return `${providerLabel(provider, snapshot)}${limited} | ${snapshot.plan.toUpperCase()} ${snapshot.activeLimit} | CREDITS ${balance} / HAS ${hasCredits} / UNLIMITED ${unlimited}`;
	}
	return `${providerLabel(provider, snapshot)}${limited} | ${formatLimit(
		"DAILY",
		snapshot.primaryUsed,
		snapshot.primaryResetSeconds,
		snapshot.primaryResetAt,
		snapshot,
	)} | ${formatLimit("WEEKLY", snapshot.secondaryUsed, snapshot.secondaryResetSeconds, snapshot.secondaryResetAt, snapshot)}`;
}

function readCache(): Record<string, LimitSnapshot> {
	if (!existsSync(CACHE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, LimitSnapshot>;
	} catch {
		return {};
	}
}

function writeCache(snapshots: Map<string, LimitSnapshot>): void {
	try {
		writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(snapshots), null, 2), "utf-8");
	} catch {
		// Best-effort cache only.
	}
}

function appendObservability(provider: string, status: number, headers: Record<string, string>, snapshot: LimitSnapshot | null): void {
	appendObservabilityRecord({
		kind: "http_response",
		provider,
		status,
		headers: usageHeaders(headers),
		snapshot,
	});
}

function appendObservabilityRecord(record: Record<string, unknown>): void {
	try {
		appendFileSync(
			OBSERVABILITY_PATH,
			`${JSON.stringify({ capturedAt: new Date().toISOString(), ...record })}\n`,
			"utf-8",
		);
	} catch {
		// Best-effort observability only.
	}
}

export default function codexUsageLive(pi: ExtensionAPI) {
	const snapshots = new Map<string, LimitSnapshot>(Object.entries(readCache()));
	let showingProvider: string | undefined;
	let showingCtx: ExtensionContext | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;

	function stopTicker(): void {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	}

	function clearDisplay(ctx: ExtensionContext): void {
		stopTicker();
		ctx.ui.setWidget("codex-usage-live", undefined);
		showingProvider = undefined;
		showingCtx = undefined;
	}

	function showIfCached(ctx: ExtensionContext, provider: string | undefined): boolean {
		if (!isCodexProvider(provider)) {
			if (showingProvider) clearDisplay(ctx);
			return false;
		}

		if (!snapshots.has(provider!)) {
			for (const [cachedProvider, cachedSnapshot] of Object.entries(readCache())) {
				snapshots.set(cachedProvider, cachedSnapshot);
			}
		}

		const snapshot = snapshots.get(provider!);
		if (!snapshot) return false;
		const line = formatSnapshot(provider!, snapshot);
		ctx.ui.setWidget(
			"codex-usage-live",
			(_tui, thm) => new Text(thm.fg("dim", line), 0, 0),
			{ placement: "belowEditor" },
		);
		showingProvider = provider;
		showingCtx = ctx;
		if (!tickTimer) {
			// Render 4x/sec so terminal/event-loop jitter is less visible while the
			// clock itself still changes only at whole-second boundaries.
			tickTimer = setInterval(() => {
				if (!showingProvider || !showingCtx) return;
				showIfCached(showingCtx, showingProvider);
			}, 250);
		}
		return true;
	}

	pi.on("after_provider_response", async (event, ctx) => {
		const provider = ctx.model?.provider || "";
		if (!isCodexProvider(provider)) return;
		const snapshot = getSnapshot(event.status, event.headers);
		appendObservability(provider, event.status, event.headers, snapshot);
		if (!snapshot) return;
		snapshots.set(provider, snapshot);
		writeCache(snapshots);
		showIfCached(ctx, provider);
	});

	pi.on("message_end", async (event, ctx) => {
		const provider = (event.message as { provider?: string }).provider || ctx.model?.provider || "";
		if (!isCodexProvider(provider) || event.message.role !== "assistant") return;
		const message = event.message as {
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
		};
		appendObservabilityRecord({
			kind: "assistant_end",
			provider,
			model: message.model,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			usage: message.usage
				? {
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
						totalTokens: message.usage.totalTokens,
					}
				: undefined,
		});
	});

	pi.on("model_select", async (event, ctx) => {
		showIfCached(ctx, event.model?.provider);
	});

	pi.on("session_start", async (_event, ctx) => {
		showIfCached(ctx, ctx.model?.provider);
	});

	pi.on("agent_start", async (_event, ctx) => {
		showIfCached(ctx, ctx.model?.provider);
	});

	pi.on("agent_end", async (_event, ctx) => {
		showIfCached(ctx, ctx.model?.provider);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearDisplay(ctx);
	});
}
