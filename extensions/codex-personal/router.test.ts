import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	CodexAccount,
	CodexAccountRegistry,
	CodexUsageState,
	RegistryAccount,
} from "../codex-quota-extension/store.ts";
import { evaluateCodexRoute, evaluateCodexRouteFromFiles, parseWorkInput } from "./router.ts";

const now = 2_000_000_000_000;
const nowSeconds = now / 1000;
const model = "gpt-5.6-sol";
const gpt56Models = ["gpt-5.6-luna", model, "gpt-5.6-terra"];
const personal: RegistryAccount = {
	accountKey: "personal-key",
	providerId: "openai-codex",
	credentialRef: "openai-codex",
	label: "Personal",
	policyClass: "stable-weekly",
	supportedModels: gpt56Models,
};
const alt: RegistryAccount = {
	accountKey: "alt-key",
	providerId: "openai-codex-alt",
	credentialRef: "openai-codex-alt",
	label: "Alt",
	policyClass: "perishable",
	supportedModels: gpt56Models,
};
const astra: RegistryAccount = {
	accountKey: "astra-key",
	providerId: "openai-codex-astra",
	credentialRef: "openai-codex-astra",
	label: "Astra",
	policyClass: "perishable",
	supportedModels: [...gpt56Models, "gpt-6-astra"],
};
const registry: CodexAccountRegistry = {
	schemaVersion: 1,
	umbrellaProviderId: "openai-codex-personal",
	accounts: [personal, alt],
};

const telemetry = (
	account: RegistryAccount,
	windows: Array<{ minutes: number; pctUsed: number; resetIn: number; projectedIn?: number | null }>,
	overrides: Partial<CodexAccount> = {},
): CodexAccount => ({
	accountKey: account.accountKey,
	id: account.providerId,
	label: account.label,
	plan: "test",
	policyClass: account.policyClass,
	supportedModels: [...account.supportedModels],
	captureHealth: "healthy",
	lastAttemptAt: now,
	fetchedAt: now,
	windows: windows.map((window) => ({
		minutes: window.minutes,
		pctUsed: window.pctUsed,
		resetAt: nowSeconds + window.resetIn,
		slopePctPerHour: window.projectedIn === undefined ? null : 1,
		projectedExhaustAt: window.projectedIn == null ? null : nowSeconds + window.projectedIn,
	})),
	status429: false,
	retryAfter: null,
	notBefore: null,
	parseErrors: [],
	...overrides,
});

const feed = (...accounts: CodexAccount[]): CodexUsageState => ({
	schemaVersion: 2,
	generation: 42,
	generatedAt: now,
	accounts,
});

const stable = (weeklyPct = 20, shortPct = 30) =>
	telemetry(personal, [
		{ minutes: 300, pctUsed: shortPct, resetIn: 3 * 3600 },
		{ minutes: 10080, pctUsed: weeklyPct, resetIn: 5 * 24 * 3600 },
	]);
const perishable = (shortPct = 20) =>
	telemetry(alt, [
		{ minutes: 300, pctUsed: shortPct, resetIn: 2 * 3600 },
		{ minutes: 10080, pctUsed: 30, resetIn: 4 * 24 * 3600 },
	]);

test("parses explicit work horizons and rejects guesses", () => {
	assert.deepEqual(parseWorkInput(undefined), { workClass: "unpredictable" });
	assert.deepEqual(parseWorkInput("short"), { workClass: "short", horizonMinutes: 120 });
	assert.deepEqual(parseWorkInput("long:600"), { workClass: "long", horizonMinutes: 600 });
	assert.throws(() => parseWorkInput("medium"), /short/);
});

test("short work burns perishable capacity while long work preserves it", () => {
	const short = evaluateCodexRoute({ registry, feed: feed(stable(), perishable()), model, work: parseWorkInput("short"), now });
	assert.equal(short.candidates[0]?.accountKey, alt.accountKey);
	const long = evaluateCodexRoute({ registry, feed: feed(stable(), perishable()), model, work: parseWorkInput("long"), now });
	assert.equal(long.candidates[0]?.accountKey, personal.accountKey);
});

