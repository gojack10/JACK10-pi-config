import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PolicyClass = "stable-weekly" | "perishable" | "unknown";
export type CaptureHealth = "healthy" | "degraded";

export type RegistryAccount = {
	accountKey: string;
	providerId: string;
	credentialRef: string;
	label: string;
	policyClass: PolicyClass;
	supportedModels: string[];
};

export type CodexAccountRegistry = {
	schemaVersion: 1;
	umbrellaProviderId: string;
	accounts: RegistryAccount[];
};

export type CodexWindow = {
	minutes: number;
	pctUsed: number;
	resetAt: number;
	slopePctPerHour: number | null;
	projectedExhaustAt: number | null;
};

export type CodexAccount = {
	accountKey: string;
	id: string;
	label: string;
	plan: string;
	policyClass: PolicyClass;
	supportedModels: string[];
	captureHealth: CaptureHealth;
	lastAttemptAt: number;
	fetchedAt: number;
	windows: CodexWindow[];
	status429: boolean;
	retryAfter: number | null;
	notBefore: number | null;
	parseErrors: string[];
};

export type CodexUsageState = {
	schemaVersion: 2;
	generation: number;
	generatedAt: number;
	accounts: CodexAccount[];
	current?: string;
	currentAccountKey?: string;
	resetObserved?: string;
};

export type QuotaIncrease = { at: number; percent: number };
export type QuotaStatus = {
	h5?: number;
	week?: number;
	h5Increases: QuotaIncrease[];
	weekIncreases: QuotaIncrease[];
	h5Verifying: boolean;
	weekVerifying: boolean;
	routable: boolean;
	recoveryAt?: number;
	stale: boolean;
	aged?: boolean;
};

export type QuotaAccountEvaluation = {
	routable: boolean;
	reasons: string[];
	ageMs: number | null;
	freshness: "fresh" | "aged" | "unknown";
	degradations: string[];
	effectiveWindows: CodexWindow[];
	recoveryAt?: number;
};

export const QUOTA_FEED_AGED_MS = 15 * 60_000;

type LegacyWindow = Omit<CodexWindow, "slopePctPerHour" | "projectedExhaustAt">;
type LegacyAccount = {
	id: string;
	plan: string;
	windows: LegacyWindow[];
	status429: boolean;
	retryAfter?: number;
	notBefore?: number;
	fetchedAt: number;
};
type LegacyState = { accounts: LegacyAccount[]; current?: string; resetObserved?: string };

const emptyState = (): CodexUsageState => ({
	schemaVersion: 2,
	generation: 0,
	generatedAt: 0,
	accounts: [],
});

const EXTRA_HEADERS = new Set(["retry-after", "retry-after-ms", "x-request-id", "openai-processing-ms"]);

