import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchLoginProbe } from "../codex-workspaces/probe.ts";
import {
	parseRegistry,
	parseUsageState,
	QUOTA_FEED_AGED_MS,
	type CodexAccount,
	type CodexAccountRegistry,
	type CodexUsageState,
} from "./store.ts";

const GRACE_MS = 30_000;
const LEASE_MS = 45_000;
const GLOBAL_SPACING_MS = 5_000;
const HOURLY_PROBE_MS = 60 * 60_000;
const BACKOFF_MS = [5, 15, 30, 60].map((minutes) => minutes * 60_000);
const AGENT_DIR = join(homedir(), ".pi", "agent");

export type ProbeStatus = "scheduled" | "fired" | "200" | "429" | "timeout";
export type ProbeScheduleEntry = {
	accountKey: string;
	providerId: string;
	scheduledAt: number;
	baselineFetchedAt: number;
	attempts: number;
	reason: string;
	leaseToken?: string;
	leaseUntil?: number;
};
type ProbeSchedule = { schemaVersion: 1; entries: ProbeScheduleEntry[]; notBefore?: number };
type ProbePlan = { at: number; reason: string };
type LaunchResult = { timedOut: boolean; details: Record<string, unknown> };
type Timer = ReturnType<typeof setTimeout>;

const emptySchedule = (): ProbeSchedule => ({ schemaVersion: 1, entries: [] });

export const probePlan = (account: CodexAccount | undefined, now = Date.now()): ProbePlan | undefined => {
	if (!account || account.fetchedAt <= 0) return { at: now, reason: "zero telemetry" };
	const expired = account.windows.some((window) => window.resetAt * 1000 <= now);
	const futureExhausted = account.windows.filter((window) => window.pctUsed >= 100 && window.resetAt * 1000 > now);
	const exhaustedWeekly = futureExhausted.filter((window) => window.minutes === 10080);
	if (expired && exhaustedWeekly.length > 0)
		return { at: Math.min(...exhaustedWeekly.map((window) => window.resetAt * 1000)) + GRACE_MS, reason: "next reset boundary" };
	if (account.status429) {
		if (account.notBefore != null && account.notBefore * 1000 > now)
			return { at: account.notBefore * 1000 + GRACE_MS, reason: "429 cooldown" };
		if (futureExhausted.length === 0)
			return { at: Math.max(now, account.lastAttemptAt + HOURLY_PROBE_MS), reason: "429 without reset timer" };
	}
	if (expired) return { at: now, reason: "window reset unproven" };
	if (futureExhausted.length > 0)
		return { at: Math.max(...futureExhausted.map((window) => window.resetAt * 1000)) + GRACE_MS, reason: "exhausted window reset" };
	if (now - account.fetchedAt >= QUOTA_FEED_AGED_MS)
		return { at: now, reason: "stale telemetry" };
	const nextReset = account.windows
		.filter((window) => window.resetAt * 1000 > now)
		.map((window) => window.resetAt * 1000)
		.sort((left, right) => left - right)[0];
	return nextReset === undefined ? undefined : { at: nextReset + GRACE_MS, reason: "usage window reset" };
};

const validEntry = (value: unknown): value is ProbeScheduleEntry => {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<ProbeScheduleEntry>;
	return typeof entry.accountKey === "string" && typeof entry.providerId === "string" &&
		Number.isFinite(entry.scheduledAt) && Number.isFinite(entry.baselineFetchedAt) &&
		Number.isInteger(entry.attempts) && typeof entry.reason === "string" &&
		(entry.leaseToken === undefined || typeof entry.leaseToken === "string") &&
		(entry.leaseUntil === undefined || Number.isFinite(entry.leaseUntil));
};

const parseSchedule = (value: unknown): ProbeSchedule => {
	if (!value || typeof value !== "object" || (value as Partial<ProbeSchedule>).schemaVersion !== 1 ||
		!Array.isArray((value as Partial<ProbeSchedule>).entries) || !(value as ProbeSchedule).entries.every(validEntry) ||
		((value as ProbeSchedule).notBefore !== undefined && !Number.isFinite((value as ProbeSchedule).notBefore)))
		throw new Error("Codex probe schedule has an invalid shape");
	return value as ProbeSchedule;
};

const defaultLaunch = (providerId: string): Promise<LaunchResult> => new Promise((resolve) => {
	launchLoginProbe(providerId, (_outcome, details) => resolve({
		timedOut: String(details.error ?? "").includes("timed out"),
		details,
	}));
});

const defaultObserve = async (provider: string, status: ProbeStatus, details: Record<string, unknown>): Promise<void> => {
	const path = join(AGENT_DIR, "codex-workspace-auth-observability.jsonl");
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify({
		capturedAt: new Date().toISOString(), provider, phase: "probe",
		outcome: status === "200" || status === "scheduled" || status === "fired" ? "success" : "error",
		status, ...details,
	})}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
};

