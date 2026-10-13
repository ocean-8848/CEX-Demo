import assert from "node:assert/strict";
import test from "node:test";

import {
  describeOrderReason,
  describeOrderType,
  engineTypeOf,
  isStopType,
  stopTriggerHint
} from "../client/lib/order-options.js";
import { describeOrderStatus, isOpenOrder } from "../client/lib/records.js";

test("stop orders are open while pending_trigger and labelled 待触发", () => {
  assert.equal(isOpenOrder({ orderId: "s", status: "pending_trigger" }), true);
  assert.equal(describeOrderStatus("pending_trigger").label, "待触发");
  assert.equal(isStopType("stop_limit"), true);
  assert.equal(isStopType("limit"), false);
  assert.equal(engineTypeOf("stop_market"), "market");
  assert.equal(engineTypeOf("stop_limit"), "limit");
});

test("order type labels include post-only and stop kinds", () => {
  assert.equal(describeOrderType({ type: "limit", timeInForce: "gtc", postOnly: true }), "限价 · GTC · 只做Maker");
  assert.equal(describeOrderType({ type: "stop_limit", timeInForce: "gtc" }), "止损限价 · GTC");
  assert.equal(describeOrderType({ type: "stop_market" }), "止损市价");
  assert.equal(describeOrderType({ type: "market" }), "市价");
});

test("engine reasons are translated, unknown reasons pass through", () => {
  assert.match(describeOrderReason("post_only_would_take") ?? "", /只做 Maker/);
  assert.match(describeOrderReason("stp_expired_taker") ?? "", /自成交保护/);
  assert.match(describeOrderReason("stp_expired_maker") ?? "", /自成交保护/);
  assert.equal(describeOrderReason("PRICE_DEVIATION_TOO_HIGH"), "PRICE_DEVIATION_TOO_HIGH");
  assert.equal(describeOrderReason(undefined), undefined);
});

test("stop trigger hint follows buy >= / sell <= semantics", () => {
  assert.match(stopTriggerHint("buy", 3300, 3200) ?? "", /涨到 3300/);
  assert.match(stopTriggerHint("buy", 3100, 3200) ?? "", /下一次价格检查就会触发/);
  assert.match(stopTriggerHint("sell", 3000, 3200) ?? "", /跌到 3000/);
  assert.match(stopTriggerHint("sell", 3300, 3200) ?? "", /下一次价格检查就会触发/);
  assert.equal(stopTriggerHint("sell", 0, 3200), null);
});
