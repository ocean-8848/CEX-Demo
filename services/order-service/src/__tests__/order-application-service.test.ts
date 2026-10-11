import assert from "node:assert/strict";
import test from "node:test";

import { OrderApplicationService } from "../application/order-application-service.js";
import { OrderOpsService } from "../application/order-ops-service.js";
import type { MatchingEngineClient } from "../domain/clients.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

test("createOrder freezes balance and stores resting order", async () => {
  const ledgerEvents: string[] = [];
  const service = new OrderApplicationService(
    new InMemoryOrderRepository(),
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance(command) {
        ledgerEvents.push(`freeze:${command.referenceId}:${command.amount}`);
        return {};
      },
      async releaseBalance(command) {
        ledgerEvents.push(`release:${command.referenceId}`);
        return {};
      }
    },
    {
      async settleTrade() {
        return {
          settlementId: "settlement-1"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "resting",
          orderId: command.orderId,
          trades: []
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    },
    {
      now: () => new Date("2026-03-08T11:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `id-${++counter}`;
      })()
    }
  );

  const order = await service.createOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    idempotencyKey: "order:1"
  });

  assert.equal(order.status, "accepted");
  assert.equal(order.restingQuantity, "0.01");
  assert.equal(ledgerEvents[0], "freeze:id-1:650");
});

test("createOrder settles exact match and stores trade", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-1",
    idempotencyKey: "maker",
    traceId: "maker-trace",
    userId: "seller-1",
    accountId: "acct-seller",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade() {
        return {
          settlementId: "settlement-1"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "filled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-1",
              takerOrderId: command.orderId,
              price: "65000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:00:00.000Z",
              executionId: "exec-maker-1-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    },
    {
      now: () => new Date("2026-03-08T11:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `id-${++counter}`;
      })()
    }
  );

  const order = await service.createOrder({
    userId: "buyer-1",
    accountId: "acct-buyer",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    idempotencyKey: "order:2"
  });

  const trades = await service.listTrades({
    userId: "buyer-1"
  });

  assert.equal(order.status, "filled");
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.settlementId, "settlement-1");
  // The incoming buy order is the taker, the resting sell order the maker.
  assert.equal(trades[0]?.buyerFeeRate, "0.001");
  assert.equal(trades[0]?.sellerFeeRate, "0.0005");
});