export class ProbeScheduler {
	private timer: Timer | undefined;
	private closed = false;
	private readonly path: string;
	private readonly feedPath: string;
	private readonly registryPath: string;
	private readonly registry?: CodexAccountRegistry;
	private readonly now: () => number;
	private readonly launch: (providerId: string) => Promise<LaunchResult>;
	private readonly observe: (provider: string, status: ProbeStatus, details: Record<string, unknown>) => void | Promise<void>;

	constructor(options: {
		path?: string;
		feedPath?: string;
		registry?: CodexAccountRegistry;
		registryPath?: string;
		now?: () => number;
		launch?: (providerId: string) => Promise<LaunchResult>;
		observe?: (provider: string, status: ProbeStatus, details: Record<string, unknown>) => void | Promise<void>;
	} = {}) {
		this.path = options.path ?? join(AGENT_DIR, "probe-schedule.json");
		this.feedPath = options.feedPath ?? join(AGENT_DIR, "codex-usage-state.json");
		this.registryPath = options.registryPath ?? join(AGENT_DIR, "codex-accounts.json");
		this.registry = options.registry;
		this.now = options.now ?? Date.now;
		this.launch = options.launch ?? defaultLaunch;
		this.observe = options.observe ?? defaultObserve;
	}

	private async read(): Promise<ProbeSchedule> {
		try { return parseSchedule(JSON.parse(await readFile(this.path, "utf8")) as unknown); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySchedule();
			throw error;
		}
	}