const numberHeader = (headers: Record<string, string>, name: string): number | undefined => {
	const value = headers[name];
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

export const allowlistedHeaders = (input: unknown): Record<string, string> => {
	const output: Record<string, string> = {};
	const entries: [string, unknown][] =
		input && typeof input === "object" && "entries" in input && typeof input.entries === "function"
			? Array.from((input as { entries(): Iterable<[string, unknown]> }).entries())
			: Object.entries((input as Record<string, unknown> | undefined) ?? {});
	for (const [rawName, rawValue] of entries) {
		const name = rawName.toLowerCase();
		if (!name.startsWith("x-codex-") && !EXTRA_HEADERS.has(name)) continue;
		if (rawValue !== undefined && rawValue !== null) output[name] = String(rawValue);
	}
	return output;
};

const parseRetryAfter = (headers: Record<string, string>, now: number): number | undefined => {
	const milliseconds = numberHeader(headers, "retry-after-ms");
	if (milliseconds !== undefined && milliseconds >= 0) return Math.ceil((now + milliseconds) / 1000);
	const value = headers["retry-after"];
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(now / 1000 + seconds);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.ceil(date / 1000) : undefined;
};

const projectWindow = (
	next: LegacyWindow,
	previous: CodexWindow | undefined,
	previousFetchedAt: number | undefined,
	now: number,
): CodexWindow => {
	if (!previous || previous.resetAt !== next.resetAt) return { ...next, slopePctPerHour: null, projectedExhaustAt: null };
	const elapsedHours = (now - (previousFetchedAt ?? now)) / 3_600_000;
	const increase = next.pctUsed - previous.pctUsed;
	if (!Number.isFinite(elapsedHours) || elapsedHours < 5 / 60 || increase < 1)
		return { ...next, slopePctPerHour: null, projectedExhaustAt: null };
	const slopePctPerHour = increase / elapsedHours;
	return {
		...next,
		slopePctPerHour,
		projectedExhaustAt: Math.ceil(now / 1000 + ((100 - next.pctUsed) / slopePctPerHour) * 3600),
	};
};

const parseWindow = (
	headers: Record<string, string>,
	slot: "primary" | "secondary",
	now: number,
	previous: CodexAccount | undefined,
): CodexWindow | undefined => {
	const minutes = numberHeader(headers, `x-codex-${slot}-window-minutes`);
	if (minutes === undefined) return undefined;
	if (minutes < 0) throw new Error(`${slot} window minutes is negative`);
	if (minutes === 0) return undefined;
	const pctUsed = numberHeader(headers, `x-codex-${slot}-used-percent`);
	if (pctUsed === undefined || pctUsed < 0 || pctUsed > 100) throw new Error(`${slot} used percent is invalid`);
	const absolute = numberHeader(headers, `x-codex-${slot}-reset-at`);
	const relative = numberHeader(headers, `x-codex-${slot}-reset-after-seconds`);
	if (relative !== undefined && relative < 0) throw new Error(`${slot} reset-after is negative`);
	if (absolute !== undefined && relative !== undefined && Math.abs(absolute - (now / 1000 + relative)) > 120)
		throw new Error(`${slot} reset headers disagree`);
	const resetAt = absolute ?? (relative === undefined ? undefined : now / 1000 + relative);
	if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= 0) throw new Error(`${slot} reset is missing`);
	const prior = previous?.windows.find((window) => window.minutes === minutes);
	return projectWindow(
		{ minutes, pctUsed, resetAt: Math.ceil(resetAt) },
		prior,
		previous?.status429 ? undefined : previous?.fetchedAt,
		now,
	);
};

export const normalizeObservation = (
	account: RegistryAccount,
	status: number,
	inputHeaders: unknown,
	previous?: CodexAccount,
	now: number = Date.now(),
): CodexAccount => {
	if (status !== 200 && status !== 429) throw new Error(`unsupported Codex response status ${status}`);
	const headers = allowlistedHeaders(inputHeaders);
	const hasQuotaHeaders = Object.keys(headers).some((name) => name.startsWith("x-codex-"));
	if (!hasQuotaHeaders && status !== 429) throw new Error("Codex quota headers are missing");
	const plan = headers["x-codex-plan-type"]?.trim() || previous?.plan || (status === 429 ? "unknown" : "");
	if (!plan) throw new Error("Codex plan is missing");
	const sawWindowShape = "x-codex-primary-window-minutes" in headers || "x-codex-secondary-window-minutes" in headers;
	if (status === 200 && !sawWindowShape) throw new Error("Codex window shape is missing");
	const parsed = [parseWindow(headers, "primary", now, previous), parseWindow(headers, "secondary", now, previous)].filter(
		(window): window is CodexWindow => window !== undefined,
	);
	const windows = sawWindowShape
		? [...new Map(parsed.map((window) => [window.minutes, window])).values()]
		: (previous?.windows ?? []);
	const retryAfter = parseRetryAfter(headers, now) ?? null;
	const activeResets = windows.filter((window) => window.resetAt * 1000 > now).map((window) => window.resetAt);
	const notBefore = status === 429 ? (retryAfter ?? (activeResets.length > 0 ? Math.min(...activeResets) : null)) : null;
	return {
		accountKey: account.accountKey,
		id: account.providerId,
		label: account.label,
		plan,
		policyClass: account.policyClass,
		supportedModels: [...account.supportedModels],
		captureHealth: "healthy",
		lastAttemptAt: now,
		fetchedAt: now,
		windows,
		status429: status === 429,
		retryAfter,
		notBefore,
		parseErrors: [],
	};
};

