import assert from "node:assert/strict";
import test from "node:test";
import {
	appendQuotaBesideCache,
	quotaColorForUsedPercent,
	quotaPlacementForProvider,
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
			() => "CODEX-QUOTA: TOTAL 40%",
			(text) => text.length,
			(text, width) => text.slice(0, width),
		),
		true,
	);
	assert.equal(lines.length, originalLength);
	assert.match(lines[2], /│ ROW    │ CODEX-QUOTA: TOTAL 40%/);
	assert.doesNotMatch(lines.join("\n"), /5H|WEEK/);
	assert.doesNotMatch(lines[1], /CODEX-QUOTA:/);
	assert.doesNotMatch(lines[3], /CODEX-QUOTA:/);
});

test("colors used percentages by remaining quota thresholds", () => {
	assert.equal(quotaColorForUsedPercent(70), "success");
	assert.equal(quotaColorForUsedPercent(71), "warning");
	assert.equal(quotaColorForUsedPercent(84), "warning");
	assert.equal(quotaColorForUsedPercent(85), "error");
});
