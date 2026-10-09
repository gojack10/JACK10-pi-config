import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelResolutionContext } from "@earendil-works/pi-ai";
import type { CodexAccountRegistry } from "../codex-quota-extension/store.ts";
import { resolveCodexPersonalSelection } from "./resolution.ts";
import type { RouteEvaluation } from "./router.ts";

const id = "gpt-6-astra";
const model = (provider: string) => ({ provider, id }) as Model;
const umbrella = model("openai-codex-personal");
const providers = ["openai-codex-first", "openai-codex-second", "openai-codex-third"];
const registry: CodexAccountRegistry = {
	schemaVersion: 1, umbrellaProviderId: umbrella.provider,
	accounts: providers.map((providerId) => ({ accountKey: providerId, providerId, credentialRef: providerId,
		label: providerId, policyClass: "perishable", supportedModels: [id] })),
};
const context = (authenticated: string[]): ModelResolutionContext => ({
	getModel: (provider, requested) => requested === id ? model(provider) : undefined,
	hasAuth: async (provider) => authenticated.includes(provider),
});
const routable = (): RouteEvaluation => ({
	allBlocked: false, accounts: [], feedSource: "state",
	candidates: providers.map((provider) => ({ accountKey: provider, actualProviderId: provider, model: id,
		reason: "priority", warnings: [], feedGeneration: 7 })),
});
const blocked = (): RouteEvaluation => ({
	allBlocked: true, accounts: [], candidates: [], feedSource: "state", error: "Earliest recovery: 2030-01-01T00:00:00.000Z",
});

test("selection substitutes the first authenticated account in priority order", async () => {
	for (let start = 0; start < providers.length; start++) {
		const result = await resolveCodexPersonalSelection({ model: umbrella, registry, evaluate: routable, context: context(providers.slice(start)) });
		assert.equal(result.model.provider, providers[start]);
		assert.deepEqual(result.pin, { umbrella: umbrella.provider, accountKey: providers[start], model: id,
			actualProviderId: providers[start], feedGeneration: 7, routedAt: result.pin!.routedAt });
	}
});

test("every selection reevaluates instead of sticking to the previous provider", async () => {
	let evaluations = 0;
	const ctx = { ...context(providers), previousModel: model(providers[2]!) };
	const result = await resolveCodexPersonalSelection({ model: umbrella, registry, context: ctx,
		evaluate: () => { evaluations++; return routable(); } });
	assert.equal(result.model.provider, providers[0]);
	assert.equal(evaluations, 1);
});

test("missing model support and blocked accounts produce an obvious error", async () => {
	await assert.rejects(resolveCodexPersonalSelection({ model: { ...umbrella, id: "missing" }, registry,
		evaluate: routable, context: context(providers) }), /no Codex Personal account supports missing/);
	await assert.rejects(resolveCodexPersonalSelection({ model: umbrella, registry,
		evaluate: blocked, context: context(providers) }), /Earliest recovery: 2030-01-01/);
});

test("all-blocked startup can fall back to the same direct model", async () => {
	const result = await resolveCodexPersonalSelection({ model: umbrella, registry,
		evaluate: blocked, context: context(["openai"]), fallbackProviderId: "openai" });
	assert.equal(result.model.provider, "openai");
	assert.match(result.warning!, /Earliest recovery/);
});

test("failover excludes failed accounts and checks remaining credentials once", async () => {
	const checked: string[] = [];
	const considered = new Set([providers[0]!]);
	const result = await resolveCodexPersonalSelection({ model: umbrella, registry, evaluate: routable,
		excludedAccountKeys: new Set([providers[0]!]), consideredAccountKeys: considered,
		context: { ...context([]), hasAuth: async (provider) => { checked.push(provider); return provider === providers[2]; } } });
	assert.equal(result.model.provider, providers[2]);
	assert.deepEqual(checked, providers.slice(1));
	assert.deepEqual([...considered], providers);
});

test("failover exhaustion reports the excluded account without looping", async () => {
	const checked: string[] = [];
	await assert.rejects(resolveCodexPersonalSelection({ model: umbrella, registry, evaluate: routable,
		excludedAccountKeys: new Set([providers[0]!]), consideredAccountKeys: new Set([providers[0]!]),
		context: { ...context([]), hasAuth: async (provider) => { checked.push(provider); return false; } } }),
	/no routable compatible account with usable credentials.*openai-codex-first/);
	assert.deepEqual(checked, providers.slice(1));
});
