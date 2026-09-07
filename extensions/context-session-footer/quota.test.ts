import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { QuotaBucket, QuotaBucketRow } from "../codex-quota-extension/store.ts";
import { renderQuotaLines } from "./quota.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const visible = (text: string) => text.length;
const fit = (text: string, width: number) => text.slice(0, width);

const row = (
	bucket: QuotaBucket,
	window: QuotaBucketRow["window"],
	remaining: number,
	increases: QuotaBucketRow["increases"] = [],
	extra: Partial<QuotaBucketRow> = {},
): QuotaBucketRow => ({
	verifying: false,
	blocked: false,
	stale: false,
	...extra,
	bucket,
	window,
	remaining,
	increases,
});

const threeRows = (): QuotaBucketRow[] => [
	row("PLUS", "5H", 31.5, [{ at: 2000, percent: 18.5 }, { at: 2600, percent: 50 }]),
	row("PLUS", "WEEK", 44.5, [{ at: 7000, percent: 44 }, { at: 7100, percent: 38 }, { at: 9000, percent: 11.5 }]),
	row("PRO", "WEEK", 24, [{ at: 7100, percent: 76 }]),
];

test("renders the locked bucket rows with countdowns and refills", () => {
	assert.deepEqual(renderQuotaLines(threeRows(), 300, theme, 1_000_000, visible, fit), [
		"CODEX PLUS 5H   ███░░░░░░░  31.5%   RESETS 16M:40S +19% - 26M:40S +50%",
		"CODEX PLUS WEEK ████░░░░░░  44.5%   RESETS 1H:40M +44% - 1H:41M:40S +38%",
		"CODEX PRO  WEEK ██░░░░░░░░  24.0%   RESETS 1H:41M:40S +76%",
	]);
});

test("caps schedules at the next two events", () => {
	const lines = renderQuotaLines(threeRows(), 300, theme, 1_000_000, visible, fit);
	assert.match(lines[1]!, /RESETS 1H:40M \+44% - 1H:41M:40S \+38%$/);
	assert.ok(!lines[1]!.includes("+12%"));
});

test("renders bare rows without trailing schedule space", () => {
	assert.deepEqual(renderQuotaLines([row("PRO", "WEEK", 24)], 300, theme, 1_000_000, visible, fit), [
		"CODEX PRO  WEEK ██░░░░░░░░  24.0%",
	]);
});

test("renders verifying rows as bare question countdowns", () => {
	assert.deepEqual(renderQuotaLines([row("PLUS", "5H", 0, [], { verifying: true })], 300, theme, 1_000_000, visible, fit), [
		"CODEX PLUS 5H   ░░░░░░░░░░   0.0%   RESETS ?",
	]);
});

test("badges blocked and stale per row, never both", () => {
	assert.deepEqual(
		renderQuotaLines(
			[
				row("PRO", "WEEK", 10, [{ at: 2000, percent: 90 }], { stale: true }),
				row("PLUS", "5H", 0, [], { blocked: true }),
			],
			300,
			theme,
			1_000_000,
			visible,
			fit,
		),
		[
			"CODEX PRO  WEEK █░░░░░░░░░  10.0%   RESETS 16M:40S +90% STALE",
			"CODEX PLUS 5H   ░░░░░░░░░░   0.0%   BLOCKED",
		],
	);
});

test("respects width and tolerates missing state", () => {
	const lines = renderQuotaLines(threeRows(), 40, theme, 1_000_000, visible, fit);
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => line.length <= 40));
	assert.deepEqual(renderQuotaLines(undefined, 300, theme, 1_000_000, visible, fit), []);
});
