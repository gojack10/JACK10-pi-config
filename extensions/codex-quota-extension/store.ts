import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CodexWindow = {
	minutes: number;
	pctUsed: number;
	resetAt: number;
};

export type CodexAccount = {
	id: string;
	plan: string;
	windows: CodexWindow[];
	windowsFetchedAt?: number;
	status429: boolean;
	retryAfter?: number;
	lastModel?: string;
	fetchedAt: number;
};

export type CodexUsageState = {
	accounts: CodexAccount[];
	current?: string;
	resetObserved?: string;
};

export type QuotaWindowView = {
	pctUsed: number;
	resetAt: number;
	expired: boolean;
};

export type QuotaView = {
	currentLabel: string;
	win300?: QuotaWindowView;
	win10080?: QuotaWindowView;
	totalUsedEq: number;
	totalCount: number;
	fetchedAt: number;
	expired: boolean;
	blocked: boolean;
};

const EXTRA_HEADERS = new Set([
	"retry-after",
	"retry-after-ms",
	"x-request-id",
	"openai-processing-ms",
]);

const numberHeader = (
	headers: Record<string, string>,
	name: string,
): number | undefined => {
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

const parseRetryAfter = (
	headers: Record<string, string>,
	now: number,
): number | undefined => {
	const milliseconds = numberHeader(headers, "retry-after-ms");
	if (milliseconds !== undefined && milliseconds >= 0)
		return Math.ceil((now + milliseconds) / 1000);
	const value = headers["retry-after"];
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.ceil(now / 1000 + seconds);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.ceil(date / 1000) : undefined;
};

const parseWindow = (
	headers: Record<string, string>,
	slot: "primary" | "secondary",
	now: number,
): CodexWindow | undefined => {
	const minutes = numberHeader(headers, `x-codex-${slot}-window-minutes`);
	if (minutes === undefined) return undefined;
	if (minutes < 0) throw new Error(`${slot} window minutes is negative`);
	if (minutes === 0) return undefined;

	const pctUsed = numberHeader(headers, `x-codex-${slot}-used-percent`);
	if (pctUsed === undefined || pctUsed < 0 || pctUsed > 100)
		throw new Error(`${slot} used percent is invalid`);
	const absolute = numberHeader(headers, `x-codex-${slot}-reset-at`);
	const relative = numberHeader(headers, `x-codex-${slot}-reset-after-seconds`);
	if (relative !== undefined && relative < 0)
		throw new Error(`${slot} reset-after is negative`);
	if (
		absolute !== undefined &&
		relative !== undefined &&
		Math.abs(absolute - (now / 1000 + relative)) > 120
	)
		throw new Error(`${slot} reset headers disagree`);
	const resetAt = absolute ?? (relative === undefined ? undefined : now / 1000 + relative);
	if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= 0)
		throw new Error(`${slot} reset is missing`);
	return { minutes, pctUsed, resetAt: Math.ceil(resetAt) };
};

export const normalizeObservation = (
	id: string,
	status: number,
	inputHeaders: unknown,
	previous?: CodexAccount,
	now: number = Date.now(),
	model?: string,
): CodexAccount => {
	if (!id.startsWith("openai-codex")) throw new Error("provider is not Codex");
	if (status !== 200 && status !== 429)
		throw new Error(`unsupported Codex response status ${status}`);
	const headers = allowlistedHeaders(inputHeaders);
	const hasQuotaHeaders = Object.keys(headers).some((name) => name.startsWith("x-codex-"));
	if (!hasQuotaHeaders && status !== 429)
		throw new Error("Codex quota headers are missing");

	const plan = headers["x-codex-plan-type"]?.trim() || previous?.plan || (status === 429 ? "unknown" : "");
	if (!plan) throw new Error("Codex plan is missing");
	const sawWindowShape =
		"x-codex-primary-window-minutes" in headers ||
		"x-codex-secondary-window-minutes" in headers;
	if (status === 200 && !sawWindowShape)
		throw new Error("Codex window shape is missing");
	const parsed = [
		parseWindow(headers, "primary", now),
		parseWindow(headers, "secondary", now),
	].filter((window): window is CodexWindow => window !== undefined);
	const windows = sawWindowShape
		? [...new Map(parsed.map((window) => [window.minutes, window])).values()]
		: (previous?.windows ?? []);
	const retryAfter = parseRetryAfter(headers, now);

	return {
		id,
		plan,
		windows,
		...(sawWindowShape
			? { windowsFetchedAt: now }
			: previous?.windowsFetchedAt !== undefined
				? { windowsFetchedAt: previous.windowsFetchedAt }
				: previous ? { windowsFetchedAt: previous.fetchedAt } : {}),
		status429: status === 429,
		...(retryAfter === undefined ? {} : { retryAfter }),
		...(model ?? previous?.lastModel ? { lastModel: model ?? previous?.lastModel } : {}),
		fetchedAt: now,
	};
};

