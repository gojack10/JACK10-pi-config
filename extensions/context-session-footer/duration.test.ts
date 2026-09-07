import assert from "node:assert/strict";
import test from "node:test";
import { formatFooterCountdown, formatFooterDuration } from "./duration.ts";

test("footer durations switch to days after 24 hours", () => {
	assert.equal(formatFooterDuration(4_871_000), "01:21:11");
	assert.equal(formatFooterDuration(86_400_000), "1D 00:00:00");
	assert.equal(formatFooterDuration((4 * 86_400 + 12 * 3600 + 43 * 60 + 54) * 1000), "4D 12:43:54");
});

test("footer countdowns drop zero units and pad nothing", () => {
	assert.equal(formatFooterCountdown(2_734_000), "45M:34S");
	assert.equal(formatFooterCountdown(11_375_000), "3H:9M:35S");
	assert.equal(formatFooterCountdown(355_159_000), "4D:2H:39M:19S");
	assert.equal(formatFooterCountdown(3_600_000), "1H");
	assert.equal(formatFooterCountdown(61_000), "1M:1S");
	assert.equal(formatFooterCountdown(1_000), "1S");
	assert.equal(formatFooterCountdown(0), "0S");
});
