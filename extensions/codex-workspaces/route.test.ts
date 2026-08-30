import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RoutePin } from "../codex-personal/resolution.ts";
import { routeEntry } from "../codex-personal/resolution.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionsDir = basename(testDir) === "extensions" ? testDir : dirname(testDir);

test("workspace tests stay outside Pi's top-level extension discovery glob", () => {
	assert.notEqual(testDir, extensionsDir);
	assert.deepEqual(
		readdirSync(extensionsDir).filter((name) => /\.(?:test|spec)\.[jt]s$/.test(name)),
		[],
	);
});

test("a later model switch invalidates a durable Codex route", () => {
	const pin: RoutePin = {
		umbrella: "openai-codex-personal",
		accountKey: "personal",
		model: "gpt-5.6-sol",
		actualProviderId: "openai-codex",
		feedGeneration: 1,
		routedAt: 1,
		workClass: "unpredictable",
	};
	const route = { type: "custom", customType: "codex-route/v1", data: pin };
	assert.equal(routeEntry([route]), pin);
	assert.equal(
		routeEntry([
			route,
			{ type: "model_change", provider: pin.actualProviderId, modelId: pin.model },
		]),
		pin,
	);
	assert.equal(
		routeEntry([
			route,
			{ type: "model_change", provider: "openai", modelId: pin.model },
		]),
		undefined,
	);
});
