import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexAccount, CodexAccountRegistry, CodexUsageState, RegistryAccount } from "../codex-quota-extension/store.ts";
import { evaluateCodexRoute, evaluateCodexRouteFromFiles } from "./router.ts";

const now = 2_000_000_000_000;
const seconds = now / 1000;
const model = "gpt-6-astra";
const accounts: RegistryAccount[] = ["openai-codex-first", "openai-codex", "openai-codex-third"].map((providerId) => ({
	accountKey: providerId, providerId, credentialRef: providerId, label: providerId,
	policyClass: providerId === "openai-codex" ? "stable-weekly" : "perishable",
	supportedModels: [model, "gpt-5.6-sol", "gpt-6.1-sol"],
}));
const registry: CodexAccountRegistry = { schemaVersion: 1, umbrellaProviderId: "openai-codex-personal", accounts };
const telemetry = (account: RegistryAccount, weekly = 20, short = 30): CodexAccount => ({
	accountKey: account.accountKey, id: account.providerId, label: account.label, plan: "plus",
	policyClass: account.policyClass, supportedModels: account.supportedModels,
	captureHealth: "healthy", lastAttemptAt: now, fetchedAt: now,
	windows: [
		{ minutes: 300, pctUsed: short, resetAt: seconds + 7200, slopePctPerHour: null, projectedExhaustAt: null },
		{ minutes: 10080, pctUsed: weekly, resetAt: seconds + 4 * 86400, slopePctPerHour: null, projectedExhaustAt: null },
	],
	status429: false, retryAfter: null, notBefore: null, parseErrors: [],
});
const feed = (...samples: CodexAccount[]): CodexUsageState => ({ schemaVersion: 2, generation: 42, generatedAt: now, accounts: samples });
const order = (samples: CodexAccount[], routedModel = model, configured = registry) => evaluateCodexRoute({
	registry: configured, feed: feed(...samples), model: routedModel, now,
}).candidates.map((candidate) => candidate.actualProviderId);

test("configured account priority, regardless of quota headroom, model or registry order", () => {
	const configured = { ...registry, accounts: [...accounts].reverse() };
	for (const routedModel of accounts[0]!.supportedModels) {
		assert.deepEqual(order([telemetry(accounts[2]!, 0, 0), telemetry(accounts[1]!, 0, 0), telemetry(accounts[0]!, 99, 99)], routedModel, configured),
			accounts.map((account) => account.providerId));
	}
});

test("skip exhausted accounts in that same order", () => {
	assert.deepEqual(order([telemetry(accounts[0]!, 100), telemetry(accounts[1]!), telemetry(accounts[2]!)]),
		["openai-codex", "openai-codex-third"]);
	assert.deepEqual(order([telemetry(accounts[0]!, 100), telemetry(accounts[1]!, 20, 100), telemetry(accounts[2]!)]),
		["openai-codex-third"]);
});

test("registry model support, not stale telemetry, decides compatibility", () => {
	const samples = accounts.map((account) => telemetry(account));
	samples[0]!.supportedModels = [];
	const configured = { ...registry, accounts: accounts.map((account) => account.providerId === "openai-codex-first"
		? { ...account, supportedModels: [model] } : account) };
	assert.deepEqual(order(samples, "gpt-6.1-sol", configured), ["openai-codex", "openai-codex-third"]);
});

test("unsupported models and missing telemetry fail closed", () => {
	const unavailable = evaluateCodexRoute({ registry, feed: feed(...accounts.map((account) => telemetry(account))), model: "gpt-9-missing", now });
	assert.equal(unavailable.allBlocked, true);
	assert.match(unavailable.error!, /no configured Codex account supports/);
	const missing = evaluateCodexRoute({ registry, feed: feed(), model, now });
	assert.equal(missing.allBlocked, true);
	assert.match(missing.error!, /TELEMETRY MISSING/);
});

