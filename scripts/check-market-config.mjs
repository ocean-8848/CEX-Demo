// M4-3 acceptance check: config/markets.json is the single source of truth.
//
// 1. Dynamic: loads the config and asserts that every service / BFF / script
//    market or asset list (from the built dist output) equals what the config
//    says - adding a market to the JSON shows up everywhere without code changes.
// 2. Static: scans non-test sources for hard-coded market symbols or asset
//    lists, so nobody re-introduces a private copy.
//
// Run after `pnpm build`:  pnpm check:markets

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (relative) => new URL(`../${relative}`, import.meta.url).href;

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const raw = JSON.parse(await readFile(path.join(rootDir, "config", "markets.json"), "utf8"));
const allMarkets = raw.markets.map((market) => market.symbol);
const activeMarkets = raw.markets.filter((market) => market.status !== "delisted").map((market) => market.symbol);
const allAssets = raw.assets.map((asset) => asset.code);

const domain = await import(fromRoot("packages/domain/dist/index.js"));

// ---------------------------------------------------------------------------
// 1. Dynamic: every consumer derives its list from the config
// ---------------------------------------------------------------------------

await check("domain: SPOT_MARKET_DEFINITIONS / assets / defaultMarket", () => {
  assert.deepEqual(Object.keys(domain.SPOT_MARKET_DEFINITIONS), allMarkets);
  assert.deepEqual(domain.listSpotMarkets(), activeMarkets);
  assert.deepEqual(domain.listAssetCodes(), allAssets);
  assert.equal(domain.DEFAULT_SPOT_MARKET, raw.defaultMarket);
  for (const market of raw.markets) {
    const definition = domain.getSpotMarketDefinition(market.symbol);
    for (const key of ["baseAsset", "quoteAsset", "priceStep", "quantityStep", "minQuantity", "makerFeeRate", "takerFeeRate", "maxPriceDeviationRatio", "referencePrice", "status"]) {
      assert.equal(definition[key], market[key], `${market.symbol}.${key}`);
    }
  }
});

await check("risk-service: reference prices + market status list", async () => {
  const { buildConfiguredReferencePrices } = await import(
    fromRoot("services/risk-service/dist/application/risk-application-service.js")
  );
  const { MarketStatusService } = await import(
    fromRoot("services/risk-service/dist/application/market-status-service.js")
  );
  const prices = buildConfiguredReferencePrices(undefined, {});
  assert.deepEqual(Object.keys(prices), allMarkets);
  for (const market of raw.markets) {
    assert.equal(prices[market.symbol], market.referencePrice);
  }
  const views = await new MarketStatusService().listMarkets();
  assert.deepEqual(views.map((view) => view.market), allMarkets);
  assert.deepEqual(views.map((view) => view.configuredStatus), raw.markets.map((market) => market.status));
});

await check("settlement-service: trade-event stream markets", async () => {
  const { resolveTradeEventStreamMarkets } = await import(
    fromRoot("services/settlement-service/dist/infrastructure/redis-order-event-client.js")
  );
  assert.deepEqual(resolveTradeEventStreamMarkets(), allMarkets);
});

await check("wallet-service: withdrawal rule asset keys", async () => {
  const { loadWithdrawalValidationRulesFromEnv } = await import(
    fromRoot("services/wallet-service/dist/infrastructure/withdrawal-validation-rules.js")
  );
  const previous = process.env.WITHDRAWAL_MIN_AMOUNT_BY_ASSET;
  process.env.WITHDRAWAL_MIN_AMOUNT_BY_ASSET = [...allAssets.map((code) => `${code}=1`), "NOTCONFIGURED=1"].join(",");
  try {
    const rules = loadWithdrawalValidationRulesFromEnv();
    assert.deepEqual(Object.keys(rules.minAmountByAsset).sort(), [...allAssets].sort());
  } finally {
    if (previous === undefined) {
      delete process.env.WITHDRAWAL_MIN_AMOUNT_BY_ASSET;
    } else {
      process.env.WITHDRAWAL_MIN_AMOUNT_BY_ASSET = previous;
    }
  }
});

await check("trader-web BFF: runtime config markets / assets / defaultMarket", async () => {
  const { buildRuntimeConfig } = await import(fromRoot("apps/trader-web/dist/server.js"));
  const config = buildRuntimeConfig({});
  assert.deepEqual(config.markets.map((market) => market.market), activeMarkets);
  assert.deepEqual(config.assets.map((asset) => asset.code), allAssets);
  assert.equal(config.defaultMarket, raw.defaultMarket);
  for (const asset of raw.assets) {
    const served = config.assets.find((item) => item.code === asset.code);
    assert.equal(served.faucet?.maxAmount, asset.demo?.faucetMaxAmount, `${asset.code} faucet`);
    assert.equal(served.withdrawalFee, asset.withdrawalFee ?? "0", `${asset.code} withdrawalFee`);
  }
});

