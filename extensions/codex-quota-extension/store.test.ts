import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	allowlistedHeaders,
	type CodexAccountRegistry,
	CodexUsageStore,
	normalizeObservation,
	parseRegistry,
	quotaStatus,
	resetNotes,
	type RegistryAccount,
} from "./store.ts";

const alt: RegistryAccount = {
	accountKey: "account-alt",
	providerId: "openai-codex-alt",
	credentialRef: "openai-codex-alt",
	label: "Alt",
	policyClass: "perishable",
	supportedModels: ["gpt-5.6-sol"],
};
const team: RegistryAccount = {
	accountKey: "account-team",
	providerId: "openai-codex-team",
	credentialRef: "openai-codex-team",
	label: "Team",
	policyClass: "unknown",
	supportedModels: ["gpt-5.6-sol"],
};
const registry: CodexAccountRegistry = {
	schemaVersion: 1,
	umbrellaProviderId: "openai-codex-personal",
	accounts: [alt, team],
};

const headers = (primaryPct = "46", primaryReset = "2000") => ({
	"X-Codex-Plan-Type": "edu",
	"X-Codex-Primary-Used-Percent": primaryPct,
	"X-Codex-Primary-Window-Minutes": "300",
	"X-Codex-Primary-Reset-At": primaryReset,
	"X-Codex-Secondary-Used-Percent": "76",
	"X-Codex-Secondary-Window-Minutes": "10080",
	"X-Codex-Secondary-Reset-At": "7000",
	Authorization: "secret",
	Cookie: "secret",
	"X-Request-Id": "request-1",
});

const state = (accounts: ReturnType<typeof normalizeObservation>[], current = alt) => ({
	schemaVersion: 2 as const,
	generation: 1,
	generatedAt: 1_000_000,
	accounts,
	current: current.providerId,
	currentAccountKey: current.accountKey,
});

test("allowlists quota diagnostics without credentials", () => {
	assert.deepEqual(allowlistedHeaders(headers()), {
		"x-codex-plan-type": "edu",
		"x-codex-primary-used-percent": "46",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": "2000",
		"x-codex-secondary-used-percent": "76",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": "7000",
		"x-request-id": "request-1",
	});
});

test("rejects ambiguous provider mappings", () => {
	assert.throws(
		() => parseRegistry({ ...registry, accounts: [alt, { ...team, providerId: alt.providerId }] }),
		/mappings must be unique/,
	);
});

test("normalizes schema-2 identity and suppresses zero-minute windows", () => {
	const account = normalizeObservation(
		alt,
		200,
		{ ...headers(), "X-Codex-Secondary-Window-Minutes": "0", "X-Codex-Secondary-Reset-At": "" },
		undefined,
		1_000_000,
	);
	assert.equal(account.accountKey, alt.accountKey);
	assert.equal(account.policyClass, "perishable");
	assert.deepEqual(account.supportedModels, ["gpt-5.6-sol"]);
	assert.deepEqual(account.windows, [
		{ minutes: 300, pctUsed: 46, resetAt: 2000, slopePctPerHour: null, projectedExhaustAt: null },
	]);
	assert.equal(account.captureHealth, "healthy");
	assert.equal(account.lastAttemptAt, 1_000_000);
});

test("projects exhaustion only from sufficiently separated same-epoch samples", () => {
	const before = normalizeObservation(alt, 200, headers("40", "2000"), undefined, 1_000_000);
	const projected = normalizeObservation(alt, 200, headers("42", "2000"), before, 1_600_000);
	assert.equal(projected.windows[0]?.slopePctPerHour, 12);
	assert.equal(projected.windows[0]?.projectedExhaustAt, 19_000);
	const tooSoon = normalizeObservation(alt, 200, headers("44", "2000"), projected, 1_800_000);
	assert.equal(tooSoon.windows[0]?.slopePctPerHour, null);
	assert.equal(tooSoon.windows[0]?.projectedExhaustAt, null);
});

test("headerless 429 retains windows and only a valid 200 clears blocking", () => {
	const before = normalizeObservation(alt, 200, headers(), undefined, 1_000_000);
	const blocked = normalizeObservation(alt, 429, {}, before, 1_100_000);
	assert.deepEqual(blocked.windows, before.windows);
	assert.equal(blocked.fetchedAt, 1_100_000);
	assert.equal(blocked.status429, true);
	assert.equal(blocked.notBefore, 2000);
	const status = quotaStatus(state([blocked]), 1_100_000);
	assert.equal(status?.routable, false);
	assert.equal(status?.recoveryAt, 2000);

	const cleared = normalizeObservation(alt, 200, headers(), blocked, 1_200_000);
	assert.equal(cleared.status429, false);
	assert.equal(cleared.notBefore, null);
});

test("detects reset epochs and percentage drops", () => {
	const before = normalizeObservation(alt, 200, headers("46", "2000"), undefined, 1_000_000);
	const next = normalizeObservation(alt, 200, headers("40", "3000"), before, 1_100_000);
	assert.deepEqual(resetNotes(before, next), ["openai-codex-alt 300m reset observed"]);
});

test("quota status consolidates each account's usable bottleneck", () => {
	const available = normalizeObservation(alt, 200, headers("0"), undefined, 1_000_000);
	const exhausted = normalizeObservation({ ...team, policyClass: "perishable" }, 200, headers("100"), undefined, 1_000_000);
	const status = quotaStatus(state([exhausted, available]), 1_000_000);
	assert.equal(status.global, 12);
	assert.equal(status.refillAt, 2000);
	assert.equal(status.routable, true);
	assert.equal(quotaStatus(state([available]), 1_000_000, 3).global, 8);
});

