import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProbeScheduler, probePlan, type ProbeScheduleEntry, type ProbeStatus } from "./probe-scheduler.ts";
import type { CodexAccount, CodexAccountRegistry, CodexUsageState } from "./store.ts";

const now = 2_000_000_000_000;
const registry: CodexAccountRegistry = {
	schemaVersion: 1,
	umbrellaProviderId: "openai-codex-personal",
	accounts: [{
		accountKey: "personal-key",
		providerId: "openai-codex",
		credentialRef: "openai-codex",
		label: "Personal",
		policyClass: "stable-weekly",
		supportedModels: ["gpt-5.6-sol"],
	}],
};

const account = (overrides: Partial<CodexAccount> = {}): CodexAccount => ({
	accountKey: "personal-key",
	id: "openai-codex",
	label: "Personal",
	plan: "plus",
	policyClass: "stable-weekly",
	supportedModels: ["gpt-5.6-sol"],
	captureHealth: "healthy",
	lastAttemptAt: now - 1_000,
	fetchedAt: now - 1_000,
	windows: [
		{ minutes: 300, pctUsed: 20, resetAt: now / 1000 + 3600, slopePctPerHour: null, projectedExhaustAt: null },
		{ minutes: 10080, pctUsed: 20, resetAt: now / 1000 + 86_400, slopePctPerHour: null, projectedExhaustAt: null },
	],
	status429: true,
	retryAfter: null,
	notBefore: now / 1000 + 60,
	parseErrors: [],
	...overrides,
});

const feed = (sample: CodexAccount): CodexUsageState => ({
	schemaVersion: 2,
	generation: 1,
	generatedAt: now,
	accounts: [sample],
});

const writeSchedule = (path: string, entry: ProbeScheduleEntry) => writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [entry] }));
const scheduled = (overrides: Partial<ProbeScheduleEntry> = {}): ProbeScheduleEntry => ({
	accountKey: "personal-key",
	providerId: "openai-codex",
	scheduledAt: now - 1,
	baselineFetchedAt: now - 1_000,
	attempts: 0,
	reason: "test",
	...overrides,
});

test("background lock timeout is contained, rearmed, and recovers after release", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-lock-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const feedPath = join(directory, "feed.json");
	let launches = 0;
	const failed = Promise.withResolvers<string>();
	const scheduler = new ProbeScheduler({
		path, feedPath, registry, now: () => now,
		launch: async () => { launches++; return { timedOut: false, details: {} }; },
		observe: (_provider, status, details) => {
			if (status === "error") {
				failed.resolve(String(details.error));
				throw new Error("diagnostics unavailable");
			}
		},
	});
	t.after(() => scheduler.close());
	await scheduler.reconcile(feed(account({ fetchedAt: 0 })));
	await writeFile(`${path}.lock`, "");
	assert.match(await failed.promise, /Timed out waiting for Codex probe schedule lock/);
	assert.equal(launches, 0);
	await unlink(`${path}.lock`);
	await writeFile(feedPath, JSON.stringify(feed(account({ status429: false, fetchedAt: now }))));
	await scheduler.runDue();
	assert.equal(launches, 1);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).entries, []);
});

test("schedules a 429 probe at notBefore plus grace", () => {
	assert.equal(probePlan(account(), now)?.at, now + 90_000);
});

test("checks an exhausted account without a reset timer hourly", () => {
	assert.deepEqual(probePlan(account({ notBefore: now / 1000 - 1 }), now), {
		at: now + 3_599_000,
		reason: "429 without reset timer",
	});
});

test("probes zero telemetry immediately", () => {
	assert.equal(probePlan(undefined, now)?.at, now);
});

test("does not probe accounts excluded from rotation", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-unknown-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const unknownRegistry: CodexAccountRegistry = {
		...registry,
		accounts: [{ ...registry.accounts[0], policyClass: "unknown" }],
	};
	const scheduler = new ProbeScheduler({ path, registry: unknownRegistry, now: () => now, observe: () => {} });
	assert.deepEqual(await scheduler.reconcile({ ...feed(account()), accounts: [] }), []);
	scheduler.close();
});

test("schedules confirmation at the next reset even when it has no usage", () => {
	const healthy = account({
		status429: false,
		notBefore: null,
		windows: [
			{ minutes: 300, pctUsed: 0, resetAt: now / 1000 + 3600, slopePctPerHour: null, projectedExhaustAt: null },
			{ minutes: 10080, pctUsed: 20, resetAt: now / 1000 + 86_400, slopePctPerHour: null, projectedExhaustAt: null },
		],
	});
	assert.deepEqual(probePlan(healthy, now), {
		at: now + 3_630_000,
		reason: "usage window reset",
	});
});

test("probes stale healthy telemetry once reconciliation notices it", () => {
	const stale = account({ status429: false, notBefore: null, fetchedAt: now - 15 * 60_000 });
	assert.deepEqual(probePlan(stale, now), { at: now, reason: "stale telemetry" });
});

test("waits for the next weekly reset after a blocking window expires", () => {
	const weeklyReset = now / 1000 + 86_400;
	const blocked = account({
		notBefore: now / 1000 - 60,
		windows: [
			{ minutes: 300, pctUsed: 100, resetAt: now / 1000 - 1, slopePctPerHour: null, projectedExhaustAt: null },
			{ minutes: 10080, pctUsed: 100, resetAt: weeklyReset, slopePctPerHour: null, projectedExhaustAt: null },
		],
	});
	assert.equal(probePlan(blocked, now)?.at, weeklyReset * 1000 + 30_000);
});