await check("ops-console BFF: /market-config and execution schedules", async () => {
  const { OpsConsoleApplicationService } = await import(
    fromRoot("apps/ops-console/dist/application/ops-console-application-service.js")
  );
  const { InMemoryOpsActionAuditRepository } = await import(
    fromRoot("apps/ops-console/dist/infrastructure/in-memory-ops-action-audit-repository.js")
  );
  const service = new OpsConsoleApplicationService({}, {}, {}, {}, {}, {}, {}, new InMemoryOpsActionAuditRepository());
  const config = service.getMarketConfig();
  assert.deepEqual(config.markets.map((market) => market.market), allMarkets);
  assert.deepEqual(config.assets.map((asset) => asset.code), allAssets);
  assert.equal(config.defaultMarket, raw.defaultMarket);
  const schedules = await service.listExecutionSchedules();
  const scheduleMarkets = [...new Set(schedules.map((schedule) => schedule.market))].sort();
  assert.deepEqual(scheduleMarkets, [...activeMarkets].sort());
});

await check("demo scripts: simulator markets, faucet limits, demo market", async () => {
  const marketConfig = await import(fromRoot("scripts/market-config.mjs"));
  const simulated = marketConfig.buildSimulatorMarkets({}).map((spec) => spec.market);
  const expectedSimulated = raw.markets
    .filter((market) => market.status === "listed" && market.simulator?.enabled)
    .map((market) => market.symbol);
  assert.deepEqual(simulated, expectedSimulated);
  assert.deepEqual(
    Object.keys(marketConfig.buildFaucetLimits({})),
    raw.assets.filter((asset) => asset.demo?.faucetMaxAmount).map((asset) => asset.code)
  );
  const demoLib = await import(fromRoot("scripts/mvp-demo-lib.mjs"));
  assert.equal(demoLib.DEMO_MARKET, raw.defaultMarket);
  assert.equal(demoLib.buildDemoLiquidityOrders().length > 0, true);
});

await check("SOL-USDT is configured end to end", () => {
  assert.ok(allMarkets.includes("SOL-USDT"), "SOL-USDT in config");
  assert.ok(allAssets.includes("SOL"), "SOL in config");
});

await check("fee tiers: config/fee-tiers.json validates and VIP0 keeps every market's default rates", () => {
  const vip0 = domain.FEE_TIER_CONFIG.tiers[0];
  assert.equal(vip0.minVolume, "0");
  assert.ok(domain.isAssetCode(domain.FEE_TIER_CONFIG.volumeAsset), "volumeAsset is a configured asset");
  for (const market of raw.markets) {
    const definition = domain.getSpotMarketDefinition(market.symbol);
    assert.equal(domain.effectiveFeeRate(vip0, definition, "maker"), market.makerFeeRate, `${market.symbol} maker`);
    assert.equal(domain.effectiveFeeRate(vip0, definition, "taker"), market.takerFeeRate, `${market.symbol} taker`);
  }
});

// ---------------------------------------------------------------------------
// 2. Static: no hard-coded market lists outside the config
// ---------------------------------------------------------------------------

const SCAN_ROOTS = ["services", "apps", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "public", "__tests__", ".runtime"]);
// Scenario fixtures / documentation examples, not market lists.
const ALLOWED_FILES = new Set([
  "scripts/check-market-config.mjs",
  "scripts/test-trade-domain-replay.mjs",
  // Names the config-listed market it verifies (overridable via env).
  "scripts/verify-feature-e2e.mjs",
  "apps/trader-web/src/client/features/account/account-page.tsx"
]);

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

const assetPattern = allAssets.join("|");
const marketLiteral = new RegExp(`["'\`](?:${assetPattern})-(?:${assetPattern})["'\`]`);
const assetListLiteral = new RegExp(`\\[\\s*["'](?:${assetPattern})["']\\s*,\\s*["'](?:${assetPattern})["']`);

await check("static scan: no hard-coded market symbols / asset lists", async () => {
  const offenders = [];
  for (const scanRoot of SCAN_ROOTS) {
    for await (const file of walk(path.join(rootDir, scanRoot))) {
      const relative = path.relative(rootDir, file);
      if (ALLOWED_FILES.has(relative)) {
        continue;
      }
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          return;
        }
        if (marketLiteral.test(line) || assetListLiteral.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${trimmed}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `hard-coded markets found:\n${offenders.join("\n")}`);
});

let failed = 0;
for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}${result.ok ? "" : `\n     ${result.error.replaceAll("\n", "\n     ")}`}`);
  failed += result.ok ? 0 : 1;
}
console.log(`\nmarkets: ${allMarkets.join(", ")} | assets: ${allAssets.join(", ")} | default: ${raw.defaultMarket}`);
if (failed > 0) {
  console.error(`\n${failed} market-config check(s) failed`);
  process.exit(1);
}
console.log("\nAll market / asset lists derive from config/markets.json.");