export const resetNotes = (previous: CodexAccount | undefined, next: CodexAccount): string[] => {
	if (!previous) return [];
	const notes: string[] = [];
	for (const window of next.windows) {
		const before = previous.windows.find((candidate) => candidate.minutes === window.minutes);
		if (before && (window.resetAt > before.resetAt || before.pctUsed - window.pctUsed > 1))
			notes.push(`${next.id} ${window.minutes}m reset observed`);
	}
	return notes;
};

const quotaIso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const quotaAge = (milliseconds: number): string => `${Math.max(0, Math.floor(milliseconds / 1000))}s`;

export const evaluateQuotaAccount = (
	account: CodexAccount,
	now: number = Date.now(),
	horizon?: number,
): QuotaAccountEvaluation => {
	const reasons: string[] = [];
	const degradations: string[] = [];
	const recoveryGates: number[] = [];
	if (account.policyClass === "unknown") reasons.push("POLICY UNKNOWN");
	if (account.captureHealth !== "healthy")
		degradations.push(`CAPTURE ${account.captureHealth.toUpperCase()}: ${account.parseErrors.join(", ") || "meter unavailable"}`);
	const ageMs = account.fetchedAt > 0 ? Math.max(0, now - account.fetchedAt) : null;
	const aged = ageMs != null && ageMs > QUOTA_FEED_AGED_MS;
	if (ageMs == null) reasons.push("NO ACCEPTED SAMPLE");
	else if (aged) degradations.push(`STALE TELEMETRY age ${quotaAge(ageMs)}`);
	if (account.notBefore != null && now < account.notBefore * 1000) {
		if (account.status429) reasons.push("RATE LIMITED");
		reasons.push(`NOT BEFORE ${quotaIso(account.notBefore)}`);
		recoveryGates.push(account.notBefore);
	} else if (account.status429) {
		reasons.push("RATE LIMITED");
		degradations.push(
			account.notBefore == null
				? "RATE LIMIT OBSERVED WITHOUT ACTIVE COOLDOWN"
				: `RATE LIMIT COOLDOWN ELAPSED ${quotaIso(account.notBefore)}`,
		);
	}
	if (account.windows.length === 0) reasons.push("CAPACITY UNKNOWN");
	if (!account.plan.toLowerCase().startsWith("pro") && !account.windows.some((window) => window.minutes === 300))
		reasons.push("5H WINDOW MISSING");
	if (!account.windows.some((window) => window.minutes === 10080)) reasons.push("WEEKLY WINDOW MISSING");
	const effectiveWindows: CodexWindow[] = [];
	for (const window of account.windows) {
		if (window.resetAt * 1000 <= now) {
			reasons.push(`WINDOW UNKNOWN AFTER RESET ${window.minutes}m`);
			degradations.push(`WINDOW ${window.minutes}m snapshot expired at ${quotaIso(window.resetAt)}`);
			continue;
		}
		const slope = aged && window.slopePctPerHour != null && window.slopePctPerHour > 0 ? window.slopePctPerHour : null;
		const pctUsed = aged
			? Math.min(100, slope == null ? Math.max(window.pctUsed, 90) : window.pctUsed + slope * (ageMs! / 3_600_000))
			: window.pctUsed;
		const projectedExhaustAt =
			slope == null
				? window.projectedExhaustAt
				: (window.projectedExhaustAt ?? Math.ceil(now / 1000 + ((100 - pctUsed) / slope) * 3600));
		const effective = { ...window, pctUsed, projectedExhaustAt };
		effectiveWindows.push(effective);
		if (aged && pctUsed !== window.pctUsed)
			degradations.push(`WINDOW ${window.minutes}m degraded ${window.pctUsed}%→${pctUsed.toFixed(1)}%`);
		if (pctUsed >= 100) {
			reasons.push(`WINDOW EXHAUSTED ${window.minutes}m`);
			recoveryGates.push(window.resetAt);
			continue;
		}
		const boundary = horizon === undefined ? window.resetAt : Math.min(horizon, window.resetAt);
		const safe = aged && slope == null ? true : projectedExhaustAt == null || projectedExhaustAt >= boundary;
		if (!safe) {
			reasons.push(`UNSAFE WINDOW ${window.minutes}m`);
			recoveryGates.push(window.resetAt);
		}
	}
	const onlyTimedReasons = reasons.every(
		(reason) =>
			reason === "RATE LIMITED" ||
			reason.startsWith("NOT BEFORE") ||
			reason.startsWith("WINDOW EXHAUSTED") ||
			reason.startsWith("UNSAFE WINDOW"),
	);
	return {
		routable: reasons.length === 0,
		reasons,
		ageMs,
		freshness: ageMs == null ? "unknown" : aged ? "aged" : "fresh",
		degradations,
		effectiveWindows,
		...(onlyTimedReasons && recoveryGates.length > 0 ? { recoveryAt: Math.max(...recoveryGates) } : {}),
	};
};

