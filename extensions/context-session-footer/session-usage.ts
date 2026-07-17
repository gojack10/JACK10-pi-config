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
			cacheWrite1h?: number;
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

export type CacheObservation = {
	provider: string;
	model: string;
	latestRequestAt: number;
	latestCacheAt: number;
	latestWriteAt?: number;
	usesOneHourTtl: boolean;
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
		return fallback.minTtlMs === THIRTY_MINUTES && fallback.maxTtlMs === ONE_DAY
			? fallback
			: { minTtlMs: null, maxTtlMs: ONE_DAY, label: "max 24h" };
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
		// Codex omits ttl; infer GPT-5.6's only supported/default 30m value.
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

export const getCacheObservations = (
	entries: UsageEntry[],
	sessionStartedAt?: string,
): CacheObservation[] => {
	const startedAt = Date.parse(sessionStartedAt ?? "");
	const latestRequests = new Map<string, number>();
	const observations = new Map<string, CacheObservation>();

	for (const entry of entries) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		const timestamp = message.timestamp ?? Date.parse(entry.timestamp ?? "");
		if (
			!message.provider ||
			!message.model ||
			!Number.isFinite(timestamp) ||
			(Number.isFinite(startedAt) && timestamp < startedAt)
		)
			continue;

		const usage = message.usage;
		const cacheRead = numberOrZero(usage?.cacheRead);
		const cacheWrite = numberOrZero(usage?.cacheWrite);
		const cacheWrite1h = numberOrZero(usage?.cacheWrite1h);
		const key = `${message.provider}/${message.model}`;
		const promptTokens = numberOrZero(usage?.input) + cacheRead + cacheWrite;
		if (promptTokens >= 1024) latestRequests.set(key, timestamp);
		const reportedPolicy = Boolean(
			message.promptCache?.retention || message.promptCache?.ttl,
		);
		if (cacheRead + cacheWrite + cacheWrite1h === 0 && !reportedPolicy)
			continue;

		const previous = observations.get(key);
		observations.set(key, {
			provider: message.provider,
			model: message.model,
			latestRequestAt: timestamp,
			latestCacheAt: timestamp,
			...(cacheWrite > 0
				? { latestWriteAt: timestamp }
				: previous?.latestWriteAt !== undefined
					? { latestWriteAt: previous.latestWriteAt }
					: {}),
			usesOneHourTtl:
				cacheWrite > 0 ? cacheWrite1h > 0 : (previous?.usesOneHourTtl ?? false),
		});
	}

	for (const [key, observation] of observations) {
		observation.latestRequestAt =
			latestRequests.get(key) ?? observation.latestCacheAt;
	}
	return [...observations.values()];
};

const getCacheTimerStartedAt = (
	observation: CacheObservation,
): number | undefined => {
	if (/^gpt-5\.6(?:-|$)/.test(observation.model)) {
		return observation.provider.startsWith("openai-codex")
			? observation.latestRequestAt
			: observation.latestWriteAt;
	}
	return observation.latestCacheAt;
};

/** Guaranteed time remaining; zero means treat the cache as expired. */
export const getCacheTimerRemainingMs = (
	lifetime: CacheLifetime,
	observation: CacheObservation,
	now: number = Date.now(),
): number => {
	const ttlMs = observation.usesOneHourTtl ? ONE_HOUR : lifetime.minTtlMs;
	const startedAt = getCacheTimerStartedAt(observation);
	return ttlMs === null || startedAt === undefined
		? 0
		: Math.max(0, startedAt + ttlMs - now);
};

export const formatCacheTimer = (
	model: string,
	remainingMs: number,
): string => {
	if (remainingMs <= 0) return `CACHE: ${model} EXPIRED`;
	const total = Math.ceil(remainingMs / 1000);
	const parts = [
		Math.floor(total / 3600),
		Math.floor((total % 3600) / 60),
		total % 60,
	];
	return `CACHE: ${model} WARM ${parts.map((part) => String(part).padStart(2, "0")).join(":")}`;
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
