import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";
import { renderQuotaLines } from "./quota.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const visible = (text: string) => text.length;
const fit = (text: string, width: number) => text.slice(0, width);

const status: QuotaStatus = {
	global: 86,
	refillAt: 9_060,
	routable: true,
	stale: false,
};

test("renders one global pacing bar with its next refill", () => {
	assert.deepEqual(renderQuotaLines(status, 300, theme, 60_000, visible, fit), [
		"CODEX GLOBAL █████████░   86%   REFILL IN 02:30:00",
	]);
});

test("shows zero global reserve while every account is blocked", () => {
	assert.deepEqual(
		renderQuotaLines({ ...status, global: 0, routable: false }, 300, theme, 60_000, visible, fit),
		["CODEX GLOBAL ░░░░░░░░░░    0%   RECOVERY IN 02:30:00 / BLOCKED"],
	);
});

test("respects footer width", () => {
	const lines = renderQuotaLines(status, 32, theme, 60_000, visible, fit);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.startsWith("CODEX GLOBAL"));
	assert.ok(lines.every((line) => line.length <= 32));
});
