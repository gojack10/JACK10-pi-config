import assert from "node:assert/strict";
import test from "node:test";
import * as placement from "./placement.ts";

const {
	QUOTA_TEXT_COLOR,
	quotaBarColorForRemainingPercent,
	quotaBarForRemainingPercent,
} = placement;

test("has no provider-specific or beside-cache quota variant", () => {
	assert.equal("quotaPlacementForProvider" in placement, false);
	assert.equal("appendQuotaBesideCache" in placement, false);
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
