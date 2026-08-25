import assert from "node:assert/strict";
import test from "node:test";
import {
	appendQuotaBesideCache,
	QUOTA_TEXT_COLOR,
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
	quotaPlacementForProvider,
} from "./placement.ts";

test("places Codex quota on its own line and other quota beside cache", () => {
	assert.equal(quotaPlacementForProvider("openai-codex-alt"), "line");
	assert.equal(quotaPlacementForProvider("anthropic"), "beside");

	const lines = ["MODEL", "CACHE----┐", "│ ROW    │", "└--------┘"];
	assert.equal(
		appendQuotaBesideCache(
			lines,
			1,
			4,
			80,
			() => "Q 5H 60% · W 40%",
			(text) => text.length,
			(text, width) => text.slice(0, width),
		),
		true,
	);
	assert.match(lines[2], /│ ROW    │ Q 5H 60% · W 40%/);
	assert.doesNotMatch(lines[1], /Q 5H/);
	assert.doesNotMatch(lines[3], /Q 5H/);
});

test("draws proportional ten-cell and narrow five-cell bars", () => {
	assert.equal(quotaBarForRemainingPercent(58), "██████░░░░");
	assert.equal(quotaBarForRemainingPercent(72, 5), "████░");
	assert.equal(quotaBarForRemainingPercent(100), "██████████");
	assert.equal(quotaBarForRemainingPercent(0), "░░░░░░░░░░");
});

test("colors remaining capacity white, yellow below 30, and red below 15", () => {
	assert.equal(QUOTA_TEXT_COLOR, "dim");
	assert.equal(quotaBarColorForRemainingPercent(100), "text");
	assert.equal(quotaBarColorForRemainingPercent(30), "text");
	assert.equal(quotaBarColorForRemainingPercent(29), "warning");
	assert.equal(quotaBarColorForRemainingPercent(15), "warning");
	assert.equal(quotaBarColorForRemainingPercent(14), "error");
	assert.equal(quotaBarColorForRemainingPercent(0), "error");
});
