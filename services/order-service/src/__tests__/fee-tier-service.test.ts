import assert from "node:assert/strict";
import test from "node:test";

import { parseFeeTierConfig } from "@web3-cex/domain";

import { FeeTierService } from "../application/fee-tier-service.js";
import { OrderApplicationService } from "../application/order-application-service.js";
import type { MatchingEngineClient } from "../domain/clients.js";
import type { SpotTradeRecord } from "../domain/types.js";
import { InMemoryFeeTierRepository } from "../infrastructure/in-memory-fee-tier-repository.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

const NOW = new Date("2026-03-08T11:00:00.000Z");

const config = parseFeeTierConfig({
  version: 1,
  volumeAsset: "USDT",
  volumeWindowDays: 30,
  tiers: [
    { tier: "VIP0", minVolume: "0", makerFeeRate: "0.0005", takerFeeRate: "0.001" },
    { tier: "VIP1", minVolume: "100000", makerFeeRate: "0.0004", takerFeeRate: "0.0009" },
    { tier: "VIP2", minVolume: "500000", makerFeeRate: "0.0003", takerFeeRate: "0.0008" }
  ],
  marketMakers: [{ userId: "mm-1", label: "做市商", feeTier: "VIP0" }]
});

function historicTrade(overrides: Partial<SpotTradeRecord>): SpotTradeRecord {
  return {
    tradeId: `t-${Math.random()}`,
    market: "BTC-USDT",
    price: "65000",
    quantity: "1",
    makerOrderId: "m",
    takerOrderId: "t",
    buyerOrderId: "b",
    sellerOrderId: "s",
    buyerUserId: "other",
    sellerUserId: "other",
    buyerAccountId: "a",
    sellerAccountId: "a",
    sellerFeeRate: "0.001",
    buyerFeeRate: "0.001",
    executionId: "e",
    executionBatchId: "eb",
    executionSequence: 1,
    executionBatchSequence: 1,
    replayCursor: "r",
    protocolVersion: "v2",
    settlementId: "s",
    executedAt: "2026-03-01T00:00:00.000Z",
    ...overrides
  };
}

test("volume over the trailing window resolves the tier; older trades do not count", async () => {
  const trades = [
    historicTrade({ buyerUserId: "alice" }), // 65 000
    historicTrade({ sellerUserId: "alice", quantity: "0.6" }), // 39 000
    historicTrade({ buyerUserId: "alice", executedAt: "2026-01-01T00:00:00.000Z" }) // outside 30d
  ];
  const service = new FeeTierService(new InMemoryFeeTierRepository(async () => trades), {
    config,
    now: () => NOW
  });
  const tier = await service.resolve("alice");
  assert.equal(tier.volume, "104000");
  assert.equal(tier.tier, "VIP1");
  assert.equal(tier.source, "volume");
  const profile = await service.getProfile("alice");
  assert.equal(profile.nextTier?.tier, "VIP2");
  assert.equal(profile.remainingVolume, "396000");
  assert.equal(profile.markets.find((market) => market.market === "BTC-USDT")?.takerFeeRate, "0.0009");
});

test("overrides are validated, audited and invalidate the cache", async () => {
  const service = new FeeTierService(new InMemoryFeeTierRepository(), { config, now: () => NOW, cacheMs: 60_000 });
  assert.equal((await service.resolve("bob")).tier, "VIP0");
  await assert.rejects(() => service.setOverride({ userId: "bob", tier: "VIP9", note: "x", actor: "ops" }), /FEE_TIER_UNKNOWN|not configured/);
  await assert.rejects(() => service.setOverride({ userId: "bob", tier: "VIP2", actor: "ops" }), /note is required/);

  const profile = await service.setOverride({ userId: "bob", tier: "VIP2", note: "做市商计划", actor: "ops@example.com" });
  assert.equal(profile.tier, "VIP2");
  assert.equal(profile.source, "override");
  assert.equal((await service.resolve("bob")).tier, "VIP2", "cache was invalidated");

  const cleared = await service.clearOverride({ userId: "bob", note: "计划结束", actor: "ops@example.com" });
  assert.equal(cleared.tier, "VIP0");
  const audit = await service.listAudit({ userId: "bob" });
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.previousTier ?? null, entry.tier ?? null]),
    [
      ["clear", "VIP2", null],
      ["set", null, "VIP2"]
    ]
  );
});

