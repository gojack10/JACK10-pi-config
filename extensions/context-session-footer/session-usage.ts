export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type UsageEntry = {
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		timestamp?: number;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
		promptCache?: { retention?: string; ttl?: string };
	};
};

const resetTypes = new Set([
	"compaction",
	"model_change",
	"thinking_level_change",
]);
const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const EXTENDED_OPENAI_MODELS = new Set([
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat-latest",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
]);

export type CacheLifetime = {
	minTtlMs: number | null;
	maxTtlMs: number | null;
	typicalTtlMs?: [number, number];
	label: string;
};

type CacheModel = {
	api?: string;
	provider?: string;
	id?: string;
	baseUrl?: string;
	compat?: {
		cacheControlFormat?: string;
		supportsLongCacheRetention?: boolean;
	};
};

type UnknownRecord = Record<string, unknown>;

const exactLifetime = (ttlMs: number, label: string): CacheLifetime => ({
	minTtlMs: ttlMs,
	maxTtlMs: ttlMs,
	label,
});
const unknownLifetime = (): CacheLifetime => ({
	minTtlMs: null,
	maxTtlMs: null,
	label: "TTL ?",
});
const openAI56Lifetime = (inferred = false): CacheLifetime => ({
	minTtlMs: THIRTY_MINUTES,
	maxTtlMs: ONE_DAY,
	label: inferred ? "30m–24h*" : "30m–24h",
});
const openAIInMemoryLifetime = (): CacheLifetime => ({
	minTtlMs: null,
	maxTtlMs: ONE_HOUR,
	typicalTtlMs: [FIVE_MINUTES, TEN_MINUTES],
	label: "typ 5–10m; max 1h",
});

const asRecord = (value: unknown): UnknownRecord | undefined =>
	typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;

const markerLifetime = (value: unknown): CacheLifetime | undefined => {
	const marker = asRecord(value);
	if (!marker) return undefined;
	const ttl = marker.ttl;
	return ttl === "1h" || ttl === "ONE_HOUR"
		? exactLifetime(ONE_HOUR, "1h")
		: exactLifetime(FIVE_MINUTES, "5m");
};

const lifetimeInBlocks = (value: unknown): CacheLifetime | undefined => {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		const block = asRecord(item);
		if (!block) continue;
		const lifetime =
			markerLifetime(block.cache_control) ?? markerLifetime(block.cachePoint);
		if (lifetime) return lifetime;
	}
	return undefined;
};

/** Infer only cache metadata; message text and tool arguments are never inspected. */
export const getRequestCacheLifetime = (
	payload: unknown,
	fallback: CacheLifetime,
): CacheLifetime => {
	const body = asRecord(payload);
	if (!body) return fallback;

	const topLevelMarker =
		markerLifetime(body.cache_control) ??
		lifetimeInBlocks(body.system) ??
		lifetimeInBlocks(body.tools);
	if (topLevelMarker) return topLevelMarker;

	if (Array.isArray(body.messages)) {
		for (const item of body.messages) {
			const message = asRecord(item);
			const lifetime = lifetimeInBlocks(message?.content);
			if (lifetime) return lifetime;
		}
	}

	const options = asRecord(body.prompt_cache_options);
	if (options?.ttl === "30m") return openAI56Lifetime();
	// GPT-5.6 deprecated prompt_cache_retention in favor of its 30m-minimum TTL.
	if (fallback.minTtlMs === THIRTY_MINUTES && fallback.maxTtlMs === ONE_DAY)
		return fallback;
	if (body.prompt_cache_retention === "24h") {
		return { minTtlMs: null, maxTtlMs: ONE_DAY, label: "max 24h" };
	}
	if (
		body.prompt_cache_retention === "in_memory" ||
		body.prompt_cache_retention === "in-memory"
	) {
		return openAIInMemoryLifetime();
	}
	return fallback;
};

export const getReportedCacheLifetime = (
	promptCache: { retention?: string; ttl?: string } | undefined,
	fallback: CacheLifetime,
): CacheLifetime => {
	if (!promptCache) return fallback;
	if (promptCache.ttl === "30m") return openAI56Lifetime();
	if (promptCache.retention === "24h") {
		return { minTtlMs: null, maxTtlMs: ONE_DAY, label: "max 24h" };
	}
	if (
		promptCache.retention === "in_memory" ||
		promptCache.retention === "in-memory"
	) {
		return openAIInMemoryLifetime();
	}
	return fallback;
};