const poolStatus = (
	accounts: Array<{ account: CodexAccount; evaluation: QuotaAccountEvaluation }>,
	minutes: number,
	now: number,
	denominator: number,
) => {
	const gains = new Map<number, number>();
	const addGain = (at: number, percent: number) => {
		if (percent > 0 && at * 1000 > now)
			gains.set(at, (gains.get(at) ?? 0) + percent / denominator);
	};
	let remaining = 0;
	let verifying = false;
	for (const { account, evaluation } of accounts) {
		const observed = account.windows.find((window) => window.minutes === minutes);
		if (observed && observed.resetAt * 1000 <= now) verifying = true;
		const window = observed?.resetAt && observed.resetAt * 1000 > now ? observed : undefined;
		if (!window) continue;
		// Weekly balance is independent of short-window exhaustion and routing blocks.
		if (minutes === 10080 || evaluation.routable) {
			remaining += 100 - window.pctUsed;
			addGain(window.resetAt, window.pctUsed);
			continue;
		}
		if (evaluation.recoveryAt === undefined) continue;
		const afterRecovery = window.resetAt <= evaluation.recoveryAt ? 100 : 100 - window.pctUsed;
		addGain(evaluation.recoveryAt, afterRecovery);
		if (window.resetAt > evaluation.recoveryAt) addGain(window.resetAt, window.pctUsed);
	}
	return {
		remaining: remaining / denominator,
		increases: [...gains].sort(([left], [right]) => left - right)
			.map(([at, percent]) => ({ at, percent })),
		verifying,
	};
};

export const quotaStatus = (
	feed: CodexUsageState | undefined,
	now: number = Date.now(),
	registeredAccounts?: number,
	model?: string,
): QuotaStatus => {
	if (!feed) return {
		h5Increases: [], weekIncreases: [], h5Verifying: false, weekVerifying: false,
		routable: false, stale: true,
	};
	const observed = model
		? feed.accounts.filter((account) => account.supportedModels.includes(model))
		: feed.accounts;
	const denominator = Math.max(registeredAccounts ?? observed.length, observed.length);
	if (denominator === 0) return {
		h5Increases: [], weekIncreases: [], h5Verifying: false, weekVerifying: false,
		routable: false, stale: true,
	};
	const accounts = observed.map((account) => ({ account, evaluation: evaluateQuotaAccount(account, now) }));
	const evaluations = accounts.map(({ evaluation }) => evaluation);
	const routable = evaluations.some((evaluation) => evaluation.routable);
	const recoveries = evaluations
		.map((evaluation) => evaluation.recoveryAt)
		.filter((value): value is number => value !== undefined);
	const recoveryAt = recoveries.length > 0 ? Math.min(...recoveries) : undefined;
	// ponytail: equal-weight normalized accounts; weight absolute limits if telemetry exposes them.
	const h5 = poolStatus(accounts, 300, now, denominator);
	const week = poolStatus(accounts, 10080, now, denominator);
	return {
		h5: h5.remaining,
		week: week.remaining,
		h5Increases: h5.increases,
		weekIncreases: week.increases,
		h5Verifying: h5.verifying,
		weekVerifying: week.verifying,
		routable,
		...(recoveryAt === undefined ? {} : { recoveryAt }),
		stale: !routable && recoveryAt === undefined,
		...(evaluations.some((evaluation) => evaluation.freshness === "aged") ? { aged: true } : {}),
	};
};

