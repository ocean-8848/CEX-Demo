import assert from "node:assert/strict";
import test from "node:test";

import { OrderApplicationService } from "../application/order-application-service.js";
import { selectTriggeredStopOrders } from "../application/stop-order-trigger.js";
import { StopOrderTriggerWorker } from "../application/stop-order-trigger-worker.js";
import type { MatchingEngineClient, RiskOrderClient } from "../domain/clients.js";
import type { MatchingSubmitResult, SpotOrderRecord, SpotTradeRecord } from "../domain/types.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

type SubmitCommand = Parameters<MatchingEngineClient["submitOrder"]>[0];
type RiskCommand = Parameters<RiskOrderClient["validateSpotOrder"]>[0];

function baseOrder(overrides: Partial<SpotOrderRecord>): SpotOrderRecord {
  return {
    orderId: "o",
    idempotencyKey: "o",
    traceId: "t",
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "buy",
    type: "stop_limit",
    timeInForce: "gtc",
    price: "3300",
    quantity: "1",
    filledQuantity: "0",
    restingQuantity: "0",
    status: "pending_trigger",
    lockAssetCode: "USDT",
    lockAmount: "3300",
    createdAt: "2026-10-10T10:00:00.000Z",
    updatedAt: "2026-10-10T10:00:00.000Z",
    triggerPrice: "3250",
    ...overrides
  };
}

function trade(price: string, executionSequence: number): SpotTradeRecord {
  return {
    tradeId: `trade-${executionSequence}`,
    market: "ETH-USDT",
    price,
    quantity: "0.1",
    makerOrderId: "m",
    takerOrderId: "t",
    buyerOrderId: "t",
    sellerOrderId: "m",
    buyerUserId: "u1",
    sellerUserId: "u2",
    buyerAccountId: "a1",
    sellerAccountId: "a2",
    sellerFeeRate: "0.001",
    buyerFeeRate: "0.002",
    executionId: `ETH-USDT:${executionSequence}:1`,
    executionBatchId: `ETH-USDT:${executionSequence}`,
    executionSequence,
    executionBatchSequence: 1,
    replayCursor: `ETH-USDT:${executionSequence}`,
    protocolVersion: "v2",
    settlementId: "s",
    executedAt: "2026-10-10T10:00:00.000Z"
  };
}

function createHarness(engineResult: (command: SubmitCommand) => MatchingSubmitResult) {
  const repository = new InMemoryOrderRepository();
  const ledger: string[] = [];
  const submits: SubmitCommand[] = [];
  const riskCalls: RiskCommand[] = [];
  let counter = 0;
  let clock = Date.parse("2026-10-10T10:00:00.000Z");
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder(command) {
        riskCalls.push(command);
        const isBuy = command.side === "buy";
        return {
          market: command.market,
          baseAsset: "ETH",
          quoteAsset: "USDT",
          lockAssetCode: isBuy ? "USDT" : "ETH",
          lockAmount: isBuy ? "3300" : command.quantity,
          feeRate: "0.002",
          timeInForce: command.type === "market" || command.type === "stop_market" ? "ioc" : "gtc"
        };
      }
    },
    {
      async freezeBalance(command) {
        ledger.push(`freeze:${command.referenceId}:${command.amount}`);
        return {};
      },
      async releaseBalance(command) {
        ledger.push(`release:${command.referenceId}:${command.amount ?? "all"}`);
        return {};
      }
    },
    {
      async settleTrade() {
        return { settlementId: "settlement-1" };
      }
    },
    {
      async submitOrder(command) {
        submits.push(command);
        return engineResult(command);
      },
      async seedOrder(command) {
        return { outcome: "seeded", orderId: command.orderId };
      },
      async cancelOrder(command) {
        return { outcome: "cancelled", orderId: command.orderId };
      },
      async resetBook(command) {
        return { outcome: "reset", market: command.market };
      },
      async getBookSnapshot(command) {
        return { market: command.market, bids: [], asks: [] };
      }
    },
    {
      now: () => new Date((clock += 1000)),
      createId: () => `id-${++counter}`
    }
  );
  return { repository, service, ledger, submits, riskCalls };
}