test("partial fill keeps resting quantity and releases quote surplus", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-2",
    idempotencyKey: "maker-2",
    traceId: "maker-trace-2",
    userId: "seller-2",
    accountId: "acct-seller-2",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "64000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  const releases: string[] = [];
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "1300",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance(command) {
        releases.push(command.amount ?? "all");
        return {};
      }
    },
    {
      async settleTrade() {
        return {
          settlementId: "settlement-2"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "resting",
          takerRemainingQuantity: "0.01",
          trades: [
            {
              makerOrderId: "maker-2",
              takerOrderId: command.orderId,
              price: "64000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:10:00.000Z",
              executionId: "exec-maker-2-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    }
  );

  const order = await service.createOrder({
    userId: "buyer-2",
    accountId: "acct-buyer-2",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.02",
    idempotencyKey: "order:3"
  });

  assert.equal(order.status, "partially_filled");
  assert.equal(order.restingQuantity, "0.01");
  assert.equal(releases[0], "10");
});

test("multi-level sweep settles across multiple makers", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-a",
    idempotencyKey: "maker-a",
    traceId: "maker-a-trace",
    userId: "seller-a",
    accountId: "acct-seller-a",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "64000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });
  await repository.saveOrder({
    orderId: "maker-b",
    idempotencyKey: "maker-b",
    traceId: "maker-b-trace",
    userId: "seller-b",
    accountId: "acct-seller-b",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "64100",
    quantity: "0.015",
    filledQuantity: "0",
    restingQuantity: "0.015",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.015",
    createdAt: "2026-03-08T10:00:01.000Z",
    updatedAt: "2026-03-08T10:00:01.000Z"
  });

  const settlementTradeIds: string[] = [];
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "1605",
          feeRate: "0.001",
          timeInForce: "ioc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade(command) {
        settlementTradeIds.push(command.tradeId);
        return {
          settlementId: `settlement-${settlementTradeIds.length}`
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "filled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-a",
              takerOrderId: command.orderId,
              price: "64000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:20:00.000Z",
              executionId: "exec-maker-a-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            },
            {
              makerOrderId: "maker-b",
              takerOrderId: command.orderId,
              price: "64100",
              quantity: "0.015",
              executedAt: "2026-03-08T11:20:01.000Z",
              executionId: "exec-maker-b-2",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 2,
              executionBatchSequence: 2,
              replayCursor: "BTC-USDT:2",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    }
  );

  const order = await service.createOrder({
    userId: "buyer-4",
    accountId: "acct-buyer-4",
    market: "BTC-USDT",
    side: "buy",
    type: "market",
    quantity: "0.025",
    idempotencyKey: "order:multi"
  });

  const trades = await service.listTrades({
    userId: "buyer-4"
  });

  assert.equal(order.status, "filled");
  assert.equal(trades.length, 2);
  assert.equal(settlementTradeIds.length, 2);
});

test("matched IOC flow normalizes floating precision noise before settlement", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-eth-1",
    idempotencyKey: "maker-eth-1",
    traceId: "maker-eth-trace-1",
    userId: "seller-eth-1",
    accountId: "acct-seller-eth-1",
    market: "ETH-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "3200.00",
    quantity: "2.500",
    filledQuantity: "0",
    restingQuantity: "2.500",
    status: "accepted",
    lockAssetCode: "ETH",
    lockAmount: "2.500",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  const settlementCommands: Array<{ quantity: string; price: string }> = [];
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "ETH-USDT",
          baseAsset: "ETH",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "160.00",
          feeRate: "0.001",
          timeInForce: "ioc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade(command) {
        settlementCommands.push({
          quantity: command.quantity,
          price: command.price
        });
        return {
          settlementId: "settlement-eth-1"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "cancelled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-eth-1",
              takerOrderId: command.orderId,
              price: "3200.00",
              quantity: "0.050000000000000003",
              executedAt: "2026-03-08T11:20:00.000Z",
              executionId: "exec-maker-eth-1-1",
              executionBatchId: `ETH-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "ETH-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "2.449999999999999997"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    }
  );

  const order = await service.createOrder({
    userId: "buyer-eth-1",
    accountId: "acct-buyer-eth-1",
    market: "ETH-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "ioc",
    price: "3200.00",
    quantity: "0.05",
    idempotencyKey: "order:precision-noise"
  });

  const trades = await service.listTrades({
    userId: "buyer-eth-1"
  });
  const makerOrder = await service.getOrder("maker-eth-1");

  assert.equal(order.status, "filled");
  assert.equal(order.filledQuantity, "0.05");
  assert.equal(trades[0]?.quantity, "0.05");
  assert.equal(makerOrder?.restingQuantity, "2.45");
  assert.deepEqual(settlementCommands, [{ quantity: "0.05", price: "3200" }]);
});

test("matched orders enter recovery queue and can be recovered later", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-r",
    idempotencyKey: "maker-r",
    traceId: "maker-r-trace",
    userId: "seller-r",
    accountId: "acct-seller-r",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  let settlementShouldFail = true;
  const settlementClient = {
    async settleTrade() {
      if (settlementShouldFail) {
        throw new Error("temporary settlement outage");
      }

      return {
        settlementId: "settlement-recovered-1"
      };
    }
  };
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    settlementClient,
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "filled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-r",
              takerOrderId: command.orderId,
              price: "65000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:30:00.000Z",
              executionId: "exec-maker-r-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    },
    {
      now: () => new Date("2026-03-08T11:30:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `recovery-${++counter}`;
      })()
    }
  );

  const order = await service.createOrder({
    userId: "buyer-r",
    accountId: "acct-buyer-r",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    idempotencyKey: "order:recovery"
  });

  assert.equal(order.status, "recovery_pending");

  const jobs = await service.listRecoveryJobs({
    status: "pending",
    limit: 10,
    offset: 0
  });
  assert.equal(jobs.length, 1);

  settlementShouldFail = false;
  const recovered = await service.recoverOrder(jobs[0]!.jobId);
  const finalOrder = await service.getOrder(order.orderId);
  const trades = await service.listTrades({ userId: "buyer-r" });

  assert.equal(recovered.status, "completed");
  assert.equal(finalOrder?.status, "filled");
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.settlementId, "settlement-recovered-1");
});

test("recovery jobs enter terminal failed state after max attempts", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-rf",
    idempotencyKey: "maker-rf",
    traceId: "maker-rf-trace",
    userId: "seller-rf",
    accountId: "acct-seller-rf",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade() {
        throw new Error("settlement still unavailable");
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "filled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-rf",
              takerOrderId: command.orderId,
              price: "65000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:35:00.000Z",
              executionId: "exec-maker-rf-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    },
    {
      now: (() => {
        let offset = 0;
        return () => new Date(Date.parse("2026-03-08T11:35:00.000Z") + offset++ * 10_000);
      })(),
      createId: (() => {
        let counter = 0;
        return () => `recovery-failed-${++counter}`;
      })(),
      recoveryDelayMs: 0,
      recoveryMaxAttempts: 2
    }
  );

  const order = await service.createOrder({
    userId: "buyer-rf",
    accountId: "acct-buyer-rf",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    idempotencyKey: "order:recovery-failed"
  });

  assert.equal(order.status, "recovery_pending");

  const firstPass = await service.recoverPendingOrders(10);
  assert.equal(firstPass.processedCount, 1);

  const jobs = await service.listRecoveryJobs({
    orderId: order.orderId,
    limit: 10,
    offset: 0
  });
  const finalOrder = await service.getOrder(order.orderId);

  assert.equal(jobs[0]?.status, "failed");
  assert.equal(jobs[0]?.attemptCount, 2);
  assert.ok(jobs[0]?.deadLetteredAt);
  assert.match(finalOrder?.rejectedReason ?? "", /^recovery_failed:/);
});

test("dead-lettered recovery jobs can be manually recovered later", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-rd",
    idempotencyKey: "maker-rd",
    traceId: "maker-rd-trace",
    userId: "seller-rd",
    accountId: "acct-seller-rd",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    filledQuantity: "0",
    restingQuantity: "0.01",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "0.01",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });

  let shouldFail = true;
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade() {
        if (shouldFail) {
          throw new Error("settlement outage");
        }

        return {
          settlementId: "settlement-recovered-dead-letter"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "matched",
          orderId: command.orderId,
          takerStatus: "filled",
          takerRemainingQuantity: "0",
          trades: [
            {
              makerOrderId: "maker-rd",
              takerOrderId: command.orderId,
              price: "65000",
              quantity: "0.01",
              executedAt: "2026-03-08T11:40:00.000Z",
              executionId: "exec-maker-rd-1",
              executionBatchId: `BTC-USDT:${command.orderId}:batch`,
              executionSequence: 1,
              executionBatchSequence: 1,
              replayCursor: "BTC-USDT:1",
              protocolVersion: "v2",
              makerRemainingQuantity: "0"
            }
          ]
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    },
    {
      now: (() => {
        let offset = 0;
        return () => new Date(Date.parse("2026-03-08T11:40:00.000Z") + offset++ * 10_000);
      })(),
      createId: (() => {
        let counter = 0;
        return () => `recovery-dead-letter-${++counter}`;
      })(),
      recoveryDelayMs: 0,
      recoveryMaxAttempts: 2
    }
  );

  const order = await service.createOrder({
    userId: "buyer-rd",
    accountId: "acct-buyer-rd",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01",
    idempotencyKey: "order:recovery-dead-letter"
  });

  await service.recoverPendingOrders(10, "worker-1");
  let jobs = await service.listRecoveryJobs({
    orderId: order.orderId,
    limit: 10,
    offset: 0
  });
  assert.equal(jobs[0]?.status, "failed");
  assert.ok(jobs[0]?.deadLetteredAt);

  shouldFail = false;
  const recoveredJob = await service.recoverOrder(jobs[0]!.jobId, "manual-1");
  const finalOrder = await service.getOrder(order.orderId);
  const trades = await service.listTrades({ userId: "buyer-rd" });

  jobs = await service.listRecoveryJobs({
    orderId: order.orderId,
    limit: 10,
    offset: 0
  });

  assert.equal(recoveredJob.status, "completed");
  assert.equal(finalOrder?.status, "filled");
  assert.equal(trades[0]?.settlementId, "settlement-recovered-dead-letter");
  assert.equal(jobs[0]?.deadLetteredAt, undefined);
});

test("market order without liquidity is rejected and lock is released", async () => {
  const releases: string[] = [];
  const service = new OrderApplicationService(
    new InMemoryOrderRepository(),
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "780",
          feeRate: "0.001",
          timeInForce: "ioc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance(command) {
        releases.push(command.referenceId);
        return {};
      }
    },
    {
      async settleTrade() {
        return {
          settlementId: "unused"
        };
      }
    },
    {
      async submitOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId,
          takerStatus: "cancelled",
          takerRemainingQuantity: "0",
          reason: "no_executable_liquidity",
          trades: []
        };
      },
      async seedOrder(command) {
        return {
          outcome: "seeded",
          orderId: command.orderId
        };
      },
      async cancelOrder(command) {
        return {
          outcome: "cancelled",
          orderId: command.orderId
        };
      },
      async resetBook(command) {
        return {
          outcome: "reset",
          market: command.market
        };
      },
      async getBookSnapshot(command) {
        return {
          market: command.market,
          bids: [],
          asks: []
        };
      }
    }
  );

  const order = await service.createOrder({
    userId: "buyer-3",
    accountId: "acct-buyer-3",
    market: "BTC-USDT",
    side: "buy",
    type: "market",
    quantity: "0.01",
    idempotencyKey: "order:4"
  });

  assert.equal(order.status, "rejected");
  assert.equal(releases.length, 1);
});

test("cancelOrder releases only the lock backing the quantity removed from the book", async () => {
  const releases: Array<{ referenceId: string; amount?: string }> = [];
  let engineCancelledQuantity: string | undefined = "0.004";
  const service = new OrderApplicationService(
    new InMemoryOrderRepository(),
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "650",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance(command) {
        releases.push({ referenceId: command.referenceId, amount: command.amount });
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
        return { outcome: "resting", orderId: command.orderId, trades: [] };
      },
      async seedOrder(command) {
        return { outcome: "seeded", orderId: command.orderId };
      },
      async cancelOrder(command) {
        // 0.006 of the 0.01 order was already matched inside the engine but its
        // async settlement has not consumed the lock yet.
        return { outcome: "cancelled", orderId: command.orderId, cancelledQuantity: engineCancelledQuantity };
      },
      async resetBook(command) {
        return { outcome: "reset", market: command.market };
      },
      async getBookSnapshot(command) {
        return { market: command.market, bids: [], asks: [] };
      }
    },
    {
      now: () => new Date("2026-03-08T11:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `cancel-${++counter}`;
      })()
    }
  );

  const createOrder = (idempotencyKey: string) =>
    service.createOrder({
      userId: "user-1",
      accountId: "acct-1",
      market: "BTC-USDT",
      side: "buy",
      type: "limit",
      timeInForce: "gtc",
      price: "65000",
      quantity: "0.01",
      idempotencyKey
    });

  const first = await createOrder("order:cancel-1");
  const cancelled = await service.cancelOrder({ orderId: first.orderId, userId: "user-1" });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(releases[0], { referenceId: first.orderId, amount: "260" });

  // Older engines do not report the cancelled quantity: fall back to the stored resting quantity.
  engineCancelledQuantity = undefined;
  const second = await createOrder("order:cancel-2");
  await service.cancelOrder({ orderId: second.orderId, userId: "user-1" });
  assert.deepEqual(releases[1], { referenceId: second.orderId, amount: "650" });
});

test("syncEngineState restores sequences and replays the book when the engine restarted", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveTrade({
    tradeId: "trade-1",
    market: "ETH-USDT",
    price: "3000",
    quantity: "1",
    makerOrderId: "m",
    takerOrderId: "t",
    buyerOrderId: "t",
    sellerOrderId: "m",
    buyerUserId: "u1",
    sellerUserId: "u2",
    buyerAccountId: "a1",
    sellerAccountId: "a2",
    sellerFeeRate: "0.001",
    executionId: "ETH-USDT:9:1",
    executionBatchId: "ETH-USDT:9",
    executionSequence: 12,
    executionBatchSequence: 1,
    replayCursor: "ETH-USDT:12",
    protocolVersion: "v2",
    executedAt: "2026-03-08T00:00:00.000Z"
  } as Parameters<InMemoryOrderRepository["saveTrade"]>[0]);

  const calls: string[] = [];
  let engineNext = 1;
  const engine = {
    async getBookSnapshot() {
      return { market: "ETH-USDT" as const, bids: [], asks: [], nextExecutionSequence: engineNext, nextBatchSequence: 1 };
    },
    async restoreSequences(command: { nextExecutionSequence: number; nextBatchSequence: number }) {
      calls.push(`restore:${command.nextExecutionSequence}:${command.nextBatchSequence}`);
      engineNext = command.nextExecutionSequence;
      return command;
    },
    async resetBook() {
      calls.push("reset");
      return { outcome: "reset" as const, market: "ETH-USDT" as const };
    },
    async seedOrder() {
      throw new Error("no open orders expected");
    }
  } as unknown as MatchingEngineClient;
  const ops = new OrderOpsService(repository, engine);

  const first = await ops.syncEngineState("ETH-USDT");
  assert.equal(first.restored, true);
  assert.deepEqual(calls, ["restore:13:10", "reset"]);

  const second = await ops.syncEngineState("ETH-USDT");
  assert.equal(second.restored, false);
  assert.equal(calls.length, 2);
});

test("injectEngineReset empties the book; only a sequence reset is healed by syncEngineState", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "order-open-1",
    idempotencyKey: "order-open-1",
    traceId: "trace-open-1",
    userId: "user-1",
    accountId: "acct-1",
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
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z"
  });
  // A persisted trade gives the DB execution cursor (4) that a restarted engine falls behind.
  await repository.saveTrade({
    tradeId: "trade-1",
    market: "ETH-USDT",
    price: "3000",
    quantity: "1",
    makerOrderId: "m",
    takerOrderId: "t",
    buyerOrderId: "t",
    sellerOrderId: "m",
    buyerUserId: "u1",
    sellerUserId: "u2",
    buyerAccountId: "a1",
    sellerAccountId: "a2",
    sellerFeeRate: "0.001",
    executionId: "ETH-USDT:4:1",
    executionBatchId: "ETH-USDT:4",
    executionSequence: 4,
    executionBatchSequence: 4,
    replayCursor: "ETH-USDT:4",
    protocolVersion: "v2",
    executedAt: "2026-03-08T00:00:00.000Z"
  } as Parameters<InMemoryOrderRepository["saveTrade"]>[0]);

  type BookOrder = { orderId: string; side: "buy" | "sell"; price: string; quantity: string };
  let book: BookOrder[] = [{ orderId: "order-open-1", side: "buy", price: "3000", quantity: "1" }];
  let engineNext = 5;
  const resets: Array<{ resetSequences?: boolean }> = [];
  const engine = {
    async getBookSnapshot() {
      return {
        market: "ETH-USDT" as const,
        bids: book.filter((order) => order.side === "buy"),
        asks: book.filter((order) => order.side === "sell"),
        nextExecutionSequence: engineNext,
        nextBatchSequence: engineNext
      };
    },
    async restoreSequences(command: { nextExecutionSequence: number; nextBatchSequence: number }) {
      engineNext = command.nextExecutionSequence;
      return command;
    },
    async resetBook(command: { resetSequences?: boolean }) {
      resets.push({ resetSequences: command.resetSequences });
      book = [];
      if (command.resetSequences) {
        engineNext = 1;
      }
      return { outcome: "reset" as const, market: "ETH-USDT" as const };
    },
    async seedOrder(command: BookOrder) {
      book.push({ orderId: command.orderId, side: command.side, price: command.price, quantity: command.quantity });
      return { outcome: "seeded" as const, orderId: command.orderId };
    }
  } as unknown as MatchingEngineClient;
  const ops = new OrderOpsService(repository, engine);

  // Book-only reset: sequences survive, so automatic sync does not notice.
  const bookOnly = await ops.injectEngineReset("ETH-USDT");
  assert.equal(bookOnly.droppedBookOrderCount, 1);
  assert.equal(bookOnly.anomalyCountAfter, 1);
  assert.equal(bookOnly.healsAutomatically, false);
  assert.equal(resets[0]?.resetSequences, false);
  assert.equal((await ops.syncEngineState("ETH-USDT")).restored, false);
  assert.equal((await ops.getAnomalies("ETH-USDT"))[0]?.type, "engine_missing_open_order");
  const replay = await ops.replayEngineBook("ETH-USDT");
  assert.deepEqual(replay.replayedOrderIds, ["order-open-1"]);
  assert.equal((await ops.getAnomalies("ETH-USDT")).length, 0);

  // Restart-like reset: counters fall behind the DB cursor, sync restores + replays.
  const restart = await ops.injectEngineReset("ETH-USDT", { resetSequences: true });
  assert.equal(restart.healsAutomatically, true);
  assert.equal(restart.anomalyCountAfter, 1);
  const synced = await ops.syncEngineState("ETH-USDT");
  assert.equal(synced.restored, true);
  assert.equal(synced.replayedOrderCount, 1);
  assert.equal((await ops.getAnomalies("ETH-USDT")).length, 0);
});
