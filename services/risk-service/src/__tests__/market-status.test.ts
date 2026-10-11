import assert from "node:assert/strict";
import test from "node:test";

import { MARKET_CONFIG, createMarketCatalog, parseMarketConfig } from "@web3-cex/domain";

import { MarketStatusService } from "../application/market-status-service.js";
import {
  RiskApplicationService,
  buildConfiguredReferencePrices
} from "../application/risk-application-service.js";
import { RiskServiceError } from "../domain/errors.js";
import { InMemoryMarketStatusRepository } from "../infrastructure/in-memory-market-status-repository.js";

function ledgerWith(available: string) {
  return {
    async getBalance(accountId: string, assetCode: string) {
      return { accountId, assetCode, available, locked: "0" };
    }
  };
}

const solOrder = {
  userId: "user-1",
  accountId: "acct-1",
  market: "SOL-USDT",
  side: "buy" as const,
  type: "limit" as const,
  timeInForce: "gtc" as const,
  price: "150",
  quantity: "1"
};

function newService(repository = new InMemoryMarketStatusRepository()) {
  const marketStatus = new MarketStatusService({ repository, cacheMs: 0 });
  const service = new RiskApplicationService(ledgerWith("1000000"), {
    marketStatus,
    referencePriceProvider: { async getReferencePrice() { return null; } }
  });
  return { service, marketStatus, repository };
}

function isRiskError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RiskServiceError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

test("SOL-USDT from config/markets.json is tradable with its configured rules", async () => {
  const { service } = newService();
  const decision = await service.validateSpotOrder(solOrder);
  assert.equal(decision.baseAsset, "SOL");
  assert.equal(decision.quoteAsset, "USDT");
  assert.equal(decision.lockAssetCode, "USDT");
  assert.equal(decision.lockAmount, "150");
  assert.equal(decision.referencePriceSource, "configured");
  assert.equal(decision.referencePrice, "150");
});

test("halting a market rejects new orders with MARKET_HALTED; resuming re-opens it", async () => {
  const { service, marketStatus, repository } = newService();

  const halted = await marketStatus.setStatus({
    market: "SOL-USDT",
    status: "halted",
    reason: "chain incident drill",
    operator: "ops-admin@example.com"
  });
  assert.equal(halted.status, "halted");
  assert.equal(halted.configuredStatus, "listed");
  assert.equal(halted.override?.reason, "chain incident drill");
  assert.equal(halted.override?.updatedBy, "ops-admin@example.com");
  assert.equal((await repository.list()).length, 1);

  await assert.rejects(service.validateSpotOrder(solOrder), (error: unknown) => {
    isRiskError("MARKET_HALTED")(error);
    assert.equal((error as RiskServiceError).statusCode, 409);
    assert.match((error as Error).message, /chain incident drill/);
    assert.match((error as Error).message, /cancels are still allowed/);
    return true;
  });
  // Sells too: a halt blocks both sides.
  await assert.rejects(service.validateSpotOrder({ ...solOrder, side: "sell" }), isRiskError("MARKET_HALTED"));
  // Other markets keep trading.
  await service.validateSpotOrder({ ...solOrder, market: "ETH-USDT", price: "3200", quantity: "0.1" });

  const resumed = await marketStatus.setStatus({ market: "SOL-USDT", status: "listed", operator: "ops" });
  assert.equal(resumed.status, "listed");
  // Resuming to the configured default drops the override instead of storing "listed".
  assert.equal(resumed.override, null);
  assert.equal((await repository.list()).length, 0);
  const decision = await service.validateSpotOrder(solOrder);
  assert.equal(decision.valid, true);
});

test("halting requires a reason, an existing market and a listed/halted status", async () => {
  const { marketStatus } = newService();
  await assert.rejects(
    marketStatus.setStatus({ market: "SOL-USDT", status: "halted", reason: "  " }),
    isRiskError("MARKET_STATUS_REASON_REQUIRED")
  );
  await assert.rejects(
    marketStatus.setStatus({ market: "DOGE-USDT", status: "halted", reason: "x" }),
    isRiskError("UNSUPPORTED_MARKET")
  );
  await assert.rejects(
    marketStatus.setStatus({ market: "SOL-USDT", status: "delisted" as never }),
    isRiskError("INVALID_MARKET_STATUS")
  );
});

