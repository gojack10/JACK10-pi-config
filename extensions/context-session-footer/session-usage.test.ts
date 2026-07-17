import assert from "node:assert/strict";
import test from "node:test";
import {
	formatCacheTimer,
	getCacheObservations,
	getCacheTimerRemainingMs,
	getCurrentRunUsage,
	getLatestReportedCacheLifetime,
	getModelCacheLifetime,
	getReportedCacheLifetime,
	getRequestCacheLifetime,
	getSessionUsage,
} from "./session-usage.ts";

const assistant = (timestamp: string, input: number, cost: number) => ({
	type: "message",
	timestamp,
	message: {
		role: "assistant",
		usage: {
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: cost },
		},
	},
});

test("separates the current session and post-boundary run", () => {
	const startedAt = "2026-01-02T00:00:00.000Z";
	const allEntries = [
		assistant("2026-01-01T00:00:00.000Z", 99, 9), // copied from a fork parent
		assistant("2026-01-02T01:00:00.000Z", 1, 1),
		assistant("2026-01-03T01:00:00.000Z", 2, 2), // another tree branch
		assistant("2026-01-04T01:00:00.000Z", 3, 3),
		{ type: "compaction", timestamp: "2026-01-04T02:00:00.000Z" },
		assistant("2026-01-05T01:00:00.000Z", 4, 4),
		{ type: "model_change", timestamp: "2026-01-05T02:00:00.000Z" },
		assistant("2026-01-05T03:00:00.000Z", 5, 5),
		{ type: "thinking_level_change", timestamp: "2026-01-05T04:00:00.000Z" },
		assistant("2026-01-05T05:00:00.000Z", 6, 6),
	];
	const activeBranch = allEntries.filter(
		(entry) => entry.timestamp !== "2026-01-03T01:00:00.000Z",
	);

	assert.equal(getSessionUsage(allEntries, startedAt).cost, 21);
	assert.equal(getCurrentRunUsage(activeBranch, startedAt).cost, 6);
});

