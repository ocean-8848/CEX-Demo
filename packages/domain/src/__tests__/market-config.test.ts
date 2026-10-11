import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ASSET_DEFINITIONS,
  DEFAULT_SPOT_MARKET,
  MARKET_CONFIG,
  MarketConfigError,
  SPOT_MARKET_DEFINITIONS,
  createMarketCatalog,
  getSpotMarketDefinition,
  isAssetCode,
  isSpotMarket,
  listAssetCodes,
  listSpotMarkets,
  loadMarketConfig,
  parseMarketConfig,
  referencePriceEnvKey,
  resolveMarketConfigPath
} from "../index.js";

function rawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveMarketConfigPath(), "utf8")) as Record<string, unknown>;
}

function expectIssue(raw: unknown, pattern: RegExp) {
  assert.throws(
    () => parseMarketConfig(raw),
    (error: unknown) => {
      assert.ok(error instanceof MarketConfigError);
      assert.ok(
        error.issues.some((issue) => pattern.test(issue)),
        `expected an issue matching ${pattern}, got:\n${error.issues.join("\n")}`
      );
      return true;
    }
  );
}

test("config/markets.json is the single source of truth for markets and assets", () => {
  const raw = rawConfig() as { markets: Array<{ symbol: string }>; assets: Array<{ code: string }>; defaultMarket: string };
  assert.deepEqual(listSpotMarkets({ includeDelisted: true }), raw.markets.map((market) => market.symbol));
  assert.deepEqual(Object.keys(SPOT_MARKET_DEFINITIONS), raw.markets.map((market) => market.symbol));
  assert.deepEqual(listAssetCodes(), raw.assets.map((asset) => asset.code));
  assert.deepEqual(Object.keys(ASSET_DEFINITIONS), raw.assets.map((asset) => asset.code));
  assert.equal(DEFAULT_SPOT_MARKET, raw.defaultMarket);
  assert.equal(MARKET_CONFIG.sourcePath, resolveMarketConfigPath());
});

test("SOL-USDT and SOL are configured", () => {
  const sol = getSpotMarketDefinition("SOL-USDT");
  assert.ok(sol);
  assert.equal(sol.baseAsset, "SOL");
  assert.equal(sol.quoteAsset, "USDT");
  assert.equal(sol.status, "listed");
  assert.equal(sol.simulator.enabled, true);
  assert.ok(isAssetCode("SOL"));
  assert.ok(ASSET_DEFINITIONS.SOL?.demo?.faucetMaxAmount);
});

test("lookups are runtime-validated and immune to prototype keys", () => {
  assert.equal(isSpotMarket("ETH-USDT"), true);
  assert.equal(isSpotMarket("DOGE-USDT"), false);
  assert.equal(isSpotMarket("constructor"), false);
  assert.equal("toString" in SPOT_MARKET_DEFINITIONS, false);
  assert.equal(getSpotMarketDefinition("__proto__"), undefined);
  assert.equal(isAssetCode(undefined), false);
  assert.equal(referencePriceEnvKey("SOL-USDT"), "RISK_REFERENCE_PRICE_SOL_USDT");
});

test("delisted markets are hidden from default listings but still resolvable", () => {
  const raw = rawConfig() as { markets: Array<Record<string, unknown>> };
  raw.markets = raw.markets.map((market) =>
    market.symbol === "BTC-USDT" ? { ...market, status: "delisted" } : market
  );
  const catalog = createMarketCatalog(parseMarketConfig(raw));
  assert.equal(catalog.listMarkets().includes("BTC-USDT"), false);
  assert.equal(catalog.listMarkets({ includeDelisted: true }).includes("BTC-USDT"), true);
  assert.equal(catalog.getMarket("BTC-USDT")?.status, "delisted");
});

test("validator rejects broken configs with readable issues", () => {
  const base = rawConfig() as { markets: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> };
  const market = (patch: Record<string, unknown>) => ({
    ...base,
    markets: [{ ...base.markets[0], ...patch }, ...base.markets.slice(1)]
  });

  expectIssue({ ...base, version: 2 }, /version must be 1/);
  expectIssue(market({ baseAsset: "DOGE", symbol: "DOGE-USDT" }), /DOGE is not a configured asset/);
  expectIssue(market({ symbol: "BTCUSDT" }), /must equal "<baseAsset>-<quoteAsset>"/);
  expectIssue(market({ status: "paused" }), /status must be one of listed, halted, delisted/);
  expectIssue(market({ priceStep: "-1" }), /priceStep must be a positive decimal/);
  expectIssue(market({ minQuantity: "0.00015" }), /minQuantity 0.00015 must align to quantityStep/);
  expectIssue(market({ takerFeeRate: "1.5" }), /takerFeeRate must be below 1/);
  expectIssue(market({ quantityStep: "0.000000001", minQuantity: "0.000000001" }), /more decimals than BTC/);
  expectIssue(market({ tickSize: "0.01" }), /unknown key tickSize/);
  expectIssue({ ...base, markets: [...base.markets, base.markets[0]] }, /symbol is duplicated/);
  expectIssue({ ...base, defaultMarket: "DOGE-USDT" }, /defaultMarket "DOGE-USDT" must be one of/);
  expectIssue(
    { ...base, assets: [...base.assets, { code: "XRP", name: "XRP", decimals: 6, networks: ["ripple"] }] },
    /unknown network "ripple"/
  );
  expectIssue(
    { ...base, assets: [...base.assets, { code: "usdt", name: "x", decimals: 6, networks: ["ethereum"] }] },
    /code "usdt" must match/
  );
});

test("WEB3_CEX_MARKETS_CONFIG points the loader at another file", () => {
  const config = loadMarketConfig({ env: { WEB3_CEX_MARKETS_CONFIG: resolveMarketConfigPath() } });
  assert.deepEqual(
    config.markets.map((market) => market.market),
    MARKET_CONFIG.markets.map((market) => market.market)
  );
  assert.throws(
    () => loadMarketConfig({ env: { WEB3_CEX_MARKETS_CONFIG: "/nonexistent/markets.json" } }),
    MarketConfigError
  );
});