const resting = (command: SubmitCommand): MatchingSubmitResult => ({
  outcome: "resting",
  orderId: command.orderId,
  trades: []
});

test("selectTriggeredStopOrders: buy fires at last >= trigger, sell at last <= trigger, oldest first", () => {
  const orders = [
    baseOrder({ orderId: "buy-late", side: "buy", triggerPrice: "3250", createdAt: "2026-10-10T10:00:02.000Z" }),
    baseOrder({ orderId: "buy-early", side: "buy", triggerPrice: "3200", createdAt: "2026-10-10T10:00:01.000Z" }),
    baseOrder({ orderId: "buy-high", side: "buy", triggerPrice: "3300" }),
    baseOrder({ orderId: "sell-hit", side: "sell", type: "stop_market", triggerPrice: "3260" }),
    baseOrder({ orderId: "sell-miss", side: "sell", type: "stop_market", triggerPrice: "3100" }),
    baseOrder({ orderId: "plain-limit", type: "limit", triggerPrice: "1" }),
    baseOrder({ orderId: "already-triggered", status: "accepted" })
  ];

  assert.deepEqual(
    selectTriggeredStopOrders(orders, "3250").map((order) => order.orderId),
    ["sell-hit", "buy-early", "buy-late"]
  );
  assert.deepEqual(selectTriggeredStopOrders(orders, "3199.99").map((order) => order.orderId), [
    "sell-hit"
  ]);
  assert.deepEqual(
    selectTriggeredStopOrders(orders, "3100").map((order) => order.orderId).sort(),
    ["sell-hit", "sell-miss"]
  );
});

test("stop_limit waits in pending_trigger with funds frozen and triggers exactly once", async () => {
  const { repository, service, ledger, submits, riskCalls } = createHarness(resting);

  const placed = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "buy",
    type: "stop_limit",
    price: "3300",
    triggerPrice: "3250",
    quantity: "1",
    idempotencyKey: "stop-1"
  });

  assert.equal(placed.status, "pending_trigger");
  assert.equal(placed.triggerPrice, "3250");
  assert.equal(riskCalls[0]?.triggerPrice, "3250");
  assert.deepEqual(ledger, ["freeze:id-1:3300"]);
  assert.equal(submits.length, 0, "not in the engine before the trigger");

  // No trade yet, then a trade below the trigger: nothing happens.
  assert.deepEqual((await service.triggerStopOrders("ETH-USDT")).triggeredOrderIds, []);
  await repository.saveTrade(trade("3240", 1));
  assert.deepEqual((await service.triggerStopOrders("ETH-USDT")).triggeredOrderIds, []);

  await repository.saveTrade(trade("3250", 2));
  const result = await service.triggerStopOrders("ETH-USDT");
  assert.deepEqual(result.triggeredOrderIds, [placed.orderId]);
  assert.equal(result.lastPrice, "3250");
  assert.equal(submits.length, 1);
  assert.equal(submits[0]?.type, "limit");
  assert.equal(submits[0]?.price, "3300");
  assert.equal(submits[0]?.ownerId, "acct-1");

  const stored = await repository.findOrderById(placed.orderId);
  assert.equal(stored?.status, "accepted");
  assert.equal(stored?.type, "stop_limit");
  assert.ok(stored?.triggeredAt);
  assert.equal(submits[0]?.createdAt, stored?.triggeredAt, "queues from the trigger time");

  // Idempotent: a second pass (or a restarted worker) does not resubmit.
  await service.triggerStopOrders("ETH-USDT", "3400");
  assert.equal(submits.length, 1);
});

