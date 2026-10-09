import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowlistedHeaders, type CodexAccountRegistry, CodexUsageStore, evaluateQuotaAccount,
	normalizeObservation, parseRegistry, quotaBuckets, resetNotes, type RegistryAccount } from "./store.ts";

const alt: RegistryAccount = { accountKey: "account-alt", providerId: "openai-codex-alt", credentialRef: "openai-codex-alt",
	label: "Alt", policyClass: "perishable", supportedModels: ["gpt-6-astra"] };
const team: RegistryAccount = { ...alt, accountKey: "account-team", providerId: "openai-codex-team", credentialRef: "openai-codex-team", label: "Team" };
const registry: CodexAccountRegistry = { schemaVersion: 1, umbrellaProviderId: "openai-codex-personal", accounts: [alt, team] };
const headers = (short = "46", reset = "2000", weekly = "76", plan = "edu_plus") => ({
	"X-Codex-Plan-Type": plan, "X-Codex-Primary-Used-Percent": short,
	"X-Codex-Primary-Window-Minutes": "300", "X-Codex-Primary-Reset-At": reset,
	"X-Codex-Secondary-Used-Percent": weekly, "X-Codex-Secondary-Window-Minutes": "10080",
	"X-Codex-Secondary-Reset-At": "7000", Authorization: "secret", Cookie: "secret", "X-Request-Id": "request-1",
});
const state = (accounts: ReturnType<typeof normalizeObservation>[]) => ({ schemaVersion: 2 as const, generation: 1, generatedAt: 1_000_000, accounts });

test("allowlists diagnostics without credentials and rejects ambiguous identities", () => {
	const allowed = allowlistedHeaders(headers());
	assert.equal(allowed.authorization, undefined);
	assert.equal(allowed.cookie, undefined);
	assert.equal(allowed["x-codex-primary-used-percent"], "46");
	assert.equal(allowed["x-request-id"], "request-1");
	assert.throws(() => parseRegistry({ ...registry, accounts: [alt, { ...team, providerId: alt.providerId }] }), /mappings must be unique/);
});

test("normalizes identity, suppresses zero-minute windows and rejects bad readings", () => {
	const account = normalizeObservation(alt, 200, { ...headers(), "X-Codex-Secondary-Window-Minutes": "0" }, undefined, 1_000_000);
	assert.equal(account.accountKey, alt.accountKey);
	assert.deepEqual(account.supportedModels, alt.supportedModels);
	assert.deepEqual(account.windows, [{ minutes: 300, pctUsed: 46, resetAt: 2000, slopePctPerHour: null, projectedExhaustAt: null }]);
	assert.throws(() => normalizeObservation(alt, 200, headers("101")), /used percent is invalid/);
	assert.throws(() => normalizeObservation(alt, 200, {}), /quota headers are missing/);
});

test("reports observed usage without projecting further consumption while idle", () => {
	const before = normalizeObservation(alt, 200, headers("40"), undefined, 1_000_000);
	const next = normalizeObservation(alt, 200, headers("42"), before, 1_600_000);
	assert.equal(next.windows[0]!.pctUsed, 42);
	assert.equal(next.windows[0]!.slopePctPerHour, null);
	assert.equal(next.windows[0]!.projectedExhaustAt, null);
	assert.equal(quotaBuckets(state([next]), 1_900_000)[0]!.remaining, 58);
});

test("headerless 429 retains readings, cooldown gates routing, valid 200 clears it", () => {
	const before = normalizeObservation(alt, 200, headers(), undefined, 1_000_000);
	const blocked = normalizeObservation(alt, 429, {}, before, 1_100_000);
	assert.deepEqual(blocked.windows, before.windows);
	assert.equal(blocked.notBefore, 2000);
	assert.equal(evaluateQuotaAccount(blocked, 1_100_000).routable, false);
	assert.equal(evaluateQuotaAccount(blocked, 2_000_001).routable, true);
	const cleared = normalizeObservation(alt, 200, headers(), blocked, 1_200_000);
	assert.equal(cleared.status429, false);
	assert.equal(cleared.notBefore, null);
});

test("detects reset epochs and percentage drops", () => {
	const before = normalizeObservation(alt, 200, headers(), undefined, 1_000_000);
	const next = normalizeObservation(alt, 200, headers("40", "3000"), before, 1_100_000);
	assert.deepEqual(resetNotes(before, next), ["openai-codex-alt 300m reset observed"]);
});

test("weekly exhaustion blocks routing until reset without deleting short balance", () => {
	const sample = normalizeObservation(alt, 200, headers("20", "2000", "100"), undefined, 1_000_000);
	assert.equal(evaluateQuotaAccount(sample, 1_000_000).routable, false);
	const rows = quotaBuckets(state([sample]), 1_000_000);
	assert.equal(rows[0]!.remaining, 80);
	assert.equal(rows[0]!.blocked, true);
	assert.equal(rows[1]!.remaining, 0);
	assert.equal(evaluateQuotaAccount(sample, 7_000_001).routable, true);
	assert.equal(quotaBuckets(state([sample]), 7_000_001)[0]!.remaining, 80);
});

