import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	allowlistedHeaders,
	buildQuotaView,
	CodexUsageStore,
	normalizeObservation,
	resetNotes,
} from "./store.ts";

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

test("normalizes windows by minutes and suppresses zero-minute windows", () => {
	const account = normalizeObservation(
		"openai-codex-alt",
		200,
		{
			...headers(),
			"X-Codex-Secondary-Window-Minutes": "0",
			"X-Codex-Secondary-Reset-At": "",
		},
		undefined,
		1_000_000,
		"gpt-5.6-luna",
	);
	assert.deepEqual(account.windows, [{ minutes: 300, pctUsed: 46, resetAt: 2000 }]);
	assert.equal(account.windowsFetchedAt, 1_000_000);
	assert.equal(account.lastModel, "gpt-5.6-luna");
	assert.equal(account.status429, false);
});

test("headerless 429 retains window provenance while updating response status", () => {
	const before = normalizeObservation(
		"openai-codex-alt",
		200,
		headers(),
		undefined,
		1_000_000,
		"gpt-5.6-luna",
	);
	const blocked = normalizeObservation(
		"openai-codex-alt",
		429,
		{},
		before,
		1_100_000,
		"gpt-5.6-sol",
	);
	assert.deepEqual(blocked.windows, before.windows);
	assert.equal(blocked.windowsFetchedAt, 1_000_000);
	assert.equal(blocked.fetchedAt, 1_100_000);
	assert.equal(blocked.lastModel, "gpt-5.6-sol");
	assert.equal(blocked.status429, true);
	assert.equal(blocked.notBefore, 2000);
	const view = buildQuotaView({ current: blocked.id, accounts: [blocked] }, 1_100_000);
	assert.equal(view?.blocked, true);
	assert.equal(view?.notBefore, 2000);

	const cleared = normalizeObservation(
		"openai-codex-alt",
		200,
		headers(),
		blocked,
		1_200_000,
	);
	assert.equal(cleared.status429, false);
	assert.equal(cleared.notBefore, undefined);
});

test("detects reset epochs and percentage drops", () => {
	const before = normalizeObservation(
		"openai-codex-alt",
		200,
		headers("46", "2000"),
		undefined,
		1_000_000,
	);
	const next = normalizeObservation(
		"openai-codex-alt",
		200,
		headers("40", "3000"),
		before,
		1_100_000,
	);
	assert.deepEqual(resetNotes(before, next), [
		"openai-codex-alt 300m reset observed",
	]);
});

test("builds active windows and excludes unknown regimes from totals", () => {
	const account = normalizeObservation(
		"openai-codex-alt",
		200,
		headers(),
		undefined,
		1_000_000,
	);
	const view = buildQuotaView(
		{
			current: account.id,
			accounts: [
				account,
				{
					id: "openai-codex-team",
					plan: "business",
					windows: [],
					status429: false,
					fetchedAt: 1_000_000,
				},
			],
		},
		1_000_000,
	);
	assert.equal(view?.win300?.pctUsed, 46);
	assert.equal(view?.win10080?.pctUsed, 76);
	assert.equal(view?.totalUsedEq, 122);
	assert.equal(view?.totalCount, 2);
});

test("scopes age and blocking to the current account", () => {
	const current = normalizeObservation(
		"openai-codex-alt",
		200,
		headers(),
		undefined,
		2_000_000,
	);
	const staleBlocked = {
		...normalizeObservation("openai-codex-team", 200, headers(), undefined, 1_000_000),
		status429: true,
	};
	const view = buildQuotaView({
		current: current.id,
		accounts: [staleBlocked, current],
	}, 2_100_000);
	assert.equal(view?.fetchedAt, 2_000_000);
	assert.equal(view?.blocked, false);
});

test("marks reset windows expired and excludes their stale percentage", () => {
	const account = normalizeObservation(
		"openai-codex-alt",
		200,
		headers("100", "2000"),
		undefined,
		1_000_000,
	);
	const view = buildQuotaView({ current: account.id, accounts: [account] }, 2_000_000);
	assert.equal(view?.win300?.expired, true);
	assert.equal(view?.totalUsedEq, 76);
	assert.equal(view?.totalCount, 1);
});

test("writes state atomically with mode 0600", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const store = new CodexUsageStore(path);
	store.observe("openai-codex-alt", 200, headers(), 1_000_000);
	store.observe("openai-codex-alt", 429, {}, 1_100_000);
	await store.write();
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const blocked = JSON.parse(await readFile(path, "utf8"));
	assert.equal(blocked.current, "openai-codex-alt");
	assert.equal(blocked.accounts[0].notBefore, 2000);

	store.observe("openai-codex-alt", 200, headers(), 1_200_000);
	await store.write();
	const cleared = JSON.parse(await readFile(path, "utf8"));
	assert.equal(cleared.accounts[0].notBefore, undefined);
	assert.deepEqual((await readdir(directory)).sort(), ["state.json"]);
});