test("all exhausted accounts report earliest recovery", () => {
	const result = evaluateCodexRoute({ registry, feed: feed(...accounts.map((account) => telemetry(account, 20, 100))), model, now });
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /WINDOW EXHAUSTED 300m/);
	assert.match(result.error!, new RegExp(`Earliest recovery: ${new Date((seconds + 7200) * 1000).toISOString()}`));
});

test("split quota windows across accounts cannot form a route", () => {
	const samples = accounts.slice(0, 2).map((account) => telemetry(account));
	samples[0]!.windows = samples[0]!.windows.filter((window) => window.minutes === 300);
	samples[1]!.windows = samples[1]!.windows.filter((window) => window.minutes === 10080);
	assert.deepEqual(order(samples), []);
});

test("Pro accounts can route with weekly-only quota", () => {
	const pro = telemetry(accounts[2]!);
	pro.plan = "prolite";
	pro.windows = pro.windows.filter((window) => window.minutes === 10080);
	assert.deepEqual(order([pro]), ["openai-codex-third"]);
});

test("old samples do not invent usage or change priority", () => {
	const samples = accounts.map((account) => telemetry(account));
	samples[0]!.fetchedAt = now - 86400_000;
	samples[0]!.captureHealth = "degraded";
	samples[0]!.parseErrors = ["meter offline"];
	samples[0]!.windows[0]!.slopePctPerHour = 100;
	assert.deepEqual(order(samples), accounts.map((account) => account.providerId));
	assert.deepEqual(samples[0]!.windows.map((window) => window.pctUsed), [30, 20]);
});

test("cooldowns block until elapsed; resets permit a real request to verify capacity", () => {
	const personal = telemetry(accounts[1]!, 20, 100);
	personal.status429 = true;
	personal.notBefore = seconds + 60;
	assert.deepEqual(order([personal]), []);
	personal.notBefore = seconds - 1;
	assert.deepEqual(order([personal]), []); // The short window is still exhausted.
	personal.windows[0]!.resetAt = seconds - 1;
	assert.deepEqual(order([personal]), ["openai-codex"]);
	personal.windows[1]!.pctUsed = 100;
	assert.deepEqual(order([personal]), []); // A future weekly exhaustion still blocks.
	personal.windows[1]!.resetAt = seconds - 1;
	assert.deepEqual(order([personal]), ["openai-codex"]);
	personal.notBefore = null;
	assert.deepEqual(order([personal]), []); // A 429 without any known cooldown stays blocked.
});

test("malformed feeds refuse when observability has no usable fallback", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-router-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "registry.json");
	const feedPath = join(directory, "feed.json");
	await writeFile(registryPath, JSON.stringify(registry));
	await writeFile(feedPath, "{broken");
	const result = evaluateCodexRouteFromFiles({ model, now, registryPath, feedPath, observabilityPath: join(directory, "missing.jsonl") });
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /observability fallback unavailable/);
});

test("uses cached observability quota when the state feed is corrupt or missing", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-router-cache-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "registry.json");
	const feedPath = join(directory, "feed.json");
	const observabilityPath = join(directory, "observability.jsonl");
	await writeFile(registryPath, JSON.stringify(registry));
	await writeFile(feedPath, "{broken");
	await writeFile(observabilityPath, `${JSON.stringify({
		capturedAt: new Date(now - 86400_000).toISOString(), kind: "http_response", provider: "openai-codex", status: 200,
		headers: { "x-codex-plan-type": "plus", "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "20",
			"x-codex-primary-reset-at": String(seconds + 7200), "x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-used-percent": "30", "x-codex-secondary-reset-at": String(seconds + 4 * 86400) },
	})}\n`);
	for (const missing of [false, true]) {
		if (missing) await rm(feedPath);
		const result = evaluateCodexRouteFromFiles({ model, now, registryPath, feedPath, observabilityPath });
		assert.equal(result.allBlocked, false);
		assert.equal(result.feedSource, "observability");
		assert.equal(result.candidates[0]?.actualProviderId, "openai-codex");
		assert.equal(result.accounts.find((entry) => entry.account.providerId === "openai-codex")?.telemetry?.windows[0]?.pctUsed, 20);
	}
});
