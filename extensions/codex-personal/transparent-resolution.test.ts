import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelResolutionContext } from "@earendil-works/pi-ai";
import type { CodexAccountRegistry } from "../codex-quota-extension/store.ts";
import { resolveCodexPersonalSelection } from "./resolution.ts";
import type { RouteEvaluation } from "./router.ts";

const model = (provider: string, id = "gpt-5.6-sol") =>
	({ provider, id }) as Model;
const umbrella = model("openai-codex-personal");
const personal = model("openai-codex");
const sifttext = model("openai-codex-sifttext");
const registry: CodexAccountRegistry = {
	schemaVersion: 1,
	umbrellaProviderId: umbrella.provider,
	accounts: [
		{
			accountKey: "personal",
			providerId: personal.provider,
			credentialRef: personal.provider,
			label: "Personal",
			policyClass: "stable-weekly",
			supportedModels: [umbrella.id],
		},
		{
			accountKey: "sifttext",
			providerId: sifttext.provider,
			credentialRef: sifttext.provider,
			label: "SiftText",
			policyClass: "perishable",
			supportedModels: [umbrella.id],
		},
	],
};

const context = (
	authenticated: string[],
	previousModel?: Model,
): ModelResolutionContext => ({
	previousModel,
	getModel: (provider, id) =>
		[personal, sifttext].find(
			(entry) => entry.provider === provider && entry.id === id,
		),
	hasAuth: async (provider) => authenticated.includes(provider),
});

const routable = (): RouteEvaluation => ({
	allBlocked: false,
	accounts: [],
	feedSource: "state",
	candidates: [
		{
			accountKey: "personal",
			actualProviderId: personal.provider,
			model: umbrella.id,
			reason: "first",
			warnings: [],
			feedGeneration: 7,
		},
		{
			accountKey: "sifttext",
			actualProviderId: sifttext.provider,
			model: umbrella.id,
			reason: "second",
			warnings: [],
			feedGeneration: 7,
		},
	],
});

test("transparent selection substitutes the first authenticated routed account", async () => {
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		registry,
		work: { workClass: "unpredictable" },
		evaluate: routable,
		context: context([sifttext.provider]),
	});
	assert.equal(resolved.model, sifttext);
	assert.ok(resolved.pin);
	assert.deepEqual(resolved.pin, {
		umbrella: umbrella.provider,
		accountKey: "sifttext",
		model: umbrella.id,
		actualProviderId: sifttext.provider,
		feedGeneration: 7,
		routedAt: resolved.pin.routedAt,
		workClass: "unpredictable",
	});
});

test("transparent selection refuses an all-blocked route with recovery", async () => {
	await assert.rejects(
		resolveCodexPersonalSelection({
			model: umbrella,
			registry,
			work: { workClass: "unpredictable" },
			evaluate: () => ({
				allBlocked: true,
				accounts: [],
				candidates: [],
				feedSource: "state",
				error:
					"ERROR: unavailable\nEarliest recovery: 2030-01-01T00:00:00.000Z",
			}),
			context: context([personal.provider, sifttext.provider]),
		}),
		/Earliest recovery: 2030-01-01/,
	);
});

test("resuming a real routed provider keeps the pin without evaluating again", async () => {
	let evaluations = 0;
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		previousModel: sifttext,
		registry,
		work: { workClass: "unpredictable" },
		evaluate: () => {
			evaluations++;
			return routable();
		},
		context: context([sifttext.provider], sifttext),
	});
	assert.equal(resolved.model, sifttext);
	assert.equal(resolved.pin, undefined);
	assert.equal(evaluations, 0);
});
