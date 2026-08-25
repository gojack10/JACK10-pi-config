import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("schedules a 429 probe at notBefore plus grace", () => {
	assert.equal(probePlan(account(), now)?.at, now + 90_000);
});

test("probes an elapsed 429 cooldown immediately", () => {
	assert.equal(probePlan(account({ notBefore: now / 1000 - 1 }), now)?.at, now);
});

test("probes zero telemetry immediately", () => {
	assert.equal(probePlan(undefined, now)?.at, now);
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

test("a 429 probe reschedules with five-minute backoff", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-retry-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	const feedPath = join(directory, "feed.json");
	await writeSchedule(path, scheduled());
	await writeFile(feedPath, JSON.stringify(feed(account({ fetchedAt: now + 1_000, notBefore: now / 1000 - 1 }))));
	const observations: ProbeStatus[] = [];
	const scheduler = new ProbeScheduler({
		path, feedPath, registry, now: () => now,
		launch: async () => ({ timedOut: false, details: {} }),
		observe: (_provider, status) => { observations.push(status); },
	});
	await scheduler.runDue();
	const state = JSON.parse(await readFile(path, "utf8"));
	assert.equal(state.entries[0].scheduledAt, now + 5 * 60_000);
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

test("reconciliation drops accounts recovered since scheduling", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-probe-recovered-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "schedule.json");
	await writeSchedule(path, scheduled({ scheduledAt: now + 60_000 }));
	const observations: ProbeStatus[] = [];
	const scheduler = new ProbeScheduler({
		path, registry, now: () => now,
		observe: (_provider, status) => { observations.push(status); },
	});
	assert.deepEqual(await scheduler.reconcile(feed(account({ status429: false, notBefore: null, fetchedAt: now + 1 }))), []);
	assert.deepEqual(observations, ["200"]);
	scheduler.close();
});
