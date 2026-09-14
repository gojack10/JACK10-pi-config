import assert from "node:assert/strict";
import test from "node:test";
import {
	formatGroupCacheStatus,
	formatHubTimer,
	getSessionCacheState,
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

test("labels a reused cache without remaining time as expired", () => {
	const detail = formatPaneCacheStatus(
		snapshot({
			entries: [
				{
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					result: "REUSED",
					durationMs: 1_800_000,
					lastSeenAt: 1_000_000,
				},
			],
		}),
		1_000_000,
	);
	assert.match(detail, /CACHE EXPIRED/);
	assert.doesNotMatch(detail, /CACHE REUSED/);
});

test("labels a policy-derived timer as warm only until expiry", () => {
	const value = snapshot({
		entries: [
			{
				provider: "openai",
				model: "gpt-5.6",
				result: "NO CACHE",
				expiresAt: 1_300_000,
				durationMs: 1_800_000,
				lastSeenAt: 1_000_000,
			},
		],
	});
	const warm = formatPaneCacheStatus(value, 1_000_000);
	assert.match(warm, /CACHE WARM/);
	assert.doesNotMatch(warm, /NO CACHE/);
	assert.match(formatPaneCacheStatus(value, 1_300_000), /NO CACHE/);
});

test("stable snapshot rendering advances countdown and busy elapsed time", () => {
	const value = snapshot({
		updatedAt: 900_000,
		busyStartedAt: 820_000,
		entries: [{
			provider: "openai",
			model: "gpt-5.6",
			result: "REUSED",
			expiresAt: 1_121_000,
			durationMs: 300_000,
			lastSeenAt: 900_000,
		}],
	});
	assert.match(formatPaneCacheStatus(value, 1_000_000), /02:01.*BUSY 3m/);
	assert.match(formatPaneCacheStatus(value, 1_061_000), /01:00.*BUSY 4m/);
	assert.match(formatPaneCacheStatus(value, 1_121_000), /CACHE EXPIRED.*BUSY 5m/);
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

test("session state aggregates the earliest warm cache and oldest busy pane", () => {
	const state = getSessionCacheState([
		snapshot({
			updatedAt: 100,
			busyStartedAt: 200,
			entries: [{
				provider: "anthropic",
				model: "later",
				result: "REUSED",
				expiresAt: 2_000,
				durationMs: 1_000,
				lastSeenAt: 100,
			}],
		}),
		snapshot({
			updatedAt: 100,
			busyStartedAt: 150,
			entries: [{
				provider: "openai",
				model: "first",
				result: "CREATED",
				expiresAt: 1_500,
				durationMs: 1_000,
				lastSeenAt: 100,
			}],
		}),
	], 1_000);
	assert.deepEqual(state, {
		version: 1,
		entries: [
			{
				provider: "anthropic",
				model: "later",
				result: "REUSED",
				expiresAt: 2_000,
				durationMs: 1_000,
				lastSeenAt: 100,
			},
			{
				provider: "openai",
				model: "first",
				result: "CREATED",
				expiresAt: 1_500,
				durationMs: 1_000,
				lastSeenAt: 100,
			},
		],
		busyStartedAt: 150,
		agentDone: false,
	});
});