export const getLatestReportedCacheLifetime = (
	entries: UsageEntry[],
	provider: string,
	model: string,
	fallback: CacheLifetime,
): CacheLifetime => {
	for (let index = entries.length - 1; index >= 0; index--) {
		const message = entries[index].message;
		if (
			message?.role === "assistant" &&
			message.provider === provider &&
			message.model === model &&
			message.promptCache
		) {
			return getReportedCacheLifetime(message.promptCache, fallback);
		}
	}
	return fallback;
};

export const getModelCacheLifetime = (
	model: CacheModel | undefined,
	longRetention: boolean,
): CacheLifetime => {
	if (!model) return unknownLifetime();
	if (
		model.api === "anthropic-messages" ||
		model.compat?.cacheControlFormat === "anthropic"
	) {
		return longRetention && model.compat?.supportsLongCacheRetention !== false
			? exactLifetime(ONE_HOUR, "1h")
			: exactLifetime(FIVE_MINUTES, "5m");
	}
	if (
		model.api === "bedrock-converse-stream" &&
		/claude/i.test(`${model.id} ${model.provider}`)
	) {
		return longRetention
			? exactLifetime(ONE_HOUR, "1h")
			: exactLifetime(FIVE_MINUTES, "5m");
	}

	const id = model.id ?? "";
	const isOpenAI56 = /^gpt-5\.6(?:-|$)/.test(id);
	const isDirectOpenAI =
		(model.api === "openai-responses" || model.api === "openai-completions") &&
		(model.provider === "openai" ||
			/^https:\/\/api\.openai\.com\//.test(model.baseUrl ?? ""));
	if (isOpenAI56 && isDirectOpenAI) {
		return openAI56Lifetime();
	}
	if (isOpenAI56 && model.api === "openai-codex-responses") {
		// The ChatGPT Codex backend sends the same cache key but has no public TTL contract.
		return openAI56Lifetime(true);
	}

	if (isDirectOpenAI) {
		if (longRetention || /^gpt-5\.5(?:-|$)/.test(id)) {
			return { minTtlMs: null, maxTtlMs: ONE_DAY, label: "max 24h" };
		}
		const undatedId = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
		if (EXTENDED_OPENAI_MODELS.has(undatedId)) {
			return {
				minTtlMs: null,
				maxTtlMs: ONE_DAY,
				typicalTtlMs: [FIVE_MINUTES, TEN_MINUTES],
				label: "5–10m…24h policy",
			};
		}
		return openAIInMemoryLifetime();
	}

	if (
		longRetention &&
		model.api === "openai-completions" &&
		model.compat?.supportsLongCacheRetention !== false
	) {
		return { minTtlMs: null, maxTtlMs: ONE_DAY, label: "max 24h requested" };
	}
	return unknownLifetime();
};

export const getLastModelRequestAt = (
	entries: UsageEntry[],
	provider: string,
	model: string,
	sessionStartedAt?: string,
): number | undefined => {
	let latestRequestAt: number | undefined;
	const startedAt = Date.parse(sessionStartedAt ?? "");
	const requiresReportedWrite =
		/^gpt-5\.6(?:-|$)/.test(model) && !provider.startsWith("openai-codex");
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry.type !== "message" ||
			entry.message?.role !== "assistant" ||
			entry.message.provider !== provider ||
			entry.message.model !== model
		) {
			continue;
		}
		const timestamp =
			entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
		if (
			!Number.isFinite(timestamp) ||
			(Number.isFinite(startedAt) && timestamp < startedAt)
		)
			continue;
		latestRequestAt ??= timestamp;
		// Direct GPT-5.6 reports writes, whose timestamp starts the minimum TTL. Codex currently omits that count.
		if (
			!requiresReportedWrite ||
			numberOrZero(entry.message.usage?.cacheWrite) > 0
		)
			return timestamp;
	}
	return requiresReportedWrite ? undefined : latestRequestAt;
};