test("status overrides are shared through the repository (another risk instance sees the halt)", async () => {
  const repository = new InMemoryMarketStatusRepository();
  const writer = newService(repository);
  const reader = newService(repository);
  await writer.marketStatus.setStatus({ market: "BTC-USDT", status: "halted", reason: "maintenance" });
  await assert.rejects(
    reader.service.validateSpotOrder({ ...solOrder, market: "BTC-USDT", price: "65000", quantity: "0.01" }),
    isRiskError("MARKET_HALTED")
  );
  const views = await reader.marketStatus.listMarkets();
  assert.deepEqual(
    views.map((view) => [view.market, view.status]),
    MARKET_CONFIG.markets.map((market) => [market.market, market.market === "BTC-USDT" ? "halted" : market.status])
  );
});

test("config defaults: a halted market can be resumed at runtime, a delisted one cannot", async () => {
  const raw = {
    version: 1,
    defaultMarket: "AAA-USDT",
    assets: [
      { code: "USDT", name: "Tether", decimals: 6, networks: ["ethereum"] },
      { code: "AAA", name: "A", decimals: 8, networks: ["ethereum"] },
      { code: "BBB", name: "B", decimals: 8, networks: ["ethereum"] },
      { code: "CCC", name: "C", decimals: 8, networks: ["ethereum"] }
    ],
    markets: ["AAA", "BBB", "CCC"].map((base, index) => ({
      symbol: `${base}-USDT`,
      baseAsset: base,
      quoteAsset: "USDT",
      status: ["listed", "halted", "delisted"][index],
      priceStep: "0.01",
      quantityStep: "0.01",
      minQuantity: "0.01",
      makerFeeRate: "0.001",
      takerFeeRate: "0.001",
      maxPriceDeviationRatio: "0.2",
      referencePrice: "10"
    }))
  };
  const catalog = createMarketCatalog(parseMarketConfig(raw));
  const repository = new InMemoryMarketStatusRepository();
  const marketStatus = new MarketStatusService({ catalog, repository, cacheMs: 0 });
  const service = new RiskApplicationService(ledgerWith("1000"), { catalog, marketStatus });
  const order = { ...solOrder, price: "10", quantity: "1" };

  await service.validateSpotOrder({ ...order, market: "AAA-USDT" });
  await assert.rejects(service.validateSpotOrder({ ...order, market: "BBB-USDT" }), isRiskError("MARKET_HALTED"));
  await assert.rejects(service.validateSpotOrder({ ...order, market: "CCC-USDT" }), isRiskError("MARKET_DELISTED"));

  // The file says halted; ops resume stores a "listed" override.
  const resumed = await marketStatus.setStatus({ market: "BBB-USDT", status: "listed", operator: "ops" });
  assert.equal(resumed.configuredStatus, "halted");
  assert.equal(resumed.override?.status, "listed");
  await service.validateSpotOrder({ ...order, market: "BBB-USDT" });

  await assert.rejects(
    marketStatus.setStatus({ market: "CCC-USDT", status: "listed" }),
    isRiskError("MARKET_DELISTED")
  );
});

test("configured reference prices come from config with RISK_REFERENCE_PRICE_<BASE>_<QUOTE> overrides", () => {
  const prices = buildConfiguredReferencePrices(undefined, { RISK_REFERENCE_PRICE_SOL_USDT: "175" });
  assert.equal(prices["SOL-USDT"], "175");
  assert.equal(prices["ETH-USDT"], MARKET_CONFIG.markets.find((m) => m.market === "ETH-USDT")?.referencePrice);
  assert.deepEqual(Object.keys(prices), MARKET_CONFIG.markets.map((market) => market.market));
});
