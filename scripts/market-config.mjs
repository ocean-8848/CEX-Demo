// Market / asset catalog for the demo scripts, derived from config/markets.json
// through packages/domain (the same loader + validator every service uses).
// Requires `pnpm --filter @web3-cex/domain build` (done by `pnpm build` /
// `pnpm stack:start`).

import process from "node:process";

let domain;
try {
  domain = await import("../packages/domain/dist/index.js");
} catch (error) {
  throw new Error(
    `scripts/market-config.mjs needs the built domain package (run \`pnpm --filter @web3-cex/domain build\`): ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

export const {
  DEFAULT_SPOT_MARKET,
  MARKET_CONFIG,
  getAssetDefinition,
  getSpotMarketDefinition,
  listAssetDefinitions,
  listConfiguredNetworks,
  listSpotMarketDefinitions,
  listSpotMarkets,
  referencePriceEnvKey
} = domain;

/** Number of decimals of a step such as "0.01" (-> 2). */
export function decimalsOf(step) {
  const fraction = String(step).split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}

/** Fixed-point string for a JS number, trimmed of trailing zeros. */
export function formatDecimal(value, decimals = 8) {
  const fixed = Number(value).toFixed(Math.min(Math.max(decimals, 0), 18));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Rounds `value` to the market's priceStep and formats it with the step's decimals. */
export function formatPrice(definition, value) {
  const decimals = decimalsOf(definition.priceStep);
  const step = Number(definition.priceStep);
  return (Math.round(Number(value) / step) * step).toFixed(decimals);
}

/** Formats a quantity with the market's quantityStep decimals. */
export function formatQuantity(definition, value) {
  return Number(value).toFixed(decimalsOf(definition.quantityStep));
}

/**
 * Markets the simulator quotes: `simulator.enabled` and configured `listed`.
 * (Runtime halts are checked per tick against risk-service.) The starting mid
 * is `RISK_REFERENCE_PRICE_<BASE>_<QUOTE>` > `simulator.midPrice` > `referencePrice`.
 */
export function buildSimulatorMarkets(env = process.env) {
  return listSpotMarketDefinitions()
    .filter((definition) => definition.simulator.enabled && definition.status === "listed")
    .map((definition) => {
      const reference = Number(env[referencePriceEnvKey(definition.market)] ?? definition.simulator.midPrice);
      return {
        market: definition.market,
        baseAsset: definition.baseAsset,
        quoteAsset: definition.quoteAsset,
        reference,
        mid: reference,
        priceDecimals: decimalsOf(definition.priceStep),
        quantityDecimals: decimalsOf(definition.quantityStep),
        minQuantity: Number(definition.simulator.minQuantity),
        maxQuantity: Number(definition.simulator.maxQuantity),
        baseFloor: Number(definition.simulator.baseInventory),
        quoteFloor: Number(definition.simulator.quoteInventory)
      };
    });
}

/** Faucet limit per asset: `DEMO_FAUCET_MAX_<ASSET>` env > `demo.faucetMaxAmount`. */
export function buildFaucetLimits(env = process.env) {
  return Object.fromEntries(
    listAssetDefinitions()
      .filter((asset) => asset.demo?.faucetMaxAmount)
      .map((asset) => [asset.code, Number(env[`DEMO_FAUCET_MAX_${asset.code}`] ?? asset.demo.faucetMaxAmount)])
  );
}

/** Treasury (wallet deposit-source) floor per asset from `demo.depositSourceFloor`. */
export function buildDepositSourceFloors() {
  return listAssetDefinitions()
    .filter((asset) => asset.demo?.depositSourceFloor)
    .map((asset) => ({ assetCode: asset.code, floor: asset.demo.depositSourceFloor }));
}

/**
 * Network a demo deposit / withdrawal of `assetCode` uses: the demo chain when
 * the asset lives on it, otherwise the asset's first configured network.
 */
export function networkForAsset(assetCode, preferredNetwork) {
  const networks = getAssetDefinition(assetCode)?.networks ?? [];
  return networks.includes(preferredNetwork) ? preferredNetwork : (networks[0] ?? preferredNetwork);
}