test("cancelling an untriggered stop order releases the whole freeze and never triggers", async () => {
  const { service, ledger, submits } = createHarness(resting);
  const placed = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "sell",
    type: "stop_market",
    triggerPrice: "3000",
    quantity: "0.5",
    idempotencyKey: "stop-2"
  });
  assert.equal(placed.status, "pending_trigger");
  assert.equal(placed.timeInForce, "ioc");

  const cancelled = await service.cancelOrder({ orderId: placed.orderId, userId: "user-1" });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(ledger, [`freeze:${placed.orderId}:0.5`, `release:${placed.orderId}:all`]);

  await service.triggerStopOrders("ETH-USDT", "2900");
  assert.equal(submits.length, 0);
});

test("triggered stop_market sell is submitted as a market order without price", async () => {
  const { service, submits } = createHarness((command) => ({
    outcome: "cancelled",
    orderId: command.orderId,
    reason: "no_executable_liquidity",
    trades: []
  }));
  const placed = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "sell",
    type: "stop_market",
    triggerPrice: "3000",
    quantity: "0.5",
    idempotencyKey: "stop-3"
  });

  const worker = new StopOrderTriggerWorker(
    { triggerStopOrders: (market) => service.triggerStopOrders(market, "2999") },
    { pollIntervalMs: 0, listMarkets: () => ["ETH-USDT"] }
  );
  const [result] = await worker.runOnce();
  assert.deepEqual(result?.triggeredOrderIds, [placed.orderId]);
  assert.equal(submits[0]?.type, "market");
  assert.equal(submits[0]?.price, undefined);
  assert.equal(submits[0]?.timeInForce, "ioc");
  assert.equal(worker.getStatus().triggeredCount, 1);
});

test("post-only order that would take is rejected with the engine reason and its freeze released", async () => {
  const { service, ledger, submits, riskCalls } = createHarness((command) => ({
    outcome: "cancelled",
    orderId: command.orderId,
    takerStatus: "cancelled",
    reason: "post_only_would_take",
    trades: []
  }));

  const order = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "3300",
    quantity: "1",
    postOnly: true,
    stpMode: "expire_maker",
    idempotencyKey: "po-1"
  });

  assert.equal(riskCalls[0]?.postOnly, true);
  assert.equal(submits[0]?.postOnly, true);
  assert.equal(submits[0]?.stpMode, "expire_maker");
  assert.equal(order.status, "rejected");
  assert.equal(order.rejectedReason, "post_only_would_take");
  assert.equal(order.postOnly, true);
  assert.deepEqual(ledger, [`freeze:${order.orderId}:3300`, `release:${order.orderId}:all`]);
});

test("STP expire_maker closes the own resting order and releases its remaining freeze", async () => {
  const { repository, service, ledger } = createHarness((command) => ({
    outcome: "resting",
    orderId: command.orderId,
    trades: [],
    expiredMakers: [{ orderId: "own-bid", quantity: "0.4", reason: "stp_expired_maker" }]
  }));
  await repository.saveOrder(
    baseOrder({
      orderId: "own-bid",
      idempotencyKey: "own-bid",
      type: "limit",
      side: "buy",
      price: "3200",
      quantity: "1",
      filledQuantity: "0.6",
      restingQuantity: "0.4",
      status: "partially_filled",
      lockAmount: "3200",
      triggerPrice: undefined
    })
  );

  const order = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "ETH-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "3200",
    quantity: "0.5",
    stpMode: "expire_maker",
    idempotencyKey: "stp-1"
  });

  assert.equal(order.status, "accepted");
  const maker = await repository.findOrderById("own-bid");
  assert.equal(maker?.status, "cancelled");
  assert.equal(maker?.rejectedReason, "stp_expired_maker");
  assert.equal(maker?.restingQuantity, "0");
  // 0.4 * 3200 left frozen for the expired remainder.
  assert.ok(ledger.includes("release:own-bid:1280"), ledger.join(","));
});
