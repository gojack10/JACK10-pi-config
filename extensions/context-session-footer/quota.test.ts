import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";
import { renderQuotaLines } from "./quota.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const visible = (text: string) => text.length;
const fit = (text: string, width: number) => text.slice(0, width);

const status: QuotaStatus = {
	h5: 86,
	week: 78,
	h5Increases: [
		{ at: 9_060, percent: 14 },
		{ at: 11_520, percent: 8 },
		{ at: 17_220, percent: 5 },
	],
	weekIncreases: [
		{ at: 482_400, percent: 18 },
		{ at: 507_600, percent: 3 },
		{ at: 594_000, percent: 7 },
	],
	h5Verifying: false,
	weekVerifying: false,
	routable: true,
	stale: false,
};

test("renders two aligned aggregate bars with every gain", () => {
	assert.deepEqual(renderQuotaLines(status, 300, theme, 60_000, visible, fit), [
		"CODEX 5H   █████████░   86%   +14% IN 02:30:00 / +8% IN 03:11:00 / +5% IN 04:46:00",
		"CODEX WEEK ████████░░   78%   +18% IN 5D 13:59:00 / +3% IN 5D 20:59:00 / +7% IN 6D 20:59:00",
	]);
});

test("uses words for verification and respects width", () => {
	const lines = renderQuotaLines({ ...status, h5Verifying: true }, 32, theme, 60_000, visible, fit);
	assert.equal(lines.length, 2);
	assert.ok(lines[0].startsWith("CODEX 5H"));
	assert.ok(lines.every((line) => line.length <= 32));
});
