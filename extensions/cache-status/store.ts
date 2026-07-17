import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type CacheLifetime,
	getCacheObservations,
	getCacheTimerColor,
	getCacheTimerDurationMs,
	getCacheTimerRemainingMs,
	getCurrentRunUsage,
	getLatestReportedCacheLifetime,
	getModelCacheLifetime,
	getRequestCacheLifetime,
	getSessionUsage,
} from "../context-session-footer/session-usage.ts";

export type CacheResult =
	| "CHECKING"
	| "REUSED"
	| "REBUILT"
	| "CREATED"
	| "NO CACHE";

export type CacheStatusRow = {
	provider: string;
	model: string;
	remainingMs: number;
	durationMs: number | undefined;
	lastSeenAt: number;
	result: CacheResult;
	cacheRead?: number;
	cacheWrite?: number;
	flashUntil?: number;
};

type LiveCacheState = {
	provider: string;
	model: string;
	requestedAt: number;
	lifetime: CacheLifetime;
	hadCache: boolean;
	refreshesOnRead: boolean;
	result: CacheResult;
	startsAt?: number;
	cacheRead?: number;
	cacheWrite?: number;
	flashUntil?: number;
};

export type PaneCacheEntry = {
	provider: string;
	model: string;
	result: CacheResult;
	expiresAt?: number;
	durationMs?: number;
	lastSeenAt: number;
};

export type PaneCacheSnapshot = {
	version: 1;
	updatedAt: number;
	entries: PaneCacheEntry[];
	contextTokens: number;
	contextWindow: number;
	contextPercent: number;
	runCost: number;
	totalCost: number;
	busyStartedAt?: number;
	agentDone: boolean;
};

type PaneRecord = PaneCacheSnapshot & { paneId: string; windowId: string };

type CacheSelection = {
	entry?: PaneCacheEntry;
	additionalWarm: number;
};

type GroupSummary = {
	selection: CacheSelection;
	contextPercent: number | undefined;
	totalCost: number;
	busyStartedAt?: number;
	agentDone: boolean;
};

type TmuxExec = (args: string[]) => Promise<{ stdout: string; code: number }>;

type TmuxNotice = (message: string) => Promise<void>;

const CACHE_FLASH_MS = 3000;
const STALE_RUNTIME_MS = 3000;
const modelKey = (provider: string | undefined, model: string | undefined) =>
	`${provider}/${model}`;

