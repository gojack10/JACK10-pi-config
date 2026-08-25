import assert from "node:assert/strict";
import test from "node:test";
import {
	appendQuotaBesideCache,
	quotaPlacementForProvider,
} from "./placement.ts";

test("places Codex chat quota above and other chat quota beside cache", () => {
	assert.equal(quotaPlacementForProvider("openai-codex-alt"), "above");
	assert.equal(quotaPlacementForProvider("anthropic"), "beside");

	const lines = ["MODEL", "CACHE----┐", "│ ROW    │", "└--------┘"];
	const originalLength = lines.length;
	assert.equal(
		appendQuotaBesideCache(
			lines,
			1,
			4,
			80,
			() => "CODEX-QUOTA: 5H 46% | WEEK 76% | TOTAL 40%",
			(text) => text.length,
			(text, width) => text.slice(0, width),
		),
		true,
	);
	assert.equal(lines.length, originalLength);
	assert.match(lines[2], /│ ROW    │ CODEX-QUOTA:/);
	assert.doesNotMatch(lines[1], /CODEX-QUOTA:/);
	assert.doesNotMatch(lines[3], /CODEX-QUOTA:/);
});