const formatDuration = (milliseconds: number, roundUp: boolean): string => {
	const seconds = milliseconds / 1000;
	if (seconds < 60)
		return `${Math.max(roundUp ? 1 : 0, roundUp ? Math.ceil(seconds) : Math.floor(seconds))}s`;
	const minutes = seconds / 60;
	if (minutes < 60)
		return `${Math.max(1, roundUp ? Math.ceil(minutes) : Math.floor(minutes))}m`;
	const hours = minutes / 60;
	return `${Math.max(1, roundUp ? Math.ceil(hours) : Math.floor(hours))}h`;
};

export const getCacheFooterStatus = (
	lifetime: CacheLifetime,
	lastRequestAt: number | undefined,
	now: number = Date.now(),
): string => {
	const prefix = lifetime.label.endsWith("*") ? "CACHE*:" : "CACHE:";
	if (lastRequestAt === undefined)
		return `${prefix} unseeded / ${lifetime.label}`;
	const age = Math.max(0, now - lastRequestAt);
	const { minTtlMs, maxTtlMs } = lifetime;
	if (minTtlMs === null && maxTtlMs === null)
		return `${prefix} age ${formatDuration(age, false)} / TTL ?`;

	if (minTtlMs !== null && minTtlMs === maxTtlMs) {
		const remaining = minTtlMs - age;
		return remaining > 0
			? `${prefix} ≤${formatDuration(remaining, true)}/${lifetime.label}`
			: `${prefix} expired +${formatDuration(-remaining, false)} (${lifetime.label})`;
	}
	if (minTtlMs !== null && age < minTtlMs) {
		const maxLabel =
			maxTtlMs === null ? lifetime.label : formatDuration(maxTtlMs, true);
		return `${prefix} eligible ${formatDuration(minTtlMs - age, true)}+ / max ${maxLabel}`;
	}
	if (maxTtlMs !== null && age >= maxTtlMs) {
		return `${prefix} expired +${formatDuration(age - maxTtlMs, false)} (max ${formatDuration(maxTtlMs, true)})`;
	}
	if (lifetime.typicalTtlMs && age < lifetime.typicalTtlMs[0]) {
		return `${prefix} age ${formatDuration(age, false)} / typ 5–10m`;
	}
	return maxTtlMs === null
		? `${prefix} age ${formatDuration(age, false)} / TTL ?`
		: `${prefix} uncertain · age ${formatDuration(age, false)} / max ${formatDuration(maxTtlMs, true)}`;
};

const emptyUsage = (): UsageTotals => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
});

const numberOrZero = (value: number | undefined): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const belongsToSession = (entry: UsageEntry, startedAt: number): boolean => {
	const timestamp = Date.parse(entry.timestamp ?? "");
	return (
		!Number.isFinite(startedAt) ||
		!Number.isFinite(timestamp) ||
		timestamp >= startedAt
	);
};

const addUsage = (totals: UsageTotals, entry: UsageEntry): void => {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return;

	const usage = entry.message.usage;
	if (!usage) return;
	totals.input += numberOrZero(usage.input);
	totals.output += numberOrZero(usage.output);
	totals.cacheRead += numberOrZero(usage.cacheRead);
	totals.cacheWrite += numberOrZero(usage.cacheWrite);
	totals.cost += numberOrZero(usage.cost?.total);
};

const sumUsage = (entries: UsageEntry[], startedAt: number): UsageTotals => {
	const totals = emptyUsage();
	for (const entry of entries) {
		if (belongsToSession(entry, startedAt)) addUsage(totals, entry);
	}
	return totals;
};

export const getSessionUsage = (
	entries: UsageEntry[],
	sessionStartedAt: string,
): UsageTotals => sumUsage(entries, Date.parse(sessionStartedAt));

export const getCurrentRunUsage = (
	entries: UsageEntry[],
	sessionStartedAt: string,
): UsageTotals => {
	const startedAt = Date.parse(sessionStartedAt);
	let startIndex = 0;

	for (const [index, entry] of entries.entries()) {
		if (belongsToSession(entry, startedAt) && resetTypes.has(entry.type))
			startIndex = index + 1;
	}

	return sumUsage(entries.slice(startIndex), startedAt);
};