const formatTokens = (count: number): string => {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

export const formatHubTimer = (milliseconds: number): string => {
	const total = Math.max(0, Math.ceil(milliseconds / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const formatBusyDuration = (milliseconds: number): string => {
	const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
	if (totalMinutes < 1) return "<1m";
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
};

const fit = (value: string, width: number, left = false): string => {
	const clipped = value.slice(0, width);
	return left ? clipped.padEnd(width) : clipped.padStart(width);
};

const tmuxText = (value: string): string => value.replaceAll("#[", "[");
const color = (name: "green" | "yellow" | "red" | "white", value: string) =>
	`#[fg=${name}]${value}#[default]`;

const statusLabel = (entry: PaneCacheEntry | undefined, now: number): string => {
	if (!entry) return "NO CACHE";
	if (entry.expiresAt !== undefined && entry.expiresAt <= now)
		return "CACHE EXPIRED";
	return entry.result === "NO CACHE" ? "NO CACHE" : `CACHE ${entry.result}`;
};

const selectionFor = (
	snapshots: readonly PaneCacheSnapshot[],
	now: number,
): CacheSelection => {
	const entries = snapshots.flatMap((snapshot) => snapshot.entries);
	const warm = entries
		.filter((entry) => (entry.expiresAt ?? 0) > now)
		.sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
	if (warm.length > 0)
		return { entry: warm[0], additionalWarm: warm.length - 1 };

	const fallback = [...entries].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
	return { entry: fallback, additionalWarm: 0 };
};

const timerFor = (entry: PaneCacheEntry | undefined, now: number): string => {
	if (!entry || entry.expiresAt === undefined || entry.expiresAt <= now)
		return fit("-", 8);
	return fit(formatHubTimer(entry.expiresAt - now), 8);
};

const timerColor = (
	entry: PaneCacheEntry | undefined,
	now: number,
): "green" | "yellow" | "red" | "white" => {
	if (!entry || entry.expiresAt === undefined || entry.expiresAt <= now)
		return "white";
	const remainingMs = entry.expiresAt - now;
	const cacheColor = getCacheTimerColor(remainingMs, entry.durationMs);
	return cacheColor === "error"
		? "red"
		: cacheColor === "warning"
			? "yellow"
			: "green";
};

const formatCache = (
	selection: CacheSelection,
	now: number,
): string => {
	const { entry, additionalWarm } = selection;
	if (!entry) return "NO CACHE";
	const model = `${tmuxText(entry.model)}${additionalWarm > 0 ? ` +${additionalWarm}` : ""}`;
	return `${color(timerColor(entry, now), timerFor(entry, now))}  ${fit(model, 16, true)} ${fit(statusLabel(entry, now), 14, true)}`;
};

const formatContext = (snapshot: PaneCacheSnapshot): string => {
	if (snapshot.contextWindow <= 0) return "CTX -";
	return `CTX ${fit(formatTokens(snapshot.contextTokens), 5)}/${fit(formatTokens(snapshot.contextWindow), 5, true)} ${fit(`${Math.round(snapshot.contextPercent)}%`, 4)}`;
};

const runtimeState = (
	snapshots: readonly PaneCacheSnapshot[],
	now: number,
): string | undefined => {
	const live = snapshots.filter(
		(snapshot) => now - snapshot.updatedAt <= STALE_RUNTIME_MS,
	);
	const busy = live
		.map((snapshot) => snapshot.busyStartedAt)
		.filter((startedAt): startedAt is number => startedAt !== undefined)
		.sort((a, b) => a - b)[0];
	if (busy !== undefined) return color("yellow", `BUSY ${formatBusyDuration(now - busy)}`);
	return live.some((snapshot) => snapshot.agentDone)
		? color("green", "AGENT DONE")
		: undefined;
};

const summarize = (
	snapshots: readonly PaneCacheSnapshot[],
	now: number,
): GroupSummary => {
	const live = snapshots.filter(
		(snapshot) => now - snapshot.updatedAt <= STALE_RUNTIME_MS,
	);
	const contextPercent = live.length
		? Math.max(...live.map((snapshot) => snapshot.contextPercent))
		: undefined;
	const busyStartedAt = live
		.map((snapshot) => snapshot.busyStartedAt)
		.filter((startedAt): startedAt is number => startedAt !== undefined)
		.sort((a, b) => a - b)[0];
	return {
		selection: selectionFor(snapshots, now),
		contextPercent,
		totalCost: snapshots.reduce((total, snapshot) => total + snapshot.totalCost, 0),
		busyStartedAt,
		agentDone:
			busyStartedAt === undefined && live.some((snapshot) => snapshot.agentDone),
	};
};

export const formatPaneCacheStatus = (
	snapshot: PaneCacheSnapshot,
	now: number = Date.now(),
): string => {
	const state = runtimeState([snapshot], now);
	return [
		formatCache(selectionFor([snapshot], now), now),
		formatContext(snapshot),
		`RUN $${snapshot.runCost.toFixed(2)} TOTAL $${snapshot.totalCost.toFixed(2)}`,
		state,
	]
		.filter((value): value is string => Boolean(value))
		.join(" | ");
};

export const formatGroupCacheStatus = (
	snapshots: readonly PaneCacheSnapshot[],
	now: number = Date.now(),
): string => {
	const summary = summarize(snapshots, now);
	const state = runtimeState(snapshots, now);
	return [
		formatCache(summary.selection, now),
		summary.contextPercent === undefined
			? undefined
			: `CTX ${fit(`${Math.round(summary.contextPercent)}%`, 4)}`,
		`$ ${summary.totalCost.toFixed(2)}`,
		state,
	]
		.filter((value): value is string => Boolean(value))
		.join(" | ");
};

const encodeSnapshot = (snapshot: PaneCacheSnapshot): string =>
	Buffer.from(JSON.stringify(snapshot)).toString("base64url");

const decodeSnapshot = (value: string): PaneCacheSnapshot | undefined => {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PaneCacheSnapshot>;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return undefined;
		return parsed as PaneCacheSnapshot;
	} catch {
		return undefined;
	}
};

const option = async (exec: TmuxExec, args: string[]): Promise<void> => {
	await exec(["set-option", "-q", ...args]);
};

const getSessionId = async (
	exec: TmuxExec,
	paneId: string,
): Promise<string | undefined> => {
	const result = await exec([
		"display-message",
		"-p",
		"-t",
		paneId,
		"#{session_id}",
	]);
	return result.code === 0 ? result.stdout.trim() || undefined : undefined;
};

const getPaneRecords = async (
	exec: TmuxExec,
	sessionId: string,
): Promise<PaneRecord[]> => {
	const result = await exec([
		"list-panes",
		"-a",
		"-t",
		sessionId,
		"-F",
		"#{window_id}|#{pane_id}|#{@pi_cache_data}",
	]);
	if (result.code !== 0) return [];
	return result.stdout
		.trimEnd()
		.split("\n")
		.flatMap((line) => {
			const [windowId, paneId, encoded] = line.split("|", 3);
			const snapshot = encoded ? decodeSnapshot(encoded) : undefined;
			return snapshot && windowId && paneId
				? [{ ...snapshot, paneId, windowId }]
				: [];
		});
};

const clearSessionOptions = async (exec: TmuxExec, sessionId: string) => {
	for (const name of [
		"@pi_cache",
		"@pi_cache_expiry",
		"@pi_cache_duration",
		"@pi_cache_model",
	]) {
		await exec(["set-option", "-q", "-u", "-t", sessionId, name]);
	}
};

const publishAggregates = async (
	exec: TmuxExec,
	sessionId: string,
	now: number,
): Promise<CacheSelection | undefined> => {
	const records = await getPaneRecords(exec, sessionId);
	if (records.length === 0) {
		await clearSessionOptions(exec, sessionId);
		return undefined;
	}

	const byWindow = new Map<string, PaneCacheSnapshot[]>();
	for (const record of records) {
		const snapshots = byWindow.get(record.windowId) ?? [];
		snapshots.push(record);
		byWindow.set(record.windowId, snapshots);
	}
	for (const [windowId, snapshots] of byWindow) {
		await option(exec, ["-w", "-t", windowId, "@pi_cache", formatGroupCacheStatus(snapshots, now)]);
	}

	const snapshots = records.map(({ paneId: _paneId, windowId: _windowId, ...snapshot }) => snapshot);
	const summary = summarize(snapshots, now);
	await option(exec, ["-t", sessionId, "@pi_cache", formatGroupCacheStatus(snapshots, now)]);
	await option(exec, [
		"-t",
		sessionId,
		"@pi_cache_expiry",
		String(Math.floor((summary.selection.entry?.expiresAt ?? 0) / 1000)),
	]);
	await option(exec, [
		"-t",
		sessionId,
		"@pi_cache_duration",
		String(Math.ceil((summary.selection.entry?.durationMs ?? 0) / 1000)),
	]);
	await option(exec, [
		"-t",
		sessionId,
		"@pi_cache_model",
		tmuxText(summary.selection.entry?.model ?? ""),
	]);
	return summary.selection;
};

export class CacheStatus {
	private ctx: ExtensionContext | undefined;
	private readonly observedLifetimes = new Map<string, CacheLifetime>();
	private readonly liveCacheStates = new Map<string, LiveCacheState>();
	private busyStartedAt: number | undefined;
	private agentDone = false;
	private readonly thresholds = new Map<string, "normal" | "warning" | "error">();

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.observedLifetimes.clear();
		this.liveCacheStates.clear();
		this.busyStartedAt = undefined;
		this.agentDone = ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && entry.message?.role === "assistant");
		this.thresholds.clear();
		for (const row of this.getRows()) this.rememberThreshold(row);
	}

	stop(): void {
		this.ctx = undefined;
		this.busyStartedAt = undefined;
	}

	request(payload: unknown, ctx: ExtensionContext): void {
		if (!ctx.model) return;
		const fallback = getModelCacheLifetime(
			ctx.model,
			process.env.PI_CACHE_RETENTION === "long",
		);
		const lifetime = getRequestCacheLifetime(payload, fallback);
		const key = modelKey(ctx.model.provider, ctx.model.id);
		this.observedLifetimes.set(key, lifetime);
		this.liveCacheStates.set(key, {
			provider: ctx.model.provider,
			model: ctx.model.id,
			requestedAt: Date.now(),
			lifetime,
			hadCache: getCacheObservations(
				ctx.sessionManager.getBranch(),
				ctx.sessionManager.getHeader()?.timestamp ?? "",
			).some(
				(observation) =>
					observation.provider === ctx.model?.provider &&
					observation.model === ctx.model?.id,
			),
			refreshesOnRead: ctx.model.api === "anthropic-messages",
			result: "CHECKING",
		});
	}

	updateMessage(message: unknown, final: boolean): void {
		if (!message || typeof message !== "object") return;
		const assistant = message as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: { cacheRead?: number; cacheWrite?: number };
		};
		if (assistant.role !== "assistant") return;
		const state = this.liveCacheStates.get(
			modelKey(assistant.provider, assistant.model),
		);
		if (!state) return;
		const cacheRead = Number(assistant.usage?.cacheRead) || 0;
		const cacheWrite = Number(assistant.usage?.cacheWrite) || 0;
		if (cacheRead > (state.cacheRead ?? 0) || cacheWrite > (state.cacheWrite ?? 0)) {
			state.flashUntil = Date.now() + CACHE_FLASH_MS;
		}
		if (cacheRead > 0 || cacheWrite > 0 || final) {
			state.cacheRead = cacheRead;
			state.cacheWrite = cacheWrite;
		}
		if (cacheRead > 0) {
			state.result = "REUSED";
			if (cacheWrite > 0 || state.refreshesOnRead) state.startsAt = state.requestedAt;
		} else if (cacheWrite > 0) {
			state.result = state.hadCache ? "REBUILT" : "CREATED";
			state.startsAt = state.requestedAt;
		} else if (final) {
			state.result = "NO CACHE";
		}
	}

	agentStart(): void {
		this.busyStartedAt = Date.now();
		this.agentDone = false;
	}

	agentSettled(): void {
		this.busyStartedAt = undefined;
		this.agentDone = true;
	}

	getRows(now: number = Date.now()): CacheStatusRow[] {
		const ctx = this.ctx;
		if (!ctx) return [];
		const sessionStartedAt = ctx.sessionManager.getHeader()?.timestamp ?? "";
		const branchEntries = ctx.sessionManager.getBranch();
		const rows: CacheStatusRow[] = getCacheObservations(
			branchEntries,
			sessionStartedAt,
		).map((observation) => {
			const fallbackLifetime =
				this.observedLifetimes.get(modelKey(observation.provider, observation.model)) ??
				getModelCacheLifetime(
					ctx.modelRegistry.find(observation.provider, observation.model),
					process.env.PI_CACHE_RETENTION === "long",
				);
			const lifetime = getLatestReportedCacheLifetime(
				branchEntries,
				observation.provider,
				observation.model,
				fallbackLifetime,
			);
			return {
				provider: observation.provider,
				model: observation.model,
				remainingMs: getCacheTimerRemainingMs(lifetime, observation, now),
				durationMs: getCacheTimerDurationMs(lifetime, observation),
				lastSeenAt: observation.latestCacheAt,
				cacheRead: observation.latestCacheRead,
				cacheWrite: observation.latestCacheWrite,
				result:
					observation.latestCacheRead > 0
						? "REUSED"
						: observation.latestCacheWrite > 0
							? observation.hadPriorCache
								? "REBUILT"
								: "CREATED"
							: "NO CACHE",
			};
		});

		for (const state of this.liveCacheStates.values()) {
			const index = rows.findIndex(
				(row) => row.provider === state.provider && row.model === state.model,
			);
			const existing = rows[index];
			const durationMs = state.startsAt
				? state.lifetime.minTtlMs ?? undefined
				: existing?.durationMs;
			const row: CacheStatusRow = {
				provider: state.provider,
				model: state.model,
				remainingMs:
					state.startsAt && durationMs !== undefined
						? Math.max(0, state.startsAt + durationMs - now)
						: (existing?.remainingMs ?? 0),
				durationMs,
				lastSeenAt: state.requestedAt,
				result: state.result,
				cacheRead: state.cacheRead,
				cacheWrite: state.cacheWrite,
				flashUntil: state.flashUntil,
			};
			if (index === -1) rows.push(row);
			else rows[index] = row;
		}

		return rows.sort((a, b) => {
			if (a.result === "CHECKING" !== (b.result === "CHECKING"))
				return a.result === "CHECKING" ? -1 : 1;
			if (a.remainingMs > 0 !== b.remainingMs > 0)
				return a.remainingMs > 0 ? -1 : 1;
			return a.remainingMs > 0
				? a.remainingMs - b.remainingMs
				: b.lastSeenAt - a.lastSeenAt;
		});
	}

	getSnapshot(now: number = Date.now()): PaneCacheSnapshot | undefined {
		const ctx = this.ctx;
		if (!ctx) return undefined;
		const sessionStartedAt = ctx.sessionManager.getHeader()?.timestamp ?? "";
		const context = ctx.getContextUsage();
		const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const entries = this.getRows(now).map((row) => ({
			provider: row.provider,
			model: row.model,
			result: row.result,
			expiresAt:
				row.durationMs !== undefined && row.remainingMs > 0
					? now + row.remainingMs
					: undefined,
			durationMs: row.durationMs,
			lastSeenAt: row.lastSeenAt,
		}));
		return {
			version: 1,
			updatedAt: now,
			entries,
			contextTokens: context?.tokens ?? 0,
			contextWindow,
			contextPercent: context?.percent ?? 0,
			runCost: getCurrentRunUsage(ctx.sessionManager.getBranch(), sessionStartedAt).cost,
			totalCost: getSessionUsage(ctx.sessionManager.getEntries(), sessionStartedAt).cost,
			...(this.busyStartedAt === undefined ? {} : { busyStartedAt: this.busyStartedAt }),
			agentDone: this.agentDone,
		};
	}

	async publish(exec: TmuxExec, paneId: string): Promise<void> {
		const snapshot = this.getSnapshot();
		if (!snapshot) return;
		await option(exec, ["-p", "-t", paneId, "@pi_cache_data", encodeSnapshot(snapshot)]);
		await option(exec, ["-p", "-t", paneId, "@pi_cache", formatPaneCacheStatus(snapshot)]);
		const sessionId = await getSessionId(exec, paneId);
		if (sessionId) await publishAggregates(exec, sessionId, Date.now());
	}

	async clear(exec: TmuxExec, paneId: string): Promise<void> {
		await exec(["set-option", "-q", "-u", "-p", "-t", paneId, "@pi_cache_data"]);
		await exec(["set-option", "-q", "-u", "-p", "-t", paneId, "@pi_cache"]);
		const sessionId = await getSessionId(exec, paneId);
		if (sessionId) await publishAggregates(exec, sessionId, Date.now());
	}

	hasActiveFlash(now: number = Date.now()): boolean {
		return [...this.liveCacheStates.values()].some(
			(state) => (state.flashUntil ?? 0) > now,
		);
	}

	cacheWarnings(): CacheStatusRow[] {
		const warnings: CacheStatusRow[] = [];
		for (const row of this.getRows()) {
			const next = this.thresholdFor(row);
			const key = modelKey(row.provider, row.model);
			const previous = this.thresholds.get(key);
			this.thresholds.set(key, next);
			if ((next === "warning" || next === "error") && previous !== next)
				warnings.push(row);
		}
		return warnings;
	}

	private thresholdFor(row: CacheStatusRow): "normal" | "warning" | "error" {
		const timerColor = getCacheTimerColor(row.remainingMs, row.durationMs);
		return timerColor === "error"
			? "error"
			: timerColor === "warning"
				? "warning"
				: "normal";
	}

	private rememberThreshold(row: CacheStatusRow): void {
		this.thresholds.set(modelKey(row.provider, row.model), this.thresholdFor(row));
	}
}

export const cacheStatus = new CacheStatus();

export const tmuxNotice = async (
	exec: TmuxExec,
	paneId: string,
	message: string,
): Promise<void> => {
	const sessionId = await getSessionId(exec, paneId);
	if (!sessionId) return;
	const sessions = await exec(["list-sessions", "-F", "#{session_id}|#{session_name}"]);
	if (sessions.code !== 0) return;
	const rows = sessions.stdout
		.trimEnd()
		.split("\n")
		.map((line) => line.split("|", 2))
		.filter(([id, name]) => id && name)
		.sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
	const index = rows.findIndex(([id]) => id === sessionId);
	const name = rows[index]?.[1] ?? sessionId;
	await exec([
		"display-message",
		"-d",
		"5000",
		"-t",
		paneId,
		`[pi] (${index >= 0 ? index : "?"}) ${name}: ${message}`,
	]);
};
