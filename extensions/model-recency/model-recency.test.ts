import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Model } from "@mariozechner/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bumpRecencyOrder, selectMostRecentModel, updateRecencyFile } from "../model-recency.ts";

const accounts = new Set(["openai-codex", "openai-codex-alt", "openai-codex-sifttext"]);

test("Codex account selections surface only the Personal router", () => {
	assert.deepEqual(bumpRecencyOrder([
		{ provider: "openai-codex-alt", modelId: "gpt-5.6-sol" },
		{ provider: "openai", modelId: "gpt-5.6-sol" },
		{ provider: "openai-codex", modelId: "gpt-5.6-sol" },
	], { provider: "openai-codex", modelId: "gpt-5.6-sol" }, accounts), [
		{ provider: "openai-codex-personal", modelId: "gpt-5.6-sol" },
		{ provider: "openai", modelId: "gpt-5.6-sol" },
	]);
});

test("startup chooses the first recent model that is available in scope", async () => {
	const inScope = { provider: "local", id: "recent" } as Model<any>;
	let selected: Model<any> | undefined;
	const result = await selectMostRecentModel([
		{ provider: "anthropic", modelId: "stale" },
		{ provider: "local", modelId: "recent" },
	], {
		findModel: (provider, modelId) => provider === inScope.provider && modelId === inScope.id ? inScope : undefined,
		scopedModels: [{ model: inScope }],
		setModel: async (model) => {
			selected = model;
			return true;
		},
	});
	assert.equal(result, inScope);
	assert.equal(selected, inScope);
});

test("concurrent recency writers merge under the filesystem lock", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "model-recency-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "model-recency.json");
	await Promise.all([
		updateRecencyFile(path, { provider: "anthropic", modelId: "claude" }, accounts),
		updateRecencyFile(path, { provider: "google", modelId: "gemini" }, accounts),
	]);
	const order = JSON.parse(await readFile(path, "utf8")).order as Array<{ provider: string; modelId: string }>;
	assert.deepEqual(new Set(order.map(({ provider, modelId }) => `${provider}/${modelId}`)),
		new Set(["anthropic/claude", "google/gemini"]));
});
