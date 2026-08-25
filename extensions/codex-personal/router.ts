import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CodexAccount,
	type CodexAccountRegistry,
	type CodexUsageState,
	parseRegistry,
	parseUsageState,
	type RegistryAccount,
} from "../codex-quota-extension/store.ts";

export type WorkClass = "short" | "long" | "unpredictable";
export type WorkInput = { workClass: WorkClass; horizonMinutes?: number };

export type RouteCandidate = {
	accountKey: string;
	actualProviderId: string;
	model: string;
	reason: string;
	warnings: string[];
	feedGeneration: number;
};

export type AccountEligibility = {
	account: RegistryAccount;
	telemetry?: CodexAccount;
	routable: boolean;
	reasons: string[];
};

export type RouteEvaluation = {
	allBlocked: boolean;
	candidates: RouteCandidate[];
	accounts: AccountEligibility[];
	error?: string;
};

type RankedAccount = AccountEligibility & {
	telemetry: CodexAccount;
	shortReset: number;
	earliestReset: number;
	burnUrgency: number;
	weeklyRemaining: number;
	bottleneckRemaining: number;
};

const FIFTEEN_MINUTES = 15 * 60_000;
const DEFAULT_REGISTRY_PATH = join(homedir(), ".pi", "agent", "codex-accounts.json");
const DEFAULT_FEED_PATH = join(homedir(), ".pi", "agent", "codex-usage-state.json");

export const parseWorkInput = (value: string | undefined): WorkInput => {
	if (!value || value === "unpredictable") return { workClass: "unpredictable" };
	const match = /^(short|long)(?::(\d+))?$/.exec(value);
	if (!match) throw new Error("--codex-work must be short[:minutes], long[:minutes], or unpredictable");
	const workClass = match[1] as "short" | "long";
	const horizonMinutes = match[2] ? Number(match[2]) : workClass === "short" ? 120 : 480;
	if (!Number.isSafeInteger(horizonMinutes) || horizonMinutes <= 0)
		throw new Error("Codex work horizon must be a positive whole number of minutes");
	return { workClass, horizonMinutes };
};

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const ageText = (milliseconds: number): string => `${Math.max(0, Math.floor(milliseconds / 1000))}s`;

const formatBlockedError = (
	model: string,
	feedPath: string,
	feedSummary: string,
	accounts: AccountEligibility[],
	now: number,
): string => {
	const recoveryTimes: number[] = [];
	const notBeforeValues: Array<{ value: number; elapsed429: boolean }> = [];
	for (const evaluation of accounts) {
		const telemetry = evaluation.telemetry;
		if (!telemetry) continue;
		if (
			telemetry.captureHealth === "healthy" &&
			telemetry.fetchedAt > 0 &&
			now - telemetry.fetchedAt <= FIFTEEN_MINUTES &&
			telemetry.notBefore != null
		)
			notBeforeValues.push({ value: telemetry.notBefore, elapsed429: telemetry.status429 && telemetry.notBefore * 1000 <= now });
		const nonTimeReasons = evaluation.reasons.filter(
			(reason) =>
				!reason.startsWith("WINDOW EXHAUSTED") &&
				!reason.startsWith("UNSAFE WINDOW") &&
				!reason.startsWith("NOT BEFORE") &&
				!(reason === "RATE LIMITED" && telemetry.notBefore != null && telemetry.notBefore * 1000 > now),
		);
		if (nonTimeReasons.length > 0) continue;
		const gates = telemetry.windows
			.filter((window) =>
				evaluation.reasons.some(
					(reason) =>
						reason === `WINDOW EXHAUSTED ${window.minutes}m` || reason === `UNSAFE WINDOW ${window.minutes}m`,
				),
			)
			.map((window) => window.resetAt);
		if (telemetry.notBefore != null && telemetry.notBefore * 1000 > now) gates.push(telemetry.notBefore);
		if (gates.length > 0) recoveryTimes.push(Math.max(...gates));
	}
	const earliestRecovery = recoveryTimes.length > 0 ? iso(Math.min(...recoveryTimes)) : "unknown";
	const earliestNotBefore = notBeforeValues.sort((a, b) => a.value - b.value)[0];
	const notBeforeText = earliestNotBefore
		? `${iso(earliestNotBefore.value)}${earliestNotBefore.elapsed429 ? " (elapsed; newer valid 200 required)" : ""}`
		: "none";
	const accountText =
		accounts.length > 0
			? accounts
					.map(({ account, reasons }) => `${account.label}(${account.accountKey}): ${reasons.join(", ") || "eligible"}`)
					.join("; ")
			: "registry unavailable";
	return `ERROR: openai-codex-personal/${model} unavailable — no routable Codex account.\nEarliest recovery: ${earliestRecovery} / earliest notBefore: ${notBeforeText}.\nFeed: ${feedPath}; ${feedSummary}.\nAccounts: ${accountText}.`;
};

