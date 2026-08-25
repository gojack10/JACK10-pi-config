import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaCountdown, renderQuotaLine } from "./quota.ts";
import type { QuotaStatus } from "../codex-quota-extension/store.ts";

const theme = { fg: (_color: string, text: string) => text };
const now = 1_000_000;
const render = (status: QuotaStatus | undefined, width = 120) =>
	renderQuotaLine(status, width, theme, now);

test("renders the same dedicated two-bar row for every provider", () => {
	const status = { h5: 100, week: 63, routable: true, stale: false } as const;
	const lines = ["openai-codex-alt", "anthropic"].map(() => render(status)!);
	assert.equal(lines[0], lines[1]);
	assert.match(lines[0], /^CODEX   5H   ██████████ 100%   \|   WEEK ██████░░░░  63%$/);
	assert.doesNotMatch(lines[0], /\[|TOTAL|AGE|account/i);
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

test("renders stale only for router refusal and keeps aged values", () => {
	assert.equal(render({ routable: false, stale: true }), "CODEX   5H   --   |   WEEK --   |   STALE");
	assert.equal(render(undefined), "CODEX   5H   --   |   WEEK --   |   STALE");
	const aged = { h5: 10, week: 10, routable: true, stale: false, aged: true } as const;
	assert.match(render(aged)!, /5H   █░{9}  10%.*WEEK █░{9}  10%/);
});

test("keeps countdowns to two useful units", () => {
	assert.equal(formatQuotaCountdown((48 * 60 + 34) * 1000), "48:34");
	assert.equal(formatQuotaCountdown((5 * 3600 + 7 * 60) * 1000), "05:07");
	assert.equal(formatQuotaCountdown((52 * 3600) * 1000), "2d 4h");
});
