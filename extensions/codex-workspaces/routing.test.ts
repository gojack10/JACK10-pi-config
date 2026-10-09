import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeObservation } from "../codex-quota-extension/store.ts";

const { loadExtensions } = await import(pathToFileURL(join(homedir(), ".local/share/pi-mono/packages/coding-agent/dist/core/extensions/loader.js")).href);

test("resumes and reroutes on each prompt, recovers priority after reset, and bounds failover", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "codex-routing-"));
	const oldHome = process.env.HOME;
	const oldMaintenance = process.env.PI_CODEX_ACCOUNT_MAINTENANCE;
	process.env.HOME = home;
	delete process.env.PI_CODEX_ACCOUNT_MAINTENANCE;
	t.after(async () => {
		process.env.HOME = oldHome;
		if (oldMaintenance === undefined) delete process.env.PI_CODEX_ACCOUNT_MAINTENANCE;
		else process.env.PI_CODEX_ACCOUNT_MAINTENANCE = oldMaintenance;
		await rm(home, { recursive: true, force: true });
	});
	const dir = join(home, ".pi/agent");
	await mkdir(dir, { recursive: true });
	const id = "gpt-6-astra";
	const providers = ["openai-codex-first", "openai-codex", "openai-codex-third"];
	const accounts = providers.map((providerId) => ({ accountKey: providerId, providerId, credentialRef: providerId,
		label: providerId, policyClass: "perishable" as const, supportedModels: [id] }));
	await writeFile(join(dir, "codex-accounts.json"), JSON.stringify({ schemaVersion: 1, umbrellaProviderId: "openai-codex-personal", accounts }));
	const now = Date.now();
	const samples = accounts.map((account) => normalizeObservation(account, 200, {
		"x-codex-plan-type": "plus", "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "20",
		"x-codex-primary-reset-at": String(now / 1000 + 7200), "x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-used-percent": "30", "x-codex-secondary-reset-at": String(now / 1000 + 86400),
	}, undefined, now));
	const save = () => writeFile(join(dir, "codex-usage-state.json"), JSON.stringify({ schemaVersion: 2, generation: 1, generatedAt: now, accounts: samples }));
	await save();
	const loaded = await loadExtensions([fileURLToPath(new URL("../codex-workspaces.ts", import.meta.url))], home);
	assert.deepEqual(loaded.errors, []);
	const selector = loaded.runtime.pendingNativeProviderRegistrations.find((entry: any) => entry.provider.id === "openai-codex-personal")!.provider;
	const branch: any[] = [{ type: "custom", customType: "codex-route/v1", data: { umbrella: selector.id,
		accountKey: providers[2], actualProviderId: providers[2], model: id, feedGeneration: 1, routedAt: now, workClass: "long" } }];
	const ctx: any = { model: { provider: providers[2], id }, hasUI: false,
		sessionManager: { getBranch: () => branch },
		modelRegistry: { find: (provider: string, model: string) => ({ provider, id: model }), getProviderAuth: async () => ({}) } };
	let selections = 0;
	loaded.runtime.appendEntry = (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); };
	loaded.runtime.setModel = async (model: any) => {
		selections++;
		ctx.model = model.provider === selector.id ? await selector.resolveModel(model, {
			getModel: ctx.modelRegistry.find, hasAuth: async () => true,
		}) : model;
		return true;
	};
	const emit = async (event: string, data: any = {}) => {
		let result: any;
		for (const handler of loaded.extensions[0]!.handlers.get(event) ?? []) result = await handler(data, ctx);
		return result;
	};
	await emit("session_start");
	assert.equal(ctx.model.provider, providers[0]);
	const entries = branch.length;
	await emit("before_agent_start");
	assert.equal(branch.length, entries); // No duplicate route entry for unchanged priority.
	samples[0]!.windows[1]!.pctUsed = 100;
	await save();
	await emit("before_agent_start");
	assert.equal(ctx.model.provider, providers[1]);
	samples[1]!.windows[1]!.pctUsed = 100;
	await save();
	await emit("before_agent_start");
	assert.equal(ctx.model.provider, providers[2]);
	samples[0]!.windows[1]!.resetAt = now / 1000 - 1;
	samples[0]!.status429 = true;
	samples[0]!.notBefore = now / 1000 - 1;
	await save();
	await emit("before_agent_start");
	assert.equal(ctx.model.provider, providers[0]);
	const failure = () => ({ message: { role: "assistant", provider: ctx.model.provider, model: id, content: [],
		usage: { output: 0 }, stopReason: "error", errorMessage: "ChatGPT usage limit reached" } });
	assert.deepEqual(await emit("message_end", failure()), { retry: true });
	assert.equal(ctx.model.provider, providers[2]);
	const exhausted = await emit("message_end", failure());
	assert.match(exhausted.message.errorMessage, /Failover unavailable/);
	ctx.model = { provider: "anthropic", id: "claude" };
	const before = selections;
	await emit("before_agent_start");
	assert.equal(selections, before);
	assert.equal(ctx.model.provider, "anthropic");
	process.env.PI_CODEX_ACCOUNT_MAINTENANCE = providers[1];
	ctx.model = { provider: providers[1], id };
	await emit("session_start");
	await emit("before_agent_start");
	assert.equal(selections, before); // Explicit maintenance never auto-routes.
});
