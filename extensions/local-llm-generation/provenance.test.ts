import assert from "node:assert/strict";
import test from "node:test";
import { formatDecode, formatPrefill } from "../local-llm-generation.ts";

test("progress labels only non-user origins per activity", () => {
  const prefill = (origin?: string) => formatPrefill({
    phase: "prefill", processed: 5, total: 10, tokens: 0, tok_s: 2, origin,
  }, 5);
  const decode = (origin?: string) => formatDecode({
    phase: "decode", processed: 0, total: 0, tokens: 3, tok_s: 2, origin,
  });

  assert.doesNotMatch(prefill(), /USER|REWRITER/);
  assert.doesNotMatch(prefill("user"), /USER|REWRITER/);
  assert.match(prefill("vega-rewriter"), /Prefill \(VEGA-REWRITER\)/);
  assert.match(decode("vega-rewriter"), /Generating \(VEGA-REWRITER\)/);
  assert.equal([prefill("user"), prefill("vega-rewriter")].filter((line) => line.includes("REWRITER")).length, 1);
});
