import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const accountKey = "account-alt";

test("captures Codex response state and persists degraded attempts", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "codex-quota-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = oldHome;
	});
	const agentDir = join(home, ".pi", "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "codex-accounts.json"),
		JSON.stringify({
			schemaVersion: 1,
			umbrellaProviderId: "openai-codex-personal",
			accounts: [
				{
					accountKey,
					providerId: "openai-codex-alt",
					credentialRef: "openai-codex-alt",
					label: "Alt",
					policyClass: "perishable",
					supportedModels: ["gpt-5.6-sol"],
				},
			],
		}),
	);
	const { default: activate } = await import(`./index.ts?test=${Date.now()}`);
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const updates: any[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		events: { emit: (name: string, data: unknown) => name === "codex-usage:update" && updates.push(data) },
	};
	const ctx = {
		hasUI: false,
		model: { provider: "openai-codex-alt", id: "gpt-5.6-sol" },
		ui: { notify() {} },
	};
	activate(pi as never);
	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("after_provider_response")?.(
		{
			status: 200,
			headers: {
				"x-codex-plan-type": "edu",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-used-percent": "46",
				"x-codex-primary-reset-at": "2000000000",
				"x-codex-secondary-window-minutes": "0",
			},
		},
		ctx,
	);
	let state = JSON.parse(await readFile(join(agentDir, "codex-usage-state.json"), "utf8"));
	assert.equal(state.schemaVersion, 2);
	assert.equal(state.accounts[0].accountKey, accountKey);
	assert.equal(state.accounts[0].windows[0].minutes, 300);
	assert.equal(state.current, "openai-codex-alt");
	assert.equal(state.currentAccountKey, accountKey);
	assert.equal(state.accounts[0].captureHealth, "healthy");
	assert.equal(updates.at(-1).state.accounts[0].windows[0].pctUsed, 46);

	await handlers.get("after_provider_response")?.({ status: 200, headers: {} }, ctx);
	state = JSON.parse(await readFile(join(agentDir, "codex-usage-state.json"), "utf8"));
	assert.equal(state.accounts[0].captureHealth, "degraded");
	assert.match(state.accounts[0].parseErrors[0], /quota headers are missing/);
	assert.equal(state.accounts[0].windows[0].pctUsed, 46);
	assert.match(updates.at(-1).degraded, /quota headers are missing/);
	await handlers.get("session_shutdown")?.({}, ctx);
});
