import assert from "node:assert/strict";
import test from "node:test";
import {
	formatGroupCacheStatus,
	formatHubTimer,
	formatPaneCacheStatus,
	type PaneCacheSnapshot,
} from "./store.ts";

const snapshot = (
	overrides: Partial<PaneCacheSnapshot> = {},
): PaneCacheSnapshot => ({
	version: 1,
	updatedAt: 1_000_000,
	entries: [],
	contextTokens: 44_000,
	contextWindow: 200_000,
	contextPercent: 22,
	runCost: 0.08,
	totalCost: 1.1,
	agentDone: false,
	...overrides,
});

test("formats compact hub timers", () => {
	assert.equal(formatHubTimer(121_000), "02:01");
	assert.equal(formatHubTimer(3_723_000), "1:02:03");
});

test("pane detail puts timer, model, cache state, context, then cost", () => {
	const detail = formatPaneCacheStatus(
		snapshot({
		contextTokens: 182_000,
		contextPercent: 91,
		entries: [
			{
				provider: "anthropic",
				model: "claude-fable-5",
				result: "REUSED",
				expiresAt: 1_121_000,
				durationMs: 300_000,
				lastSeenAt: 1_000_000,
			},
		],
		agentDone: true,
	}),
		1_000_000,
	);
	assert.match(detail, /02:01.*claude-fable-5.*CACHE REUSED/);
	assert.match(detail, /CTX\s+182k\/200k\s+91%/);
	assert.match(detail, /RUN \$0\.08 TOTAL \$1\.10/);
	assert.match(detail, /AGENT DONE/);
	assert.doesNotMatch(detail, /R:|\+/);
});

test("group summary favors the warm cache and worst live context", () => {
	const summary = formatGroupCacheStatus(
		[
			snapshot({
				contextPercent: 91,
				totalCost: 2.9,
				entries: [
					{
						provider: "anthropic",
						model: "expired-model",
						result: "REUSED",
						expiresAt: 999_000,
						durationMs: 300_000,
						lastSeenAt: 900_000,
					},
				],
			}),
			snapshot({
				contextPercent: 22,
				totalCost: 1.1,
				busyStartedAt: 160_000,
				entries: [
					{
						provider: "openai",
						model: "gpt-5.6",
						result: "CREATED",
						expiresAt: 1_690_000,
						durationMs: 1_800_000,
						lastSeenAt: 1_000_000,
					},
				],
			}),
		],
		1_000_000,
	);
	assert.match(summary, /gpt-5\.6.*CACHE CREATED/);
	assert.match(summary, /CTX\s+91%/);
	assert.match(summary, /\$ 4\.00/);
	assert.match(summary, /BUSY 14m/);
});