test("an exhausted account without a reset timer stays on hourly retries", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-retry-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const feedPath = join(directory, "feed.json");
	await writeSchedule(path, scheduled());
	await writeFile(feedPath, JSON.stringify(feed(account({
		fetchedAt: now + 1_000,
		lastAttemptAt: now,
		notBefore: now / 1000 - 1,
	}))));
	const observations: ProbeStatus[] = [];
	const scheduler = new ProbeScheduler({
		path, feedPath, registry, now: () => now,
		launch: async () => ({ timedOut: false, details: {} }),
		observe: (_provider, status) => { observations.push(status); },
	});
	await scheduler.runDue();
	const state = JSON.parse(await readFile(path, "utf8"));
	assert.equal(state.entries[0].scheduledAt, now + 60 * 60_000);
	assert.equal(state.entries[0].attempts, 1);
	assert.deepEqual(observations, ["fired", "429"]);
	scheduler.close();
});

test("a fresh 200 clears the schedule", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-200-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const feedPath = join(directory, "feed.json");
	await writeSchedule(path, scheduled());
	await writeFile(feedPath, JSON.stringify(feed(account({ status429: false, notBefore: null, fetchedAt: now + 1_000 }))));
	const observations: ProbeStatus[] = [];
	const scheduler = new ProbeScheduler({
		path, feedPath, registry, now: () => now,
		launch: async () => ({ timedOut: false, details: {} }),
		observe: (_provider, status) => { observations.push(status); },
	});
	await scheduler.runDue();
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).entries, []);
	assert.deepEqual(observations, ["fired", "200"]);
	scheduler.close();
});

test("persists schedules across scheduler restarts with mode 0600", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-persist-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const first = new ProbeScheduler({ path, registry, now: () => now, observe: () => {} });
	const initial = await first.reconcile(feed(account()));
	first.close();
	const second = new ProbeScheduler({ path, registry, now: () => now, observe: () => {} });
	const restored = await second.reconcile(feed(account()));
	assert.deepEqual(restored, initial);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	second.close();
});

test("staleness supersedes a later usage-reset probe", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-stale-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	await writeSchedule(path, scheduled({ scheduledAt: now + 3_630_000, reason: "usage window reset" }));
	const scheduler = new ProbeScheduler({ path, registry, now: () => now, observe: () => {} });
	const entries = await scheduler.reconcile(feed(account({
		status429: false,
		notBefore: null,
		fetchedAt: now - 15 * 60_000,
	})));
	assert.equal(entries[0].scheduledAt, now);
	assert.equal(entries[0].reason, "stale telemetry");
	scheduler.close();
});

test("reconciliation advances an old schedule when an earlier window expires", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-expired-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	await writeSchedule(path, scheduled({ scheduledAt: now + 86_430_000, reason: "usage window reset" }));
	const scheduler = new ProbeScheduler({ path, registry, now: () => now, observe: () => {} });
	const entries = await scheduler.reconcile(feed(account({
		status429: false,
		notBefore: null,
		windows: [
			{ minutes: 300, pctUsed: 0, resetAt: now / 1000 - 1, slopePctPerHour: null, projectedExhaustAt: null },
			{ minutes: 10080, pctUsed: 20, resetAt: now / 1000 + 86_400, slopePctPerHour: null, projectedExhaustAt: null },
		],
	})));
	assert.equal(entries[0].scheduledAt, now);
	assert.equal(entries[0].reason, "window reset unproven");
	scheduler.close();
});

test("reconciliation replaces a recovered block with its next reset probe", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-recovered-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	await writeSchedule(path, scheduled({ scheduledAt: now + 60_000 }));
	const observations: ProbeStatus[] = [];
	const scheduler = new ProbeScheduler({
		path, registry, now: () => now,
		observe: (_provider, status) => { observations.push(status); },
	});
	const entries = await scheduler.reconcile(feed(account({ status429: false, notBefore: null, fetchedAt: now + 1 })));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].scheduledAt, now + 3_630_000);
	assert.equal(entries[0].reason, "usage window reset");
	assert.deepEqual(observations, ["scheduled"]);
	scheduler.close();
});

test("shared leases allow only one account probe at a time", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-global-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const feedPath = join(directory, "feed.json");
	const secondRegistry: CodexAccountRegistry = {
		...registry,
		accounts: [
			...registry.accounts,
			{ ...registry.accounts[0], accountKey: "alt-key", providerId: "openai-codex-alt", label: "Alt" },
		],
	};
	const secondSample = account({ accountKey: "alt-key", id: "openai-codex-alt", label: "Alt" });
	await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [
		scheduled(),
		{ ...scheduled(), accountKey: "alt-key", providerId: "openai-codex-alt" },
	] }));
	await writeFile(feedPath, JSON.stringify({ ...feed(account()), accounts: [account(), secondSample] }));
	let active = 0;
	let maximumActive = 0;
	let launches = 0;
	const launch = async () => {
		launches++;
		active++;
		maximumActive = Math.max(maximumActive, active);
		await new Promise((resolve) => setTimeout(resolve, 25));
		active--;
		return { timedOut: false, details: {} };
	};
	const first = new ProbeScheduler({ path, feedPath, registry: secondRegistry, now: () => now, launch, observe: () => {} });
	const second = new ProbeScheduler({ path, feedPath, registry: secondRegistry, now: () => now, launch, observe: () => {} });
	await Promise.all([first.runDue(), second.runDue()]);
	assert.equal(maximumActive, 1);
	assert.equal(launches, 1);
	first.close();
	second.close();
});
