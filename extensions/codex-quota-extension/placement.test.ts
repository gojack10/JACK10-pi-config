import assert from "node:assert/strict";
import test from "node:test";
import {
	appendQuotaBesideCache,
	QUOTA_TEXT_COLOR,
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
	quotaPlacementForProvider,
	quotaRemainingPercent,
	quotaSegmentsForProvider,
} from "./placement.ts";

test("places full Codex quota above and total-only quota beside cache", () => {
	assert.equal(quotaPlacementForProvider("openai-codex-alt"), "above");
	assert.deepEqual(quotaSegmentsForProvider("openai-codex-alt"), [
		"5H",
		"WEEK",
		"TOTAL",
	]);
	assert.equal(quotaPlacementForProvider("anthropic"), "beside");
	assert.deepEqual(quotaSegmentsForProvider("anthropic"), ["TOTAL"]);

	const lines = ["MODEL", "CACHE----┐", "│ ROW    │", "└--------┘"];
	const originalLength = lines.length;
	assert.equal(
		appendQuotaBesideCache(
			lines,
			1,
			4,
			80,
			() => `CODEX-QUOTA: TOTAL ${quotaRemainingPercent(40)}%`,
			(text) => text.length,
			(text, width) => text.slice(0, width),
		),
		true,
	);
	assert.equal(lines.length, originalLength);
	assert.match(lines[2], /│ ROW    │ CODEX-QUOTA: TOTAL 60%/);
	assert.doesNotMatch(lines.join("\n"), /5H|WEEK/);
	assert.doesNotMatch(lines[1], /CODEX-QUOTA:/);
	assert.doesNotMatch(lines[3], /CODEX-QUOTA:/);
});

test("displays remaining percentage with proportional bars", () => {
	assert.equal(quotaRemainingPercent(42), 58);
	assert.equal(quotaRemainingPercent(122 / 2), 39);
	assert.equal(quotaRemainingPercent(0), 100);
	assert.equal(quotaRemainingPercent(100), 0);
	assert.equal(quotaBarForRemainingPercent(58), "██████░░░░");
	assert.equal(quotaBarForRemainingPercent(100), "██████████");
	assert.equal(quotaBarForRemainingPercent(0), "░░░░░░░░░░");
});

test("colors bars white, yellow, or red by remaining thresholds", () => {
	assert.equal(QUOTA_TEXT_COLOR, "dim");
	assert.equal(quotaBarColorForRemainingPercent(100), "text");
	assert.equal(quotaBarColorForRemainingPercent(30), "text");
	assert.equal(quotaBarColorForRemainingPercent(29), "warning");
	assert.equal(quotaBarColorForRemainingPercent(16), "warning");
	assert.equal(quotaBarColorForRemainingPercent(15), "error");
	assert.equal(quotaBarColorForRemainingPercent(0), "error");
});
