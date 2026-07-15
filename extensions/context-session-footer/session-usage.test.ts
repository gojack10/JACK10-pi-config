import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentRunUsage, getSessionUsage } from "./session-usage.ts";

const assistant = (timestamp: string, input: number, cost: number) => ({
	type: "message",
	timestamp,
	message: {
		role: "assistant",
		usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
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
	const activeBranch = allEntries.filter((entry) => entry.timestamp !== "2026-01-03T01:00:00.000Z");

	assert.equal(getSessionUsage(allEntries, startedAt).cost, 21);
	assert.equal(getCurrentRunUsage(activeBranch, startedAt).cost, 6);
});
