import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelResolutionContext } from "@earendil-works/pi-ai";
import type { CodexAccountRegistry } from "../codex-quota-extension/store.ts";
import { resolveCodexPersonalSelection } from "./resolution.ts";
import type { RouteEvaluation } from "./router.ts";

const model = (provider: string, id = "gpt-5.6-sol") =>
	({ provider, id }) as Model;
const umbrella = model("openai-codex-personal");
const astraUmbrella = model(umbrella.provider, "gpt-6-astra");
const personal = model("openai-codex");
const sifttext = model("openai-codex-sifttext");
const astraSifttext = model(sifttext.provider, astraUmbrella.id);
const team = model("openai-codex-team");
const direct = model("openai");
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
			supportedModels: [umbrella.id, astraUmbrella.id],
		},
		{
			accountKey: "team",
			providerId: team.provider,
			credentialRef: team.provider,
			label: "Team",
			policyClass: "stable-weekly",
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
		[personal, sifttext, astraSifttext, team, direct].find(
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
		{
			accountKey: "team",
			actualProviderId: team.provider,
			model: umbrella.id,
			reason: "third",
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

test("switching models reroutes an incompatible pin to a compatible account", async () => {
	const resolved = await resolveCodexPersonalSelection({
		model: astraUmbrella,
		pin: {
			umbrella: umbrella.provider,
			accountKey: "personal",
			model: umbrella.id,
			actualProviderId: personal.provider,
			feedGeneration: 7,
			routedAt: 1,
			workClass: "unpredictable",
		},
		registry,
		work: { workClass: "unpredictable" },
		evaluate: () => ({
			allBlocked: false,
			accounts: [],
			feedSource: "state",
			candidates: [{
				accountKey: "sifttext",
				actualProviderId: sifttext.provider,
				model: astraUmbrella.id,
				reason: "Astra compatible",
				warnings: [],
				feedGeneration: 8,
			}],
		}),
		context: context([sifttext.provider]),
	});
	assert.equal(resolved.model, astraSifttext);
	assert.equal(resolved.pin?.accountKey, "sifttext");
	assert.equal(resolved.pin?.model, astraUmbrella.id);
});

test("switching to Sol leaves an Astra-capable pin when another account is available", async () => {
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		pin: {
			umbrella: umbrella.provider,
			accountKey: "sifttext",
			model: astraUmbrella.id,
			actualProviderId: sifttext.provider,
			feedGeneration: 7,
			routedAt: 1,
			workClass: "unpredictable",
		},
		registry,
		work: { workClass: "unpredictable" },
		evaluate: routable,
		context: context([personal.provider, sifttext.provider]),
	});
	assert.equal(resolved.model, personal);
	assert.equal(resolved.pin?.accountKey, "personal");
});

test("missing model support produces an obvious error", async () => {
	await assert.rejects(
		resolveCodexPersonalSelection({
			model: model(umbrella.provider, "gpt-9-missing"),
			registry,
			work: { workClass: "unpredictable" },
			evaluate: routable,
			context: context([]),
		}),
		/MODEL UNAVAILABLE: no Codex Personal account supports gpt-9-missing/,
	);
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

test("all-blocked startup can fall back to the same direct model", async () => {
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		registry,
		work: { workClass: "unpredictable" },
		evaluate: () => ({
			allBlocked: true,
			accounts: [],
			candidates: [],
			feedSource: "state",
			error: "ERROR: unavailable",
		}),
		context: context([direct.provider]),
		fallbackProviderId: direct.provider,
	});
	assert.equal(resolved.model, direct);
	assert.equal(resolved.warning, "ERROR: unavailable");
});

test("runtime failover excludes the pinned account and skips unauthenticated candidates", async () => {
	const authChecks: string[] = [];
	const considered = new Set(["personal"]);
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		pin: {
			umbrella: umbrella.provider,
			accountKey: "personal",
			model: umbrella.id,
			actualProviderId: personal.provider,
			feedGeneration: 7,
			routedAt: 1,
			workClass: "unpredictable",
		},
		registry,
		work: { workClass: "unpredictable" },
		evaluate: routable,
		context: {
			...context([]),
			hasAuth: async (provider) => {
				authChecks.push(provider);
				return provider === team.provider;
			},
		},
		excludedAccountKeys: new Set(["personal"]),
		consideredAccountKeys: considered,
		reevaluatePin: true,
	});
	assert.equal(resolved.model, team);
	assert.equal(resolved.pin?.accountKey, "team");
	assert.deepEqual(authChecks, [sifttext.provider, team.provider]);
	assert.deepEqual([...considered], ["personal", "sifttext", "team"]);
});

test("manual umbrella reevaluation leaves a failed pin", async () => {
	const resolved = await resolveCodexPersonalSelection({
		model: umbrella,
		pin: {
			umbrella: umbrella.provider,
			accountKey: "personal",
			model: umbrella.id,
			actualProviderId: personal.provider,
			feedGeneration: 7,
			routedAt: 1,
			workClass: "unpredictable",
		},
		registry,
		work: { workClass: "unpredictable" },
		evaluate: routable,
		context: context([sifttext.provider]),
		excludedAccountKeys: new Set(["personal"]),
		consideredAccountKeys: new Set(["personal"]),
		reevaluatePin: true,
	});
	assert.equal(resolved.model, sifttext);
	assert.equal(resolved.pin?.accountKey, "sifttext");
});

test("failover exhaustion considers each remaining candidate once", async () => {
	const authChecks: string[] = [];
	const considered = new Set(["personal"]);
	await assert.rejects(
		resolveCodexPersonalSelection({
			model: umbrella,
			registry,
			work: { workClass: "unpredictable" },
			evaluate: routable,
			context: {
				...context([]),
				hasAuth: async (provider) => {
					authChecks.push(provider);
					return false;
				},
			},
			excludedAccountKeys: new Set(["personal"]),
			consideredAccountKeys: considered,
			reevaluatePin: true,
		}),
		/no routable compatible account with usable credentials.*personal/,
	);
	assert.deepEqual(authChecks, [sifttext.provider, team.provider]);
	assert.deepEqual([...considered], ["personal", "sifttext", "team"]);
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