const rank = (
	accounts: AccountEligibility[],
	work: WorkInput,
	model: string,
	generation: number,
	now: number,
): RouteCandidate[] => {
	const ranked = accounts
		.filter((entry): entry is AccountEligibility & { telemetry: CodexAccount } => entry.routable && !!entry.telemetry)
		.map((entry): RankedAccount => {
			const windows = entry.telemetry.windows;
			const shortWindow = [...windows].sort((a, b) => a.minutes - b.minutes)[0]!;
			const weekly = windows.find((window) => window.minutes === 10080);
			return {
				...entry,
				shortReset: shortWindow.resetAt,
				earliestReset: Math.min(...windows.map((window) => window.resetAt)),
				burnUrgency: (100 - shortWindow.pctUsed) / ((shortWindow.resetAt * 1000 - now) / 3_600_000),
				weeklyRemaining: weekly ? 100 - weekly.pctUsed : Number.NEGATIVE_INFINITY,
				bottleneckRemaining: Math.min(...windows.map((window) => 100 - window.pctUsed)),
			};
		});
	const lexical = (a: RankedAccount, b: RankedAccount) => a.account.accountKey.localeCompare(b.account.accountKey);
	const shortSort = (a: RankedAccount, b: RankedAccount) =>
		b.burnUrgency - a.burnUrgency ||
		a.shortReset - b.shortReset ||
		b.bottleneckRemaining - a.bottleneckRemaining ||
		lexical(a, b);
	const longSort = (a: RankedAccount, b: RankedAccount) =>
		b.weeklyRemaining - a.weeklyRemaining ||
		b.bottleneckRemaining - a.bottleneckRemaining ||
		b.earliestReset - a.earliestReset ||
		lexical(a, b);
	let ordered: RankedAccount[];
	if (work.workClass === "short") {
		const perishable = ranked.filter((entry) => entry.account.policyClass === "perishable").sort(shortSort);
		const stable = ranked.filter((entry) => entry.account.policyClass === "stable-weekly");
		const reserve = [...stable].sort((a, b) => b.weeklyRemaining - a.weeklyRemaining || lexical(a, b))[0];
		const nonReserve = stable.filter((entry) => entry !== reserve).sort(shortSort);
		ordered = [...perishable, ...nonReserve, ...(reserve ? [reserve] : [])];
	} else {
		ordered = [
			...ranked.filter((entry) => entry.account.policyClass === "stable-weekly").sort(longSort),
			...ranked
				.filter((entry) => entry.account.policyClass === "perishable")
				.sort((a, b) => b.bottleneckRemaining - a.bottleneckRemaining || b.earliestReset - a.earliestReset || lexical(a, b)),
		];
	}
	return ordered.map((entry) => {
		const stableCount = ranked.filter((candidate) => candidate.account.policyClass === "stable-weekly").length;
		const warning =
			work.workClass === "short" && entry.account.policyClass === "stable-weekly" && stableCount === 1
				? "STABLE WEEKLY RESERVE CONSUMED"
				: work.workClass !== "short" && entry.account.policyClass === "perishable"
					? "NO STABLE ACCOUNT; LONG WORK PINNED TO PERISHABLE"
					: undefined;
		return {
			accountKey: entry.account.accountKey,
			actualProviderId: entry.account.providerId,
			model,
			reason:
				work.workClass === "short"
					? `short work ranked by burn urgency ${entry.burnUrgency}`
					: `${work.workClass} work ranked by weekly/bottleneck headroom`,
			warnings: warning ? [warning] : [],
			feedGeneration: generation,
		};
	});
};