export type QuotaBucket = "PLUS" | "PRO";

export type QuotaBucketRow = {
	bucket: QuotaBucket;
	window: "5H" | "WEEK";
	remaining: number;
	increases: QuotaIncrease[];
	verifying: boolean;
	blocked: boolean;
	stale: boolean;
};

const bucketFor = (plan: string): QuotaBucket | undefined => {
	const normalized = plan.toLowerCase();
	if (normalized.includes("plus")) return "PLUS";
	if (normalized.startsWith("pro")) return "PRO";
	return undefined;
};

// Bucket rows are model-independent gauges: remaining is summed across every live
// account that has the window (429'd included, aged degradation included) and
// divided by the count of those live accounts, never by registered accounts.
export const quotaBuckets = (
	feed: CodexUsageState | undefined,
	now: number = Date.now(),
): QuotaBucketRow[] => {
	if (!feed || feed.accounts.length === 0) return [];
	const evaluated = feed.accounts.map((account) => ({ account, evaluation: evaluateQuotaAccount(account, now) }));
	const rows: QuotaBucketRow[] = [];
	for (const bucket of ["PLUS", "PRO"] as const) {
		const members = evaluated.filter(({ account }) => bucketFor(account.plan) === bucket);
		for (const minutes of [300, 10080] as const) {
			if (!members.some(({ account }) => account.windows.some((window) => window.minutes === minutes))) continue;
			const live = members.filter(({ evaluation }) =>
				evaluation.effectiveWindows.some((window) => window.minutes === minutes)
			);
			// A routing failure/429 does not identify which quota window is empty.
			// Weekly exhaustion can block 5H use, but never the reverse.
			const blocked = live.length > 0 && live.every(({ evaluation }) =>
				evaluation.effectiveWindows.some((window) =>
					(window.minutes === minutes || window.minutes === 10080) && window.pctUsed >= 100
				)
			);
			const stale = !blocked && live.some(({ evaluation }) => evaluation.freshness === "aged");
			const refillByReset = new Map<number, number>();
			for (const { evaluation } of live) {
				for (const window of evaluation.effectiveWindows) {
					if (window.minutes !== minutes || window.resetAt * 1000 <= now || window.pctUsed <= 0) continue;
					refillByReset.set(window.resetAt, (refillByReset.get(window.resetAt) ?? 0) + window.pctUsed);
				}
			}
			const events: QuotaIncrease[] = [...refillByReset]
				.sort(([left], [right]) => left - right)
				.map(([at, percent]) => ({ at, percent: percent / live.length }));
			const remaining =
				live.length === 0
					? 0
					: live.reduce((sum, { evaluation }) => {
							const window = evaluation.effectiveWindows.find((candidate) => candidate.minutes === minutes)!;
							return sum + (100 - window.pctUsed);
						}, 0) / live.length;
			const verifying = members.some(({ account }) =>
				account.windows.some((window) => window.minutes === minutes && window.resetAt * 1000 <= now)
			);
			rows.push({
				bucket,
				window: minutes === 300 ? "5H" : "WEEK",
				remaining,
				increases: events,
				verifying,
				blocked,
				stale,
			});
		}
	}
	return rows;
};

const isPolicyClass = (value: unknown): value is PolicyClass =>
	value === "stable-weekly" || value === "perishable" || value === "unknown";