test("quota status zeros expired or complementary account capacity", () => {
	const expired = normalizeObservation(alt, 200, headers("0"), undefined, 1_000_000);
	expired.windows.find((window) => window.minutes === 300)!.resetAt = 999;
	const expiredStatus = quotaStatus(state([expired]), 1_000_000);
	assert.equal(expiredStatus.global, 0);
	assert.equal(expiredStatus.routable, false);

	const shortExhausted = normalizeObservation(
		alt,
		200,
		{ ...headers("100"), "X-Codex-Secondary-Used-Percent": "58" },
		undefined,
		1_000_000,
	);
	const weekExhausted = normalizeObservation(
		{ ...team, policyClass: "perishable" },
		200,
		{ ...headers("0"), "X-Codex-Secondary-Used-Percent": "100" },
		undefined,
		1_000_000,
	);
	const blocked = quotaStatus(state([shortExhausted, weekExhausted]), 1_000_000);
	assert.equal(blocked.global, 0);
	assert.equal(blocked.routable, false);
	assert.equal(blocked.recoveryAt, 2000);

	const aged = normalizeObservation(alt, 200, headers("20"), undefined, 1_000_000);
	const agedStatus = quotaStatus(state([aged]), 1_000_000 + 15 * 60_000 + 1);
	assert.equal(agedStatus.global, 10);
	assert.equal(agedStatus.routable, true);
	assert.equal(agedStatus.stale, false);
	assert.equal(agedStatus.aged, true);
});

test("quota status is stale only when the router has no route or recovery", () => {
	assert.deepEqual(quotaStatus(undefined), { routable: false, stale: true });
	const blocked = normalizeObservation(alt, 200, headers("20"), undefined, 1_000_000);
	blocked.notBefore = 2000;
	const recovering = quotaStatus(state([blocked]), 1_000_000);
	assert.equal(recovering.global, 0);
	assert.equal(recovering.refillAt, 2000);
	assert.equal(recovering.routable, false);
	assert.equal(recovering.recoveryAt, 2000);
	assert.equal(recovering.stale, false);

	const elapsed429 = normalizeObservation(alt, 429, { "Retry-After": "10" }, blocked, 1_100_000);
	const stale = quotaStatus(state([elapsed429]), 1_200_000);
	assert.equal(stale.global, 0);
	assert.equal(stale.routable, false);
	assert.equal(stale.stale, true);
});

test("migrates schema-1 state through immutable registry identity", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-v1-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	await writeFile(
		path,
		JSON.stringify({
			accounts: [
				{
					id: alt.providerId,
					plan: "edu",
					windows: [{ minutes: 300, pctUsed: 46, resetAt: 2000 }],
					status429: false,
					fetchedAt: 1_000_000,
				},
			],
			current: alt.providerId,
		}),
	);
	const migrated = await new CodexUsageStore(path, registry).load();
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(migrated.currentAccountKey, alt.accountKey);
	assert.equal(migrated.accounts[0]?.accountKey, alt.accountKey);
	assert.equal(migrated.accounts[0]?.windows[0]?.slopePctPerHour, null);
});

test("persists degraded capture health without replacing accepted windows", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new CodexUsageStore(join(directory, "state.json"), registry);
	store.observe(alt.providerId, 200, headers(), 1_000_000);
	store.recordFailure(alt.providerId, new Error("bad headers"), 1_100_000);
	const degraded = store.snapshot().accounts[0]!;
	assert.equal(degraded.captureHealth, "degraded");
	assert.equal(degraded.lastAttemptAt, 1_100_000);
	assert.equal(degraded.fetchedAt, 1_000_000);
	assert.equal(degraded.windows.length, 2);
	assert.deepEqual(degraded.parseErrors, ["bad headers"]);
});

test("merges concurrent account writers under a lock", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-merge-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const first = new CodexUsageStore(path, registry);
	const second = new CodexUsageStore(path, registry);
	await Promise.all([first.load(), second.load()]);
	first.observe(alt.providerId, 200, headers(), 1_000_000);
	second.observe(
		team.providerId,
		200,
		{
			"x-codex-plan-type": "business",
			"x-codex-primary-window-minutes": "0",
			"x-codex-secondary-window-minutes": "0",
		},
		1_000_000,
	);
	await Promise.all([first.write(), second.write()]);
	const merged = JSON.parse(await readFile(path, "utf8"));
	assert.equal(merged.schemaVersion, 2);
	assert.equal(merged.generation, 2);
	assert.deepEqual(
		merged.accounts.map((account: { accountKey: string }) => account.accountKey).sort(),
		[team.accountKey, alt.accountKey].sort(),
	);
});

test("writes state atomically with mode 0600", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const store = new CodexUsageStore(path, registry);
	store.observe(alt.providerId, 200, headers(), 1_000_000);
	store.observe(alt.providerId, 429, {}, 1_100_000);
	await store.write();
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const blocked = JSON.parse(await readFile(path, "utf8"));
	assert.equal(blocked.schemaVersion, 2);
	assert.equal(blocked.generation, 1);
	assert.equal(blocked.currentAccountKey, alt.accountKey);
	assert.equal(blocked.accounts[0].notBefore, 2000);
	assert.deepEqual((await readdir(directory)).sort(), ["state.json"]);
});