export const resetNotes = (
	previous: CodexAccount | undefined,
	next: CodexAccount,
): string[] => {
	if (!previous) return [];
	const notes: string[] = [];
	for (const window of next.windows) {
		const before = previous.windows.find((candidate) => candidate.minutes === window.minutes);
		if (
			before &&
			(window.resetAt > before.resetAt || before.pctUsed - window.pctUsed > 1)
		)
			notes.push(`${next.id} ${window.minutes}m reset observed`);
	}
	return notes;
};

export const buildQuotaView = (
	state: CodexUsageState,
	now: number = Date.now(),
): QuotaView | undefined => {
	if (state.accounts.length === 0) return undefined;
	const current = state.accounts.find((account) => account.id === state.current);
	let totalUsedEq = 0;
	let totalCount = 0;
	for (const account of state.accounts) {
		for (const window of account.windows) {
			if (window.resetAt * 1000 <= now) continue;
			totalUsedEq += window.pctUsed;
			totalCount++;
		}
	}
	const windowView = (minutes: number): QuotaWindowView | undefined => {
		const window = current?.windows.find((candidate) => candidate.minutes === minutes);
		return window && { ...window, expired: window.resetAt * 1000 <= now };
	};
	const win300 = windowView(300);
	const win10080 = windowView(10080);
	const fetchedAt = current?.windowsFetchedAt ?? current?.fetchedAt ?? now;
	return {
		currentLabel: current?.id ?? state.current ?? "",
		...(win300 ? { win300 } : {}),
		...(win10080 ? { win10080 } : {}),
		totalUsedEq,
		totalCount,
		fetchedAt,
		expired:
			now - fetchedAt > 60 * 60_000 ||
			Boolean(win300?.expired || win10080?.expired),
		blocked: current?.status429 ?? false,
	};
};

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
		(window.resetAt ?? 0) > 0
	);
};

const validAccount = (value: unknown): value is CodexAccount => {
	if (!value || typeof value !== "object") return false;
	const account = value as Partial<CodexAccount>;
	return (
		typeof account.id === "string" &&
		account.id.startsWith("openai-codex") &&
		typeof account.plan === "string" &&
		account.plan.length > 0 &&
		Array.isArray(account.windows) &&
		account.windows.every(validWindow) &&
		(account.windowsFetchedAt === undefined || Number.isFinite(account.windowsFetchedAt)) &&
		typeof account.status429 === "boolean" &&
		(account.retryAfter === undefined || Number.isFinite(account.retryAfter)) &&
		(account.lastModel === undefined || typeof account.lastModel === "string") &&
		Number.isFinite(account.fetchedAt)
	);
};

const validState = (value: unknown): value is CodexUsageState => {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<CodexUsageState>;
	return (
		Array.isArray(state.accounts) &&
		state.accounts.every(validAccount) &&
		(state.current === undefined || typeof state.current === "string") &&
		(state.resetObserved === undefined || typeof state.resetObserved === "string")
	);
};

export class CodexUsageStore {
	private state: CodexUsageState = { accounts: [] };
	readonly path: string;

	constructor(path = join(homedir(), ".pi", "agent", "codex-usage-state.json")) {
		this.path = path;
	}

	async load(): Promise<CodexUsageState> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
			if (!validState(parsed)) throw new Error("Codex usage state has an invalid shape");
			this.state = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.state = { accounts: [] };
		}
		return this.snapshot();
	}

	snapshot(): CodexUsageState {
		return structuredClone(this.state);
	}

	setCurrent(id: string): void {
		this.state.current = id;
	}

	observe(
		id: string,
		status: number,
		headers: unknown,
		now = Date.now(),
		model?: string,
	): CodexUsageState {
		const previous = this.state.accounts.find((account) => account.id === id);
		const next = normalizeObservation(id, status, headers, previous, now, model);
		const notes = resetNotes(previous, next);
		this.state.accounts = [
			...this.state.accounts.filter((account) => account.id !== id),
			next,
		].sort((a, b) => a.id.localeCompare(b.id));
		this.state.current = id;
		if (notes.length > 0) this.state.resetObserved = notes.join("; ");
		else delete this.state.resetObserved;
		return this.snapshot();
	}

	async write(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, this.path);
		await chmod(this.path, 0o600);
	}
}