	private async write(schedule: ProbeSchedule): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(schedule, null, 2)}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, this.path);
		await chmod(this.path, 0o600);
	}

	private async locked<T>(change: (schedule: ProbeSchedule) => Promise<T> | T): Promise<T> {
		const lockPath = `${this.path}.lock`;
		await mkdir(dirname(lockPath), { recursive: true });
		const deadline = Date.now() + 5_000;
		while (true) {
			try {
				const handle = await open(lockPath, "wx", 0o600);
				try { return await change(await this.read()); }
				finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lockStat = await stat(lockPath).catch(() => undefined);
				if (!lockStat) continue;
				if (Date.now() - lockStat.mtimeMs > LEASE_MS) { await unlink(lockPath).catch(() => undefined); continue; }
				if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex probe schedule lock");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	}

	private async getRegistry(): Promise<CodexAccountRegistry> {
		return this.registry ?? parseRegistry(JSON.parse(await readFile(this.registryPath, "utf8")) as unknown);
	}

	private arm(entries: ProbeScheduleEntry[]): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.closed || entries.length === 0) return;
		const entry = [...entries].sort((left, right) => {
			const leftDue = left.leaseUntil && left.leaseUntil > this.now() ? left.leaseUntil : left.scheduledAt;
			const rightDue = right.leaseUntil && right.leaseUntil > this.now() ? right.leaseUntil : right.scheduledAt;
			return leftDue - rightDue;
		})[0]!;
		const due = entry.leaseUntil && entry.leaseUntil > this.now() ? entry.leaseUntil : entry.scheduledAt;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (due > this.now()) this.arm(entries);
			else void this.fire(entry.accountKey);
		}, Math.min(2_147_483_647, Math.max(0, due - this.now())));
		this.timer.unref();
	}

	async reconcile(feed: CodexUsageState): Promise<ProbeScheduleEntry[]> {
		if (process.env.PI_CODEX_ACCOUNT_MAINTENANCE) return [];
		const registry = await this.getRegistry();
		const now = this.now();
		const observations: Array<[string, ProbeStatus, Record<string, unknown>]> = [];
		const entries = await this.locked(async (schedule) => {
			const telemetry = new Map(feed.accounts.map((account) => [account.accountKey, account]));
			const existing = new Map(schedule.entries.map((entry) => [entry.accountKey, entry]));
			const next: ProbeScheduleEntry[] = [];
			for (const account of registry.accounts) {
				if (account.policyClass === "unknown") continue;
				const sample = telemetry.get(account.accountKey);
				const prior = existing.get(account.accountKey);
				const plan = probePlan(sample, now);
				if (!plan) {
					if (prior && sample && !sample.status429 && sample.fetchedAt > prior.baselineFetchedAt)
						observations.push([account.providerId, "200", { fetchedAt: sample.fetchedAt }]);
					continue;
				}
				if (
					prior &&
					!(sample && sample.fetchedAt > prior.baselineFetchedAt) &&
					(prior.leaseToken || prior.attempts > 0 || prior.scheduledAt <= plan.at)
				) {
					next.push(prior);
					continue;
				}
				const entry: ProbeScheduleEntry = {
					accountKey: account.accountKey,
					providerId: account.providerId,
					scheduledAt: plan.at,
					baselineFetchedAt: sample?.fetchedAt ?? 0,
					attempts: 0,
					reason: plan.reason,
				};
				next.push(entry);
				observations.push([account.providerId, "scheduled", { scheduledAt: entry.scheduledAt, reason: entry.reason }]);
			}
			schedule.entries = next.sort((a, b) => a.accountKey.localeCompare(b.accountKey));
			await this.write(schedule);
			return schedule.entries;
		});
		for (const observation of observations) await this.observe(...observation);
		this.arm(entries);
		return structuredClone(entries);
	}

	private async loadFeed(): Promise<CodexUsageState> {
		return parseUsageState(JSON.parse(await readFile(this.feedPath, "utf8")) as unknown);
	}

	private retryAt(account: CodexAccount | undefined, attempts: number, now: number): number {
		if (account?.status429 && probePlan(account, now)?.reason === "429 without reset timer")
			return now + HOURLY_PROBE_MS;
		const backoff = now + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
		const nextReset = account?.windows.filter((window) => window.resetAt * 1000 > now)
			.map((window) => window.resetAt * 1000 + GRACE_MS).sort((a, b) => a - b)[0];
		return nextReset === undefined ? backoff : Math.min(backoff, nextReset);
	}

	private async fire(accountKey: string): Promise<void> {
		if (this.closed) return;
		const now = this.now();
		const token = randomUUID();
		const claimed = await this.locked(async (schedule) => {
			const entry = schedule.entries.find((candidate) => candidate.accountKey === accountKey);
			if (!entry) return undefined;
			const due = entry.leaseUntil && entry.leaseUntil > now ? entry.leaseUntil : entry.scheduledAt;
			if (due > now) {
				for (const candidate of schedule.entries)
					if (!candidate.leaseToken && candidate.scheduledAt <= now)
						candidate.scheduledAt = due + GLOBAL_SPACING_MS;
				await this.write(schedule);
				this.arm(schedule.entries);
				return undefined;
			}
			if (schedule.notBefore !== undefined && schedule.notBefore > now) {
				for (const candidate of schedule.entries)
					if (!candidate.leaseToken && candidate.scheduledAt <= now)
						candidate.scheduledAt = schedule.notBefore;
				await this.write(schedule);
				this.arm(schedule.entries);
				return undefined;
			}
			const activeLease = schedule.entries.find((candidate) =>
				candidate.accountKey !== accountKey && candidate.leaseUntil !== undefined && candidate.leaseUntil > now,
			);
			if (activeLease) {
				for (const candidate of schedule.entries)
					if (!candidate.leaseToken && candidate.scheduledAt <= now)
						candidate.scheduledAt = activeLease.leaseUntil! + GLOBAL_SPACING_MS;
				await this.write(schedule);
				this.arm(schedule.entries);
				return undefined;
			}
			entry.leaseToken = token;
			entry.leaseUntil = now + LEASE_MS;
			await this.write(schedule);
			return structuredClone(entry);
		});
		if (!claimed) return;
		await this.observe(claimed.providerId, "fired", { attempt: claimed.attempts + 1 });
		const result = await this.launch(claimed.providerId);
		let feed: CodexUsageState | undefined;
		try { feed = await this.loadFeed(); } catch {}
		const sample = feed?.accounts.find((account) => account.accountKey === accountKey);
		const recovered = !!sample && !sample.status429 && sample.fetchedAt > claimed.baselineFetchedAt;
		const status: ProbeStatus = recovered ? "200" : result.timedOut ? "timeout" : "429";
		let updated: ProbeScheduleEntry[] = [];
		await this.locked(async (schedule) => {
			const index = schedule.entries.findIndex((entry) => entry.accountKey === accountKey && entry.leaseToken === token);
			if (index < 0) { updated = schedule.entries; return; }
			if (recovered) schedule.entries.splice(index, 1);
			else {
				const entry = schedule.entries[index]!;
				entry.attempts++;
				entry.baselineFetchedAt = Math.max(entry.baselineFetchedAt, sample?.fetchedAt ?? 0);
				entry.scheduledAt = this.retryAt(sample, entry.attempts - 1, this.now());
				entry.reason = `probe ${status}; retry ${entry.attempts}`;
				delete entry.leaseToken;
				delete entry.leaseUntil;
			}
			schedule.notBefore = this.now() + GLOBAL_SPACING_MS;
			await this.write(schedule);
			updated = schedule.entries;
		});
		await this.observe(claimed.providerId, status, {
			...result.details,
			...(sample ? { fetchedAt: sample.fetchedAt } : {}),
			...(recovered ? {} : { scheduledAt: updated.find((entry) => entry.accountKey === accountKey)?.scheduledAt }),
		});
		this.arm(updated);
	}

	async runDue(): Promise<void> {
		const schedule = await this.read();
		for (const entry of schedule.entries)
			if ((!entry.leaseUntil || entry.leaseUntil <= this.now()) && entry.scheduledAt <= this.now()) await this.fire(entry.accountKey);
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
