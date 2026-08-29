import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bumpRecencyOrder, updateRecencyFile } from "../model-recency.ts";

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