test("reports provider policy and conservative per-model cache timers", () => {
	const shortClaude = getModelCacheLifetime(
		{ provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" },
		false,
	);
	const shortOpenAI = getModelCacheLifetime(
		{ provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" },
		false,
	);
	const longOpenAI = getModelCacheLifetime(
		{ provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" },
		true,
	);
	const longCodex = getModelCacheLifetime(
		{
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
		},
		true,
	);

	assert.deepEqual(shortClaude, {
		minTtlMs: 300_000,
		maxTtlMs: 300_000,
		label: "5m",
	});
	assert.deepEqual(shortOpenAI, {
		minTtlMs: 1_800_000,
		maxTtlMs: 86_400_000,
		label: "30m–24h",
	});
	assert.deepEqual(longOpenAI, shortOpenAI);
	assert.deepEqual(longCodex, {
		minTtlMs: 1_800_000,
		maxTtlMs: 86_400_000,
		label: "30m–24h*",
	});
	assert.deepEqual(
		getModelCacheLifetime(
			{
				provider: "openai-codex-team",
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
			},
			false,
		),
		longCodex,
	);
	assert.deepEqual(
		getModelCacheLifetime(
			{
				provider: "azure-openai-responses",
				id: "gpt-5.6-sol",
				api: "azure-openai-responses",
			},
			true,
		),
		{ minTtlMs: null, maxTtlMs: null, label: "TTL ?" },
	);
	assert.deepEqual(
		getModelCacheLifetime(
			{ provider: "openai", id: "gpt-5.4-mini", api: "openai-responses" },
			false,
		),
		{
			minTtlMs: null,
			maxTtlMs: 3_600_000,
			typicalTtlMs: [300_000, 600_000],
			label: "typ 5–10m; max 1h",
		},
	);
	assert.deepEqual(
		getModelCacheLifetime(
			{ provider: "openai", id: "gpt-5.4", api: "openai-responses" },
			false,
		),
		{
			minTtlMs: null,
			maxTtlMs: 86_400_000,
			typicalTtlMs: [300_000, 600_000],
			label: "5–10m…24h policy",
		},
	);
	assert.deepEqual(
		getRequestCacheLifetime(
			{
				prompt_cache_retention: "24h",
				system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
			},
			longOpenAI,
		),
		{ minTtlMs: 3_600_000, maxTtlMs: 3_600_000, label: "1h" },
	);
	assert.deepEqual(
		getRequestCacheLifetime(
			{ prompt_cache_options: { ttl: "30m" } },
			shortOpenAI,
		),
		shortOpenAI,
	);
	assert.deepEqual(
		getRequestCacheLifetime(
			{ prompt_cache_retention: "in_memory" },
			{ minTtlMs: null, maxTtlMs: null, label: "TTL ?" },
		),
		{
			minTtlMs: null,
			maxTtlMs: 3_600_000,
			typicalTtlMs: [300_000, 600_000],
			label: "typ 5–10m; max 1h",
		},
	);
	assert.deepEqual(
		getReportedCacheLifetime({ retention: "24h", ttl: "30m" }, longCodex),
		shortOpenAI,
	);
	assert.deepEqual(
		getReportedCacheLifetime({ retention: "24h" }, shortOpenAI),
		shortOpenAI,
	);
	assert.deepEqual(
		getReportedCacheLifetime({ retention: "in_memory" }, shortOpenAI),
		{
			minTtlMs: null,
			maxTtlMs: 3_600_000,
			typicalTtlMs: [300_000, 600_000],
			label: "typ 5–10m; max 1h",
		},
	);
	assert.deepEqual(
		getLatestReportedCacheLifetime(
			[
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "openai",
						model: "gpt-5.6-sol",
						promptCache: { retention: "24h", ttl: "30m" },
					},
				},
			],
			"openai",
			"gpt-5.6-sol",
			longCodex,
		),
		shortOpenAI,
	);

	const entries = [
		{
			type: "message",
			timestamp: "2025-12-31T23:59:00.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "ignored-before-session",
				timestamp: -1,
				usage: { input: 1, cacheWrite: 1 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-5.6-sol",
				timestamp: 1_000,
				usage: { input: 1, cacheWrite: 2_000 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-5.6-sol",
				timestamp: 2_000,
				usage: { input: 1, cacheRead: 2_000, cacheWrite: 0 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai-codex-team",
				model: "gpt-5.6-sol",
				timestamp: 10_000,
				usage: { input: 2_000, cacheRead: 0, cacheWrite: 0 },
				promptCache: { retention: "24h" },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai-codex-team",
				model: "gpt-5.6-sol",
				timestamp: 20_000,
				usage: { input: 2_000, cacheRead: 0, cacheWrite: 0 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				timestamp: 30_000,
				usage: { input: 1, cacheWrite: 2_000, cacheWrite1h: 2_000 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5",
				timestamp: 40_000,
				usage: { input: 1, cacheRead: 2_000, cacheWrite: 0 },
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "deepseek",
				model: "tunnel-model",
				timestamp: 50_000,
				usage: { input: 1, cacheRead: 2_000, cacheWrite: 0 },
			},
		},
	];
	const observations = getCacheObservations(
		entries,
		"1970-01-01T00:00:00.000Z",
	);
	assert.deepEqual(
		observations.map(({ provider, model }) => `${provider}/${model}`),
		[
			"openai/gpt-5.6-sol",
			"openai-codex-team/gpt-5.6-sol",
			"anthropic/claude-fable-5",
			"deepseek/tunnel-model",
		],
	);
	assert.equal(
		getCacheTimerRemainingMs(shortOpenAI, observations[0], 61_000),
		1_740_000,
	);
	assert.equal(
		getCacheTimerRemainingMs(longCodex, observations[1], 80_000),
		1_740_000,
	);
	assert.equal(
		getCacheTimerRemainingMs(shortClaude, observations[2], 100_000),
		3_540_000,
	);
	assert.equal(
		getCacheTimerRemainingMs(
			{ minTtlMs: null, maxTtlMs: null, label: "TTL ?" },
			observations[3],
			50_001,
		),
		0,
	);
	assert.equal(
		getCacheTimerRemainingMs(shortOpenAI, observations[0], 1_801_001),
		0,
	);
	assert.equal(
		formatCacheTimer("gpt-5.6-sol", 60_000),
		"CACHE: gpt-5.6-sol WARM 00:01:00",
	);
	assert.equal(
		formatCacheTimer("gpt-5.6-sol", 0),
		"CACHE: gpt-5.6-sol EXPIRED",
	);
});
