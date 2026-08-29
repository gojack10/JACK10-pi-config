import assert from "node:assert/strict";
import test from "node:test";
import { formatFooterDuration } from "./duration.ts";

test("footer durations switch to days after 24 hours", () => {
	assert.equal(formatFooterDuration(4_871_000), "01:21:11");
	assert.equal(formatFooterDuration(86_400_000), "1D 00:00:00");
	assert.equal(formatFooterDuration((4 * 86_400 + 12 * 3600 + 43 * 60 + 54) * 1000), "4D 12:43:54");
});
