import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderLockExpectations,
  computeOrderLockExpectation
} from "../application/order-lock-expectations.js";
import type { SpotOrderRecord, SpotTradeRecord } from "../domain/types.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

const at = "2026-01-01T00:00:00.000Z";

function order(partial: Partial<SpotOrderRecord>): SpotOrderRecord {
  return {
    orderId: "o-1",
    idempotencyKey: `idem-${partial.orderId ?? "o-1"}`,
    traceId: "t",
    userId: "u",
    accountId: "a",
    market: "ETH-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "3000",
    quantity: "1",
    filledQuantity: "0",
    restingQuantity: "1",
    status: "accepted",
    lockAssetCode: "USDT",
    lockAmount: "3000",
    createdAt: at,
    updatedAt: at,
    ...partial
  };
}

function trade(partial: Partial<SpotTradeRecord>): SpotTradeRecord {
  return {
    tradeId: "t-1",
    market: "ETH-USDT",
    price: "2990",
    quantity: "0.4",
    makerOrderId: "maker",
    takerOrderId: "o-1",
    buyerOrderId: "o-1",
    sellerOrderId: "maker",
    buyerUserId: "u",
    sellerUserId: "m",
    buyerAccountId: "a",
    sellerAccountId: "m",
    sellerFeeRate: "0.001",
    buyerFeeRate: "0.001",
    executionId: "e",
    executionBatchId: "b",
    executionSequence: 1,
    executionBatchSequence: 1,
    replayCursor: "c",
    protocolVersion: "v2",
    settlementId: "pending",
    executedAt: "2026-01-01T00:00:05.000Z",
    ...partial
  };
}

const pendingIsUnsettled = (item: SpotTradeRecord) => item.settlementId !== "pending";

test("a resting buy order expects price × resting quantity", () => {
  const result = computeOrderLockExpectation({ order: order({}), trades: [], isTradeSettled: pendingIsUnsettled });
  assert.equal(result.expectedLockAmount, "3000");
  assert.equal(result.inFlight, false);
});

test("a partially filled buy adds the unsettled fill at the trade price, not the limit price", () => {
  const partially = order({ status: "partially_filled", filledQuantity: "0.4", restingQuantity: "0.6" });
  const unsettled = computeOrderLockExpectation({ order: partially, trades: [trade({})], isTradeSettled: pendingIsUnsettled });
  // 3000 × 0.6 open + 2990 × 0.4 still to be consumed by settlement
  assert.equal(unsettled.openLockAmount, "1800");
  assert.equal(unsettled.unsettledAmount, "1196");
  assert.equal(unsettled.expectedLockAmount, "2996");
  assert.equal(unsettled.unsettledTradeCount, 1);
  assert.equal(unsettled.lastTradeAt, "2026-01-01T00:00:05.000Z");

  const settled = computeOrderLockExpectation({
    order: partially,
    trades: [trade({ settlementId: "settlement-1" })],
    isTradeSettled: pendingIsUnsettled
  });
  assert.equal(settled.expectedLockAmount, "1800");
});

test("sell orders lock and consume base quantity; terminal orders expect only unsettled fills", () => {
  const sell = order({ orderId: "s-1", side: "sell", lockAssetCode: "ETH", lockAmount: "1", status: "filled", filledQuantity: "1", restingQuantity: "0" });
  const fill = trade({ buyerOrderId: "maker", sellerOrderId: "s-1", quantity: "1" });
  assert.equal(computeOrderLockExpectation({ order: sell, trades: [fill], isTradeSettled: pendingIsUnsettled }).expectedLockAmount, "1");
  assert.equal(
    computeOrderLockExpectation({ order: sell, trades: [{ ...fill, settlementId: "done" }], isTradeSettled: pendingIsUnsettled }).expectedLockAmount,
    "0"
  );
  const cancelled = order({ status: "cancelled", restingQuantity: "0" });
  assert.equal(computeOrderLockExpectation({ order: cancelled, trades: [], isTradeSettled: pendingIsUnsettled }).expectedLockAmount, "0");
});

test("pending_risk and recovery_pending orders are flagged in flight", () => {
  for (const status of ["pending_risk", "recovery_pending"] as const) {
    const result = computeOrderLockExpectation({ order: order({ status }), trades: [], isTradeSettled: pendingIsUnsettled });
    assert.equal(result.inFlight, true);
    assert.equal(result.inFlightReason, status);
  }
});

test("report covers open orders plus explicitly requested terminal ones", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder(order({ orderId: "open-1" }));
  await repository.saveOrder(order({ orderId: "done-1", status: "filled", restingQuantity: "0", filledQuantity: "1" }));
  await repository.saveOrder(order({ orderId: "done-2", status: "cancelled", restingQuantity: "0" }));
  await repository.saveTrade(trade({ tradeId: "t-done", buyerOrderId: "done-1", quantity: "1" }));

  const withOpen = await buildOrderLockExpectations({
    source: repository,
    orderIds: ["done-1"],
    includeOpenOrders: true,
    isTradeSettled: pendingIsUnsettled,
    generatedAt: at
  });
  const byId = new Map(withOpen.items.map((item) => [item.orderId, item]));
  assert.deepEqual([...byId.keys()].sort(), ["done-1", "open-1"]);
  assert.equal(byId.get("done-1")?.expectedLockAmount, "2990");

  const onlyIds = await buildOrderLockExpectations({
    source: repository,
    orderIds: ["done-2"],
    includeOpenOrders: false,
    isTradeSettled: pendingIsUnsettled,
    generatedAt: at
  });
  assert.deepEqual(onlyIds.items.map((item) => item.orderId), ["done-2"]);
});