const validRegistryAccount = (value: unknown): value is RegistryAccount => {
	if (!value || typeof value !== "object") return false;
	const account = value as Partial<RegistryAccount>;
	return (
		typeof account.accountKey === "string" &&
		account.accountKey.length > 0 &&
		typeof account.providerId === "string" &&
		account.providerId.startsWith("openai-codex") &&
		typeof account.credentialRef === "string" &&
		typeof account.label === "string" &&
		isPolicyClass(account.policyClass) &&
		Array.isArray(account.supportedModels) &&
		account.supportedModels.every((model) => typeof model === "string")
	);
};

export const parseRegistry = (value: unknown): CodexAccountRegistry => {
	if (!value || typeof value !== "object") throw new Error("Codex account registry has an invalid shape");
	const registry = value as Partial<CodexAccountRegistry>;
	if (
		registry.schemaVersion !== 1 ||
		typeof registry.umbrellaProviderId !== "string" ||
		!Array.isArray(registry.accounts) ||
		!registry.accounts.every(validRegistryAccount)
	)
		throw new Error("Codex account registry has an invalid shape");
	const accountKeys = new Set(registry.accounts.map((account) => account.accountKey));
	const providerIds = new Set(registry.accounts.map((account) => account.providerId));
	if (accountKeys.size !== registry.accounts.length || providerIds.size !== registry.accounts.length)
		throw new Error("Codex account registry mappings must be unique");
	return registry as CodexAccountRegistry;
};

export const loadRegistry = async (
	path = join(homedir(), ".pi", "agent", "codex-accounts.json"),
): Promise<CodexAccountRegistry> => parseRegistry(JSON.parse(await readFile(path, "utf8")) as unknown);

const validWindow = (value: unknown): value is CodexWindow => {
	if (!value || typeof value !== "object") return false;
	const window = value as Partial<CodexWindow>;
	return (
		Number.isFinite(window.minutes) &&
		(window.minutes ?? 0) > 0 &&
		Number.isFinite(window.pctUsed) &&
		(window.pctUsed ?? -1) >= 0 &&
		(window.pctUsed ?? 101) <= 100 &&
		Number.isFinite(window.resetAt) &&
		(window.resetAt ?? 0) > 0 &&
		(window.slopePctPerHour === null || Number.isFinite(window.slopePctPerHour)) &&
		(window.projectedExhaustAt === null || Number.isFinite(window.projectedExhaustAt))
	);
};

const validAccount = (value: unknown): value is CodexAccount => {
	if (!value || typeof value !== "object") return false;
	const account = value as Partial<CodexAccount>;
	return (
		typeof account.accountKey === "string" &&
		typeof account.id === "string" &&
		typeof account.label === "string" &&
		typeof account.plan === "string" &&
		isPolicyClass(account.policyClass) &&
		Array.isArray(account.supportedModels) &&
		account.supportedModels.every((model) => typeof model === "string") &&
		(account.captureHealth === "healthy" || account.captureHealth === "degraded") &&
		Number.isFinite(account.lastAttemptAt) &&
		Number.isFinite(account.fetchedAt) &&
		Array.isArray(account.windows) &&
		account.windows.every(validWindow) &&
		typeof account.status429 === "boolean" &&
		(account.retryAfter === null || Number.isFinite(account.retryAfter)) &&
		(account.notBefore === null || Number.isFinite(account.notBefore)) &&
		Array.isArray(account.parseErrors) &&
		account.parseErrors.every((error) => typeof error === "string")
	);
};

const validState = (value: unknown): value is CodexUsageState => {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<CodexUsageState>;
	return (
		state.schemaVersion === 2 &&
		Number.isInteger(state.generation) &&
		Number.isFinite(state.generatedAt) &&
		Array.isArray(state.accounts) &&
		state.accounts.every(validAccount) &&
		(state.current === undefined || typeof state.current === "string") &&
		(state.currentAccountKey === undefined || typeof state.currentAccountKey === "string") &&
		(state.resetObserved === undefined || typeof state.resetObserved === "string")
	);
};