export const evaluateCodexRoute = (options: {
	registry: CodexAccountRegistry;
	feed: CodexUsageState;
	model: string;
	work?: WorkInput;
	now?: number;
	feedPath?: string;
}): RouteEvaluation => {
	const { registry, feed, model } = options;
	const work = options.work ?? { workClass: "unpredictable" };
	const now = options.now ?? Date.now();
	const horizon = work.horizonMinutes === undefined ? undefined : now / 1000 + work.horizonMinutes * 60;
	const telemetryByKey = new Map(feed.accounts.map((account) => [account.accountKey, account]));
	const accounts = registry.accounts.map((account): AccountEligibility => {
		const telemetry = telemetryByKey.get(account.accountKey);
		const reasons: string[] = [];
		if (!account.supportedModels.includes(model)) reasons.push("UNSUPPORTED MODEL");
		if (account.policyClass === "unknown") reasons.push("POLICY UNKNOWN");
		if (!telemetry) return { account, routable: false, reasons: [...reasons, "TELEMETRY MISSING"] };
		if (
			telemetry.id !== account.providerId ||
			telemetry.policyClass !== account.policyClass ||
			!telemetry.supportedModels.includes(model)
		)
			reasons.push("REGISTRY/FEED MISMATCH");
		if (telemetry.captureHealth !== "healthy") reasons.push(`CAPTURE ${telemetry.captureHealth.toUpperCase()}`);
		if (telemetry.fetchedAt <= 0) reasons.push("NO ACCEPTED SAMPLE");
		else if (now - telemetry.fetchedAt > FIFTEEN_MINUTES)
			reasons.push(`STALE TELEMETRY age ${ageText(now - telemetry.fetchedAt)}`);
		if (telemetry.status429) reasons.push("RATE LIMITED");
		if (telemetry.notBefore != null && now < telemetry.notBefore * 1000)
			reasons.push(`NOT BEFORE ${iso(telemetry.notBefore)}`);
		if (telemetry.windows.length === 0) reasons.push("CAPACITY UNKNOWN");
		if (account.policyClass === "stable-weekly" && !telemetry.windows.some((window) => window.minutes === 10080))
			reasons.push("WEEKLY WINDOW MISSING");
		if (account.policyClass === "perishable" && !telemetry.windows.some((window) => window.minutes < 10080))
			reasons.push("SHORT WINDOW MISSING");
		for (const window of telemetry.windows) {
			if (window.resetAt * 1000 <= now) reasons.push(`RESET ELAPSED ${window.minutes}m`);
			if (window.pctUsed >= 100) {
				reasons.push(`WINDOW EXHAUSTED ${window.minutes}m`);
				continue;
			}
			const boundary = horizon === undefined ? window.resetAt : Math.min(horizon, window.resetAt);
			const safe = window.projectedExhaustAt != null ? window.projectedExhaustAt >= boundary : window.pctUsed < 90;
			if (!safe) reasons.push(`UNSAFE WINDOW ${window.minutes}m`);
		}
		return { account, telemetry, routable: reasons.length === 0, reasons };
	});
	const candidates = rank(accounts, work, model, feed.generation, now);
	if (candidates.length > 0) return { allBlocked: false, candidates, accounts };
	const healthy = feed.accounts.filter((account) => account.captureHealth === "healthy").length;
	const ages = feed.accounts.filter((account) => account.fetchedAt > 0).map((account) => now - account.fetchedAt);
	const summary = `schema 2 generation ${feed.generation}; healthy ${healthy}/${feed.accounts.length}; freshest age ${ages.length ? ageText(Math.min(...ages)) : "unknown"}`;
	return {
		allBlocked: true,
		candidates: [],
		accounts,
		error: formatBlockedError(model, options.feedPath ?? DEFAULT_FEED_PATH, summary, accounts, now),
	};
};

export const evaluateCodexRouteFromFiles = (options: {
	model: string;
	work?: WorkInput;
	now?: number;
	registryPath?: string;
	feedPath?: string;
}): RouteEvaluation => {
	const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
	const feedPath = options.feedPath ?? DEFAULT_FEED_PATH;
	const now = options.now ?? Date.now();
	let registry: CodexAccountRegistry;
	try {
		registry = parseRegistry(JSON.parse(readFileSync(registryPath, "utf8")) as unknown);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			allBlocked: true,
			candidates: [],
			accounts: [],
			error: formatBlockedError(options.model, feedPath, `registry ${registryPath} unreadable or malformed: ${message}`, [], now),
		};
	}
	try {
		const feed = parseUsageState(JSON.parse(readFileSync(feedPath, "utf8")) as unknown);
		return evaluateCodexRoute({ ...options, registry, feed, now, feedPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const accounts = registry.accounts.map((account) => ({
			account,
			routable: false,
			reasons: [`FEED UNREADABLE OR MALFORMED: ${message}`],
		}));
		return {
			allBlocked: true,
			candidates: [],
			accounts,
			error: formatBlockedError(options.model, feedPath, `unreadable or malformed: ${message}`, accounts, now),
		};
	}
};