test("cached gauges keep exact percentages even after days without Codex usage", () => {
	const plus = normalizeObservation(alt, 200, headers("20", "2000", "76"), undefined, 1_000_000);
	for (const now of [1_960_000, 7_000_001, 1_000_000 + 7 * 86400_000]) {
		const rows = quotaBuckets(state([plus]), now);
		assert.deepEqual(rows.map((row) => row.remaining), [80, 24]);
		assert.ok(rows.every((row) => !("stale" in row)));
		assert.deepEqual(plus.windows.map((window) => window.pctUsed), [20, 76]);
	}
});

test("bucket gauges average all cached accounts per window; 429 does not erase them", () => {
	const plus = normalizeObservation(alt, 200, headers("37", "2000", "88"), undefined, 1_000_000);
	const another = normalizeObservation(team, 200, headers("100", "2600", "23", "plus"), undefined, 1_000_000);
	const pro = normalizeObservation(team, 200, { ...headers("0", "3000", "76", "prolite"),
		"X-Codex-Primary-Window-Minutes": "0" }, undefined, 1_000_000);
	const rows = quotaBuckets(state([plus, another, pro]), 1_000_000);
	assert.deepEqual(rows.map((row) => [row.bucket, row.window, row.remaining]),
		[["PLUS", "5H", 31.5], ["PLUS", "WEEK", 44.5], ["PRO", "WEEK", 24]]);
	assert.deepEqual(rows[0]!.increases, [{ at: 2000, percent: 18.5 }, { at: 2600, percent: 50 }]);
	const limited = normalizeObservation(alt, 429, { "Retry-After": "10" }, plus, 1_100_000);
	assert.deepEqual(quotaBuckets(state([limited]), 1_200_000).map((row) => row.remaining), [63, 12]);
	assert.ok(quotaBuckets(state([limited]), 1_200_000).every((row) => !row.blocked));
	assert.deepEqual(quotaBuckets(undefined), []);
	assert.deepEqual(quotaBuckets(state([])), []);
});

test("migrates old caches without losing percentages", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-v1-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	await writeFile(path, JSON.stringify({ accounts: [{ id: alt.providerId, plan: "edu_plus",
		windows: [{ minutes: 300, pctUsed: 46, resetAt: 2000 }], status429: false, fetchedAt: 1_000_000 }], current: alt.providerId }));
	const migrated = await new CodexUsageStore(path, registry).load();
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(migrated.currentAccountKey, alt.accountKey);
	assert.equal(migrated.accounts[0]!.windows[0]!.pctUsed, 46);
});

test("failed refresh and restart retain accepted usage", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-cache-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const store = new CodexUsageStore(path, registry);
	store.observe(alt.providerId, 200, headers(), 1_000_000);
	store.recordFailure(alt.providerId, new Error("bad headers"), 1_100_000);
	await store.write();
	const cached = await new CodexUsageStore(path, registry).load();
	assert.equal(cached.accounts[0]!.captureHealth, "degraded");
	assert.equal(cached.accounts[0]!.fetchedAt, 1_000_000);
	assert.deepEqual(cached.accounts[0]!.windows.map((window) => window.pctUsed), [46, 76]);
	assert.deepEqual(quotaBuckets(cached, 8_000_000).map((row) => row.remaining), [54, 24]);
});

test("concurrent account upserts preserve both accounts, atomic files and private permissions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-merge-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const first = new CodexUsageStore(path, registry);
	const second = new CodexUsageStore(path, registry);
	await Promise.all([first.load(), second.load()]);
	first.observe(alt.providerId, 200, headers(), 1_000_000);
	second.observe(team.providerId, 200, headers("12"), 1_100_000);
	await Promise.all([first.write(), second.write()]);
	const merged = JSON.parse(await readFile(path, "utf8"));
	assert.equal(merged.generation, 2);
	assert.deepEqual(merged.accounts.map((account: { accountKey: string }) => account.accountKey).sort(), [alt.accountKey, team.accountKey].sort());
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("an older writer or failed capture cannot overwrite a newer accepted reading", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-upsert-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const older = new CodexUsageStore(path, registry);
	const newer = new CodexUsageStore(path, registry);
	await Promise.all([older.load(), newer.load()]);
	older.observe(alt.providerId, 200, headers("40"), 1_000_000);
	newer.observe(alt.providerId, 200, headers("50"), 1_100_000);
	await newer.write();
	older.recordFailure(alt.providerId, "offline", 1_200_000);
	await older.write();
	const saved = await new CodexUsageStore(path, registry).load();
	assert.equal(saved.accounts[0]!.fetchedAt, 1_100_000);
	assert.equal(saved.accounts[0]!.windows[0]!.pctUsed, 50);
});