test("GPT-5.6 models preserve Astra capacity until every other account is blocked", () => {
	const astraUsage = telemetry(astra, [{ minutes: 10080, pctUsed: 5, resetIn: 6 * 24 * 3600 }], { plan: "prolite" });
	for (const routedModel of gpt56Models) {
		const available = evaluateCodexRoute({
			registry: { ...registry, accounts: [...registry.accounts, astra] },
			feed: feed(stable(), perishable(), astraUsage),
			model: routedModel,
			work: parseWorkInput("short"),
			now,
		});
		assert.deepEqual(available.candidates.map((candidate) => candidate.accountKey), [alt.accountKey, personal.accountKey, astra.accountKey]);

		const lastDitch = evaluateCodexRoute({
			registry: { ...registry, accounts: [...registry.accounts, astra] },
			feed: feed(stable(100, 20), perishable(100), astraUsage),
			model: routedModel,
			now,
		});
		assert.deepEqual(lastDitch.candidates.map((candidate) => candidate.accountKey), [astra.accountKey]);
	}
});

test("registry model additions do not wait for quota telemetry refresh", () => {
	const legacyTelemetry = perishable();
	legacyTelemetry.supportedModels = [model];
	const result = evaluateCodexRoute({
		registry: { ...registry, accounts: [alt] },
		feed: feed(legacyTelemetry),
		model: "gpt-5.6-luna",
		now,
	});
	assert.equal(result.candidates[0]?.accountKey, alt.accountKey);
});

test("unsupported models name the missing compatible account", () => {
	const result = evaluateCodexRoute({ registry, feed: feed(stable(), perishable()), model: "gpt-9-missing", now });
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /MODEL UNAVAILABLE:.*no configured Codex account supports this model/);
});

test("projection never blocks currently available quota", () => {
	const projected = telemetry(alt, [
		{ minutes: 300, pctUsed: 95, resetIn: 7200, projectedIn: 8000 },
		{ minutes: 10080, pctUsed: 30, resetIn: 4 * 24 * 3600 },
	]);
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(projected), model, now });
	assert.equal(result.allBlocked, false);
	projected.windows[0]!.projectedExhaustAt = nowSeconds + 100;
	assert.equal(evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(projected), model, now }).allBlocked, false);
});

test("uses reported quota through 99 percent when no projection exists", () => {
	const almostExhausted = stable(99, 99);
	const options = { registry: { ...registry, accounts: [personal] }, feed: feed(almostExhausted), model, now };
	assert.equal(evaluateCodexRoute(options).allBlocked, false);
	almostExhausted.windows[0]!.pctUsed = 100;
	assert.equal(evaluateCodexRoute(options).allBlocked, true);
});

test("all exhausted short windows fail closed with earliest recovery", () => {
	const result = evaluateCodexRoute({
		registry,
		feed: feed(stable(20, 100), perishable(100)),
		model,
		now,
	});
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /no routable Codex account/);
	assert.match(result.error!, new RegExp(`Earliest recovery: ${new Date((nowSeconds + 7200) * 1000).toISOString()}`));
	assert.match(result.error!, /WINDOW EXHAUSTED 300m/);
});

test("mixed short and weekly exhaustion still blocks the whole fleet", () => {
	const result = evaluateCodexRoute({
		registry,
		feed: feed(stable(100, 20), perishable(100)),
		model,
		now,
	});
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /WINDOW EXHAUSTED 10080m/);
	assert.match(result.error!, /WINDOW EXHAUSTED 300m/);
});

test("selector blocks when quota pools are split across accounts", () => {
	const shortOnly = stable();
	shortOnly.windows = shortOnly.windows.filter((window) => window.minutes === 300);
	const weekOnly = perishable();
	weekOnly.windows = weekOnly.windows.filter((window) => window.minutes === 10080);
	const result = evaluateCodexRoute({ registry, feed: feed(shortOnly, weekOnly), model, now });
	assert.equal(result.allBlocked, true);
	assert.equal(result.candidates.length, 0);
});

test("routes Pro accounts with a weekly-only quota", () => {
	const pro = telemetry(alt, [{ minutes: 10080, pctUsed: 3, resetIn: 4 * 24 * 3600 }], { plan: "prolite" });
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(pro), model, now });
	assert.equal(result.allBlocked, false);
	assert.equal(result.candidates[0]?.accountKey, alt.accountKey);
});

test("429 remains blocked until a valid sample and reports recovery", () => {
	const blocked = perishable(20);
	blocked.status429 = true;
	blocked.notBefore = nowSeconds + 60;
	const blockedResult = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(blocked), model, now });
	assert.equal(blockedResult.allBlocked, true);
	assert.match(blockedResult.error!, new RegExp(`Earliest recovery: ${new Date((nowSeconds + 60) * 1000).toISOString()}`));
	assert.match(blockedResult.error!, /RATE LIMITED/);

	blocked.notBefore = nowSeconds - 60;
	const stillBlocked = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(blocked), model, now });
	assert.equal(stillBlocked.allBlocked, true);
});

