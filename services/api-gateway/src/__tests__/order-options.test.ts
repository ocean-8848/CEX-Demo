import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOrderOptions } from "../application/order-options.js";
import { ApiGatewayError } from "../domain/errors.js";

const base = { type: "limit", accountId: "acct-1", quantity: "1" };

test("order options are normalized and passed through", () => {
  assert.deepEqual(normalizeOrderOptions({ ...base, postOnly: "true", stpMode: "expire_maker" }), {
    ...base,
    postOnly: true,
    stpMode: "expire_maker"
  });
  assert.deepEqual(normalizeOrderOptions({ ...base, postOnly: false, stpMode: "" }), base);
  assert.deepEqual(
    normalizeOrderOptions({ ...base, type: "stop_market", triggerPrice: " 3250 " }),
    { ...base, type: "stop_market", triggerPrice: "3250" }
  );
});

test("malformed order options are rejected", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof ApiGatewayError ? error.code : "other";
    }
    return "none";
  };
  assert.equal(code(() => normalizeOrderOptions({ ...base, stpMode: "nope" })), "INVALID_STP_MODE");
  assert.equal(code(() => normalizeOrderOptions({ ...base, postOnly: 1 })), "INVALID_POST_ONLY");
  assert.equal(code(() => normalizeOrderOptions({ ...base, type: "stop_limit" })), "TRIGGER_PRICE_REQUIRED");
  assert.equal(code(() => normalizeOrderOptions({ ...base, triggerPrice: 3250 })), "INVALID_TRIGGER_PRICE");
});
