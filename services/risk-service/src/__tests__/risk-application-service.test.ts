import assert from "node:assert/strict";
import test from "node:test";

import { RiskApplicationService } from "../application/risk-application-service.js";
import { RiskServiceError } from "../domain/errors.js";

test("risk validation calculates quote lock for buy orders", async () => {
  const service = new RiskApplicationService({
    async getBalance() {
      return {
        accountId: "acct-1",
        assetCode: "USDT",
        available: "100000",
        locked: "0"
      };
    }
  });

  const result = await service.validateSpotOrder({
    userId: "user-1",
    accountId: "acct-1",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "65000",
    quantity: "0.01"
  });

  assert.equal(result.lockAssetCode, "USDT");
  assert.equal(result.lockAmount, "650");
  assert.equal(result.checks.length >= 4, true);
});

test("risk validation rejects insufficient available balance", async () => {
  const service = new RiskApplicationService({
    async getBalance() {
      return {
        accountId: "acct-1",
        assetCode: "BTC",
        available: "0.1",
        locked: "0"
      };
    }
  });

  await assert.rejects(
    () =>
      service.validateSpotOrder({
        userId: "user-1",
        accountId: "acct-1",
        market: "BTC-USDT",
        side: "sell",
        type: "limit",
        timeInForce: "gtc",
        price: "65000",
        quantity: "0.2"
      }),
    (error: unknown) =>
      error instanceof RiskServiceError &&
      error.code === "INSUFFICIENT_AVAILABLE_BALANCE"
  );
});

function ledgerWith(available: string) {
  return {
    async getBalance(accountId: string, assetCode: string) {
      return { accountId, assetCode: assetCode as "USDT", available, locked: "0" };
    }
  };
}

const baseOrder = {
  userId: "user-1",
  accountId: "acct-1",
  market: "ETH-USDT" as const,
  side: "buy" as const,
  type: "limit" as const,
  timeInForce: "gtc" as const,
  quantity: "0.1"
};

test("price deviation guard follows the live market price, not the configured one", async () => {
  // Market moved from the configured 3200 to 4000.
  const service = new RiskApplicationService(ledgerWith("1000000"), {
    referencePrices: { "ETH-USDT": "3200" },
    referencePriceProvider: {
      async getReferencePrice() {
        return { price: "4000", source: "last_trade" as const };
      }
    }
  });

  // 4100 is 28% above the stale configured price but only 2.5% above the market.
  const accepted = await service.validateSpotOrder({ ...baseOrder, price: "4100" });
  assert.equal(accepted.referencePrice, "4000");
  assert.equal(accepted.referencePriceSource, "last_trade");

  // 3100 is within 20% of the configured price but 22.5% below the market.
  await assert.rejects(service.validateSpotOrder({ ...baseOrder, price: "3100" }), (error: unknown) => {
    assert.ok(error instanceof RiskServiceError);
    assert.equal(error.code, "PRICE_DEVIATION_TOO_HIGH");
    assert.match(error.message, /reference 4000 from last_trade/);
    return true;
  });
});

test("reference price falls back to the configured value without live data", async () => {
  const service = new RiskApplicationService(ledgerWith("1000000"), {
    referencePrices: { "ETH-USDT": "3200" },
    referencePriceProvider: {
      async getReferencePrice() {
        return null;
      }
    }
  });
  const decision = await service.validateSpotOrder({ ...baseOrder, price: "3300" });
  assert.equal(decision.referencePriceSource, "configured");

  // Market buys lock reference * (1 + max deviation) using the same resolution.
  const marketBuy = await service.validateSpotOrder({ ...baseOrder, type: "market", timeInForce: "ioc", price: undefined });
  assert.equal(marketBuy.lockAmount, "384");
});