test("aged telemetry routes with visible conservative degradation", () => {
	const aged = stable(20, 30);
	aged.fetchedAt = now - 16 * 60_000;
	aged.captureHealth = "degraded";
	aged.parseErrors = ["meter offline"];
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [personal] }, feed: feed(aged), model, now });
	assert.equal(result.allBlocked, false);
	const account = result.accounts[0]!;
	assert.equal(account.freshness, "aged");
	assert.equal(account.ageMs, 16 * 60_000);
	assert.deepEqual(account.effectiveWindows.map((window) => window.pctUsed), [90, 90]);
	assert.match(account.degradations.join(" "), /STALE TELEMETRY/);
	assert.match(account.degradations.join(" "), /meter offline/);
	assert.equal(result.candidates.length, 1);
});

test("aged telemetry routes when a safe slope can be projected", () => {
	const aged = perishable(20);
	aged.fetchedAt = now - 30 * 60_000;
	aged.windows[0]!.slopePctPerHour = 20;
	aged.windows[0]!.projectedExhaustAt = nowSeconds + 4 * 3600;
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(aged), model, now });
	assert.equal(result.allBlocked, false);
	assert.equal(result.accounts[0]!.effectiveWindows[0]!.pctUsed, 30);
});

test("past-reset windows become unknown and are excluded", () => {
	const expired = perishable();
	expired.windows[0]!.resetAt = nowSeconds - 1;
	const mixed = evaluateCodexRoute({ registry, feed: feed(stable(), expired), model, now });
	assert.equal(mixed.allBlocked, false);
	assert.equal(mixed.candidates.some((candidate) => candidate.accountKey === alt.accountKey), false);
	assert.match(mixed.accounts.find((entry) => entry.account.accountKey === alt.accountKey)!.reasons.join(" "), /WINDOW UNKNOWN AFTER RESET/);

	const unknown = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(expired), model, now });
	assert.equal(unknown.allBlocked, true);
	assert.match(unknown.error!, /Earliest recovery: unknown/);
});

test("malformed feeds refuse when observability has no usable fallback", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-router-malformed-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "registry.json");
	const feedPath = join(directory, "feed.json");
	await writeFile(registryPath, JSON.stringify(registry));
	await writeFile(feedPath, "{broken");
	const malformed = evaluateCodexRouteFromFiles({
		model,
		now,
		registryPath,
		feedPath,
		observabilityPath: join(directory, "missing.jsonl"),
	});
	assert.equal(malformed.allBlocked, true);
	assert.match(malformed.error!, /unreadable or malformed/);
	assert.match(malformed.error!, /observability fallback unavailable/);
});

test("uses last-known observability quota when the state feed is corrupt", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-router-observability-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "registry.json");
	const feedPath = join(directory, "feed.json");
	const observabilityPath = join(directory, "observability.jsonl");
	await writeFile(registryPath, JSON.stringify({ ...registry, accounts: [alt] }));
	await writeFile(feedPath, "{broken");
	await writeFile(
		observabilityPath,
		`${JSON.stringify({
			capturedAt: new Date(now - 16 * 60_000).toISOString(),
			kind: "http_response",
			provider: alt.providerId,
			status: 200,
			headers: {
				"x-codex-plan-type": "edu",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-used-percent": "20",
				"x-codex-primary-reset-at": String(nowSeconds + 7200),
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-used-percent": "30",
				"x-codex-secondary-reset-at": String(nowSeconds + 4 * 24 * 3600),
			},
		})}\n`,
	);
	const result = evaluateCodexRouteFromFiles({ model, now, registryPath, feedPath, observabilityPath });
	assert.equal(result.allBlocked, false);
	assert.equal(result.feedSource, "observability");
	assert.equal(result.accounts[0]!.freshness, "aged");
	assert.match(result.feedNotice!, /using .*observability\.jsonl/);
	assert.equal(result.candidates.length, 1);

	await rm(feedPath);
	const missing = evaluateCodexRouteFromFiles({ model, now, registryPath, feedPath, observabilityPath });
	assert.equal(missing.allBlocked, false);
	assert.equal(missing.feedSource, "observability");
});