export const parseUsageState = (value: unknown): CodexUsageState => {
	if (!validState(value)) throw new Error("Codex usage state has an invalid schema-2 shape");
	return value;
};

const validLegacyState = (value: unknown): value is LegacyState => {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LegacyState>;
	return (
		Array.isArray(state.accounts) &&
		state.accounts.every(
			(account) =>
				account &&
				typeof account.id === "string" &&
				typeof account.plan === "string" &&
				Array.isArray(account.windows) &&
				account.windows.every(
					(window) =>
						Number.isFinite(window.minutes) && Number.isFinite(window.pctUsed) && Number.isFinite(window.resetAt),
				) &&
				typeof account.status429 === "boolean" &&
				Number.isFinite(account.fetchedAt),
		) &&
		(state.current === undefined || typeof state.current === "string")
	);
};

const migrateState = (legacy: LegacyState, registry: CodexAccountRegistry): CodexUsageState => {
	const accounts = legacy.accounts.map((account) => {
		const mappings = registry.accounts.filter((entry) => entry.providerId === account.id);
		if (mappings.length !== 1) throw new Error(`No unique registry mapping for ${account.id}`);
		const mapping = mappings[0]!;
		return {
			accountKey: mapping.accountKey,
			id: mapping.providerId,
			label: mapping.label,
			plan: account.plan,
			policyClass: mapping.policyClass,
			supportedModels: [...mapping.supportedModels],
			captureHealth: "healthy" as const,
			lastAttemptAt: account.fetchedAt,
			fetchedAt: account.fetchedAt,
			windows: account.windows.map((window) => ({ ...window, slopePctPerHour: null, projectedExhaustAt: null })),
			status429: account.status429,
			retryAfter: account.retryAfter ?? null,
			notBefore: account.notBefore ?? null,
			parseErrors: [],
		};
	});
	const currentAccountKey = accounts.find((account) => account.id === legacy.current)?.accountKey;
	return {
		...emptyState(),
		accounts,
		...(legacy.current ? { current: legacy.current } : {}),
		...(currentAccountKey ? { currentAccountKey } : {}),
		...(legacy.resetObserved ? { resetObserved: legacy.resetObserved } : {}),
	};
};

export class CodexUsageStore {
	private state: CodexUsageState = emptyState();
	private registry?: CodexAccountRegistry;
	private readonly registryPath: string;
	private readonly dirtyAccountKeys = new Set<string>();
	private currentDirty = false;
	readonly path: string;

	constructor(
		path = join(homedir(), ".pi", "agent", "codex-usage-state.json"),
		registry: CodexAccountRegistry | string = join(homedir(), ".pi", "agent", "codex-accounts.json"),
	) {
		this.path = path;
		this.registryPath = typeof registry === "string" ? registry : "";
		if (typeof registry !== "string") this.registry = parseRegistry(registry);
	}

	private async getRegistry(): Promise<CodexAccountRegistry> {
		return (this.registry ??= await loadRegistry(this.registryPath));
	}

	private accountForProvider(id: string): RegistryAccount {
		const mappings = this.registry?.accounts.filter((account) => account.providerId === id) ?? [];
		if (mappings.length !== 1) throw new Error(`No unique registry mapping for ${id}`);
		return mappings[0]!;
	}

