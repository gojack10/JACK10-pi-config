import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isTerminalCodexUsageLimit, isZeroOutputFailure } from "./resolution.ts";

const failure = (errorMessage: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "error",
	errorMessage,
	timestamp: 1,
	...overrides,
});

test("recognizes terminal ChatGPT account usage limits only", () => {
	assert.equal(isTerminalCodexUsageLimit(failure("You have hit your ChatGPT usage limit (plus plan).")), true);
	assert.equal(isTerminalCodexUsageLimit(failure("usage_limit_reached")), true);
	for (const error of ["network error", "context overflow", "ordinary model error", "rate_limit_exceeded"])
		assert.equal(isTerminalCodexUsageLimit(failure(error)), false, error);
});

test("permits failover only before output, tool calls, or usage", () => {
	assert.equal(isZeroOutputFailure(failure("usage_limit_reached")), true);
	assert.equal(
		isZeroOutputFailure(failure("usage_limit_reached", { content: [{ type: "text", text: "partial" }] })),
		false,
	);
	assert.equal(
		isZeroOutputFailure(
			failure("usage_limit_reached", {
				content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }],
			}),
		),
		false,
	);
	assert.equal(
		isZeroOutputFailure(
			failure("usage_limit_reached", {
				usage: {
					input: 0,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		),
		false,
	);
});
