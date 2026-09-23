import assert from "node:assert/strict";
import test from "node:test";

import { buildRequestHeaders } from "./request-headers.ts";

test("tunnel wrapper preserves the queue correlation and origin headers", () => {
  const headers = buildRequestHeaders({
    "X-Pi-Request-Id": "queue-ticket",
    "X-Pi-Origin": "vega-rewriter",
    Authorization: "Bearer test",
  });
  assert.equal(headers["X-Pi-Request-Id"], "queue-ticket");
  assert.equal(headers["X-Pi-Origin"], "vega-rewriter");
  assert.equal(headers.Authorization, "Bearer test");
});

test("tunnel wrapper generates missing request ids without duplicating lowercase headers", () => {
  const generated = buildRequestHeaders({}, "generated-ticket", "user");
  assert.equal(generated["X-Pi-Request-Id"], "generated-ticket");
  assert.equal(generated["X-Pi-Origin"], "user");

  const lowercase = buildRequestHeaders({ "x-pi-request-id": "lowercase-ticket" }, "unused");
  assert.equal(lowercase["x-pi-request-id"], "lowercase-ticket");
  assert.equal(lowercase["X-Pi-Request-Id"], undefined);
});