	private async readDisk(): Promise<CodexUsageState> {
		const registry = await this.getRegistry();
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
			if (validState(parsed)) return parsed;
			if (validLegacyState(parsed)) return migrateState(parsed, registry);
			throw new Error("Codex usage state has an invalid shape");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			throw error;
		}
	}

	async load(): Promise<CodexUsageState> {
		this.state = await this.readDisk();
		return this.snapshot();
	}

	async registeredAccountCount(model?: string): Promise<number> {
		const accounts = (await this.getRegistry()).accounts;
		return model ? accounts.filter((account) => account.supportedModels.includes(model)).length : accounts.length;
	}

	snapshot(): CodexUsageState {
		return structuredClone(this.state);
	}

	setCurrent(id: string): void {
		const account = this.accountForProvider(id);
		this.state.current = id;
		this.state.currentAccountKey = account.accountKey;
		this.currentDirty = true;
	}

	observe(id: string, status: number, headers: unknown, now = Date.now()): CodexUsageState {
		const account = this.accountForProvider(id);
		const previous = this.state.accounts.find((entry) => entry.accountKey === account.accountKey);
		const next = normalizeObservation(account, status, headers, previous, now);
		const notes = resetNotes(previous, next);
		this.state.accounts = [...this.state.accounts.filter((entry) => entry.accountKey !== account.accountKey), next].sort(
			(a, b) => a.accountKey.localeCompare(b.accountKey),
		);
		this.state.current = id;
		this.state.currentAccountKey = account.accountKey;
		this.dirtyAccountKeys.add(account.accountKey);
		this.currentDirty = true;
		if (notes.length > 0) this.state.resetObserved = notes.join("; ");
		else delete this.state.resetObserved;
		return this.snapshot();
	}

	recordFailure(id: string, error: unknown, now = Date.now()): CodexUsageState {
		const account = this.accountForProvider(id);
		const previous = this.state.accounts.find((entry) => entry.accountKey === account.accountKey);
		const message = error instanceof Error ? error.message : String(error);
		const next: CodexAccount = {
			accountKey: account.accountKey,
			id: account.providerId,
			label: account.label,
			plan: previous?.plan ?? "unknown",
			policyClass: account.policyClass,
			supportedModels: [...account.supportedModels],
			captureHealth: "degraded",
			lastAttemptAt: now,
			fetchedAt: previous?.fetchedAt ?? 0,
			windows: previous?.windows ?? [],
			status429: previous?.status429 ?? false,
			retryAfter: previous?.retryAfter ?? null,
			notBefore: previous?.notBefore ?? null,
			parseErrors: [message],
		};
		this.state.accounts = [...this.state.accounts.filter((entry) => entry.accountKey !== account.accountKey), next].sort(
			(a, b) => a.accountKey.localeCompare(b.accountKey),
		);
		this.dirtyAccountKeys.add(account.accountKey);
		return this.snapshot();
	}

	private async acquireLock(): Promise<() => Promise<void>> {
		const lockPath = `${this.path}.lock`;
		const deadline = Date.now() + 5_000;
		while (true) {
			try {
				const handle = await open(lockPath, "wx", 0o600);
				return async () => {
					await handle.close();
					await unlink(lockPath).catch(() => undefined);
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lockStat = await stat(lockPath).catch(() => undefined);
				if (!lockStat) continue;
				const age = Date.now() - lockStat.mtimeMs;
				if (age > 30_000) {
					await unlink(lockPath).catch(() => undefined);
					continue;
				}
				if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex usage state lock");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	}

	async write(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		// ponytail: one global feed lock; split per account only if capture contention becomes material.
		const release = await this.acquireLock();
		try {
			const disk = await this.readDisk();
			const local = new Map(this.state.accounts.map((account) => [account.accountKey, account]));
			const merged = new Map(disk.accounts.map((account) => [account.accountKey, account]));
			for (const accountKey of this.dirtyAccountKeys) {
				const account = local.get(accountKey);
				if (account) merged.set(accountKey, account);
			}
			const next: CodexUsageState = {
				...disk,
				schemaVersion: 2,
				generation: Math.max(disk.generation, this.state.generation) + 1,
				generatedAt: Date.now(),
				accounts: [...merged.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
				...(this.currentDirty
					? {
							...(this.state.current ? { current: this.state.current } : {}),
							...(this.state.currentAccountKey ? { currentAccountKey: this.state.currentAccountKey } : {}),
						}
					: {}),
				...(this.state.resetObserved ? { resetObserved: this.state.resetObserved } : {}),
			};
			const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
			this.state = next;
			this.dirtyAccountKeys.clear();
			this.currentDirty = false;
		} finally {
			await release();
		}
	}
}
