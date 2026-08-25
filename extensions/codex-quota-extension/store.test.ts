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
	);
	assert.deepEqual(account.windows, [{ minutes: 300, pctUsed: 46, resetAt: 2000 }]);
	assert.equal(account.status429, false);
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

test("writes state atomically with mode 0600", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.json");
	const store = new CodexUsageStore(path);
	store.observe("openai-codex-alt", 200, headers(), 1_000_000);
	await store.write();
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(path, "utf8")).current, "openai-codex-alt");
	assert.deepEqual((await readdir(directory)).sort(), ["state.json"]);
});
