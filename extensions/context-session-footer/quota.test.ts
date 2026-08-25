import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaCountdown, renderQuotaLine } from "./quota.ts";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";

const theme = { fg: (_color: string, text: string) => text };
const now = 1_000_000;
const render = (status: QuotaStatus | undefined, width = 120, beside = false) =>
	renderQuotaLine(status, width, theme, now, beside);

test("renders the dedicated two-bar umbrella row", () => {
	const line = render({ h5: 100, week: 63, routable: true, stale: false })!;
	assert.match(line, /^CODEX   5H   ██████████ 100%   \|   WEEK ██████░░░░  63%$/);
	assert.doesNotMatch(line, /\[|TOTAL|AGE|account/i);
});

test("renders exhausted and cross-account blocked recovery states", () => {
	const recoveryAt = now / 1000 + 48 * 60 + 34;
	const exhausted = render({ h5: 0, week: 63, routable: false, recoveryAt, stale: false })!;
	assert.match(exhausted, /5H   ░{10}   0%/);
	assert.match(exhausted, /BACK 48:34$/);
	assert.doesNotMatch(exhausted, /OUT|BLOCKED/);

	const split = render({ h5: 72, week: 63, routable: false, recoveryAt, stale: false })!;
	assert.match(split, /BLOCKED · BACK 48:34$/);
});

test("degrades to five-cell bars and then a minimal blocked gate", () => {
	const healthy = { h5: 72, week: 63, routable: true, stale: false } as const;
	assert.match(render(healthy, 40)!, /5H ████░  72%  W ███░░  63%/);
	assert.equal(render(healthy, 18), "5H 72%  W 63%");
	assert.equal(
		render({ h5: 0, week: 63, routable: false, recoveryAt: now / 1000 + 48 * 60 + 34, stale: false }, 20),
		"5H 0%  BACK 48:34",
	);
});

test("renders stale, absent, and beside-CACHE forms", () => {
	assert.equal(render({ routable: false, stale: true }), "CODEX   5H   --   |   WEEK --   |   STALE");
	assert.equal(render(undefined), "CODEX   5H   --   |   WEEK --");
	assert.equal(render({ h5: 72, week: 63, routable: true, stale: false }, 40, true), "Q 5H 72% · W 63%");
	assert.equal(
		render({ h5: 0, week: 63, routable: false, recoveryAt: now / 1000 + 48 * 60 + 34, stale: false }, 40, true),
		"Q BACK 48:34",
	);
});

test("keeps countdowns to two useful units", () => {
	assert.equal(formatQuotaCountdown((48 * 60 + 34) * 1000), "48:34");
	assert.equal(formatQuotaCountdown((5 * 3600 + 7 * 60) * 1000), "05:07");
	assert.equal(formatQuotaCountdown((52 * 3600) * 1000), "2d 4h");
});