test("market-maker programme members keep their pinned tier", async () => {
  const trades = [historicTrade({ buyerUserId: "mm-1", quantity: "100" })];
  const service = new FeeTierService(new InMemoryFeeTierRepository(async () => trades), { config, now: () => NOW });
  const tier = await service.resolve("mm-1");
  assert.equal(tier.tier, "VIP0");
  assert.equal(tier.source, "programme");
  assert.equal((await service.getProfile("mm-1")).marketMaker?.label, "做市商");
});

function matchingEngine(): MatchingEngineClient {
  return {
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
            quantity: "2",
            executedAt: NOW.toISOString(),
            executionId: "exec-1",
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
  };
}

test("fills use each side's resolved tier rate and record the tier on the trade", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-1",
    idempotencyKey: "maker",
    traceId: "maker-trace",
    userId: "seller-vip2",
    accountId: "acct-seller",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "2",
    filledQuantity: "0",
    restingQuantity: "2",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "2",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z"
  });
  const feeTiers = new FeeTierService(new InMemoryFeeTierRepository(), { config, now: () => NOW });
  await feeTiers.setOverride({ userId: "seller-vip2", tier: "VIP2", note: "test", actor: "ops" });
  const settled: Array<Record<string, unknown>> = [];

  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "130000",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    { async freezeBalance() { return {}; }, async releaseBalance() { return {}; } },
    {
      async settleTrade(command) {
        settled.push(command);
        return { settlementId: "settlement-1" };
      }
    },
    matchingEngine(),
    { now: () => NOW, feeTierResolver: feeTiers }
  );

  await service.createOrder({
    userId: "buyer-vip0",
    accountId: "acct-buyer",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "2",
    idempotencyKey: "order:tier"
  });

  const [trade] = await service.listTrades({ userId: "buyer-vip0" });
  // Buyer is the taker at VIP0 (= market default), seller the maker at VIP2.
  assert.equal(trade?.buyerFeeRate, "0.001");
  assert.equal(trade?.buyerFeeTier, "VIP0");
  assert.equal(trade?.sellerFeeRate, "0.0003");
  assert.equal(trade?.sellerFeeTier, "VIP2");
  assert.equal(settled[0]?.sellerFeeRate, "0.0003");
  assert.equal(settled[0]?.sellerFeeTier, "VIP2");
});

test("a failing tier resolver falls back to market default rates", async () => {
  const repository = new InMemoryOrderRepository();
  await repository.saveOrder({
    orderId: "maker-1",
    idempotencyKey: "maker",
    traceId: "maker-trace",
    userId: "seller",
    accountId: "acct-seller",
    market: "BTC-USDT",
    side: "sell",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "2",
    filledQuantity: "0",
    restingQuantity: "2",
    status: "accepted",
    lockAssetCode: "BTC",
    lockAmount: "2",
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
          lockAmount: "130000",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    { async freezeBalance() { return {}; }, async releaseBalance() { return {}; } },
    { async settleTrade() { return { settlementId: "settlement-1" }; } },
    matchingEngine(),
    {
      now: () => NOW,
      feeTierResolver: {
        async resolveMany() {
          throw new Error("db down");
        }
      }
    }
  );
  const order = await service.createOrder({
    userId: "buyer",
    accountId: "acct-buyer",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "2",
    idempotencyKey: "order:fallback"
  });
  assert.equal(order.status, "filled");
  const [trade] = await service.listTrades({ userId: "buyer" });
  assert.equal(trade?.sellerFeeRate, "0.0005");
  assert.equal(trade?.sellerFeeTier, undefined);
});
