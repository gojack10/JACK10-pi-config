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
const personal: RegistryAccount = {
	accountKey: "personal-key",
	providerId: "openai-codex",
	credentialRef: "openai-codex",
	label: "Personal",
	policyClass: "stable-weekly",
	supportedModels: [model],
};
const alt: RegistryAccount = {
	accountKey: "alt-key",
	providerId: "openai-codex-alt",
	credentialRef: "openai-codex-alt",
	label: "Alt",
	policyClass: "perishable",
	supportedModels: [model],
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
	telemetry(alt, [{ minutes: 300, pctUsed: shortPct, resetIn: 2 * 3600 }]);

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

test("known safe projection may route above the conservative 90 percent fallback", () => {
	const projected = telemetry(alt, [{ minutes: 300, pctUsed: 95, resetIn: 7200, projectedIn: 8000 }]);
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(projected), model, now });
	assert.equal(result.allBlocked, false);
	projected.windows[0]!.projectedExhaustAt = nowSeconds + 100;
	assert.equal(evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(projected), model, now }).allBlocked, true);
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

test("429 gates remain blocked and report elapsed notBefore explicitly", () => {
	const elapsed = telemetry(alt, [{ minutes: 300, pctUsed: 20, resetIn: 7200 }], {
		status429: true,
		notBefore: nowSeconds - 60,
	});
	const result = evaluateCodexRoute({ registry: { ...registry, accounts: [alt] }, feed: feed(elapsed), model, now });
	assert.equal(result.allBlocked, true);
	assert.match(result.error!, /elapsed; newer valid 200 required/);
	assert.match(result.error!, /RATE LIMITED/);
});

test("one fresh sibling remains routable while a stale sibling is excluded", () => {
	const stale = stable();
	stale.fetchedAt = now - 16 * 60_000;
	const result = evaluateCodexRoute({ registry, feed: feed(stale, perishable()), model, now });
	assert.equal(result.allBlocked, false);
	assert.equal(result.candidates[0]?.accountKey, alt.accountKey);
	assert.match(result.accounts.find((entry) => entry.account.accountKey === personal.accountKey)!.reasons[0]!, /STALE/);
});

test("wholly stale or malformed feeds fail closed", async (t) => {
	const stalePersonal = stable();
	const staleAlt = perishable();
	stalePersonal.fetchedAt = staleAlt.fetchedAt = now - 16 * 60_000;
	stalePersonal.status429 = true;
	stalePersonal.notBefore = nowSeconds + 60;
	const staleResult = evaluateCodexRoute({ registry, feed: feed(stalePersonal, staleAlt), model, now });
	assert.equal(staleResult.allBlocked, true);
	assert.match(staleResult.error!, /earliest notBefore: none/);

	const directory = await mkdtemp(join(tmpdir(), "codex-router-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const registryPath = join(directory, "registry.json");
	const feedPath = join(directory, "feed.json");
	await writeFile(registryPath, JSON.stringify(registry));
	await writeFile(feedPath, "{broken");
	const malformed = evaluateCodexRouteFromFiles({ model, now, registryPath, feedPath });
	assert.equal(malformed.allBlocked, true);
	assert.match(malformed.error!, /unreadable or malformed/);
});
