import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshQuota, REFRESH_MS } from "./refresh.ts";
import { CodexUsageStore, type CodexAccountRegistry } from "./store.ts";
import { evaluateCodexRouteFromFiles } from "../codex-personal/router.ts";

const registry: CodexAccountRegistry = {
	schemaVersion: 1, umbrellaProviderId: "openai-codex-personal",
	accounts: ["openai-codex-first", "openai-codex-second"].map((providerId) => ({
		accountKey: providerId, providerId, credentialRef: providerId, label: providerId,
		policyClass: "perishable", supportedModels: ["gpt-6-astra"],
	})),
};
const headers = (weekly: string, now: number) => ({
	"x-codex-plan-type": "plus", "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "0",
	"x-codex-primary-reset-at": String(now / 1000 + 7200), "x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-used-percent": weekly, "x-codex-secondary-reset-at": String(now / 1000 + 7 * 86400),
});

async function setup(t: test.TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "codex-refresh-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const feedPath = join(dir, "state.json");
	const registryPath = join(dir, "registry.json");
	await writeFile(registryPath, JSON.stringify(registry));
	const now = Date.now();
	const store = new CodexUsageStore(feedPath, registry);
	store.observe(registry.accounts[0]!.providerId, 429, headers("100", now), now - REFRESH_MS - 1);
	store.observe(registry.accounts[1]!.providerId, 200, headers("20", now), now);
	await store.write();
	return { feedPath, registryPath, now };
}

test("a shared ten-minute check discovers an early reset and restores account eligibility", async (t) => {
	const { feedPath, registryPath, now } = await setup(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls: string[] = [];
	const probe = async (provider: string) => {
		calls.push(provider);
		entered.resolve();
		await release.promise;
		const writer = new CodexUsageStore(feedPath, registry);
		await writer.load();
		writer.observe(provider, 200, headers("0", now), now);
		await writer.write();
	};
	const first = refreshQuota(feedPath, { registryPath, now, probe });
	await entered.promise;
	assert.equal(await refreshQuota(feedPath, { registryPath, now, probe }), false);
	release.resolve();
	assert.equal(await first, true);
	const providers = registry.accounts.map((account) => account.providerId);
	assert.deepEqual(calls, [providers[0]]); // The active account already has fresh response headers.
	const cache = JSON.parse(await readFile(feedPath, "utf8"));
	assert.equal(cache.accounts.find((account: any) => account.id === providers[0]).windows[1].pctUsed, 0);
	assert.equal(cache.accounts.find((account: any) => account.id === providers[0]).status429, false);
	assert.deepEqual(evaluateCodexRouteFromFiles({ model: "gpt-6-astra", registryPath, feedPath, now }).candidates.map((candidate) => candidate.actualProviderId), providers);
	assert.equal(await refreshQuota(feedPath, { registryPath, now: now + REFRESH_MS - 1, probe }), false);
	assert.deepEqual(calls, [providers[0]]);
	assert.equal(await refreshQuota(feedPath, { registryPath, now: now + REFRESH_MS, probe }), true);
	assert.deepEqual(calls, [providers[0], ...providers]);
	assert.equal((await stat(`${feedPath}.refresh`)).mode & 0o777, 0o600);
	await assert.rejects(stat(`${feedPath}.refresh.lock`), { code: "ENOENT" });
});

test("failed checks preserve all readings, release the lock and do not retry-storm", async (t) => {
	const { feedPath, registryPath, now } = await setup(t);
	const cached = await readFile(feedPath, "utf8");
	await assert.rejects(refreshQuota(feedPath, { registryPath, now, probe: async () => { throw new Error("offline"); } }), /offline/);
	assert.equal(await readFile(feedPath, "utf8"), cached);
	await assert.rejects(stat(`${feedPath}.refresh.lock`), { code: "ENOENT" });
	assert.equal(await refreshQuota(feedPath, { registryPath, now: now + 60_000, probe: async () => { assert.fail("too soon"); } }), false);
});

test("recovers a crashed check lock and maintenance probes never recurse", async (t) => {
	const { feedPath, registryPath, now } = await setup(t);
	const lock = `${feedPath}.refresh.lock`;
	await writeFile(lock, "");
	await utimes(lock, new Date(now - 6 * 60_000), new Date(now - 6 * 60_000));
	let calls = 0;
	assert.equal(await refreshQuota(feedPath, { registryPath, now, probe: async () => { calls++; } }), true);
	assert.equal(calls, 1);
	const old = process.env.PI_CODEX_ACCOUNT_MAINTENANCE;
	process.env.PI_CODEX_ACCOUNT_MAINTENANCE = registry.accounts[0]!.providerId;
	try {
		assert.equal(await refreshQuota(feedPath, { registryPath, now: now + REFRESH_MS, probe: async () => { assert.fail("recursive check"); } }), false);
	} finally {
		if (old === undefined) delete process.env.PI_CODEX_ACCOUNT_MAINTENANCE;
		else process.env.PI_CODEX_ACCOUNT_MAINTENANCE = old;
	}
});
