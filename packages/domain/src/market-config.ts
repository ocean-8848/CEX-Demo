// Market & asset configuration.
//
// `config/markets.json` at the repo root is the single source of truth for
// which assets exist and which spot markets trade. Every service, script and
// BFF derives its market / asset lists from the exports below; nothing else may
// hard-code a market symbol. The file is loaded once at module load:
//
//   1. `WEB3_CEX_MARKETS_CONFIG` (absolute, or relative to the process cwd)
//   2. the nearest `config/markets.json` walking up from this package
//
// Market / asset codes are plain strings at the type level; validity is a
// runtime property (`isSpotMarket`, `isAssetCode`), because the set is data.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { alignsToStep, compareAmounts, isPositiveAmount } from "./decimal.js";

/** Asset code from config/markets.json, e.g. "USDT". Validate with `isAssetCode`. */
export type AssetCode = string;

/** Spot market symbol `<BASE>-<QUOTE>` from config/markets.json. Validate with `isSpotMarket`. */
export type SpotMarket = string;

/**
 * Networks are code-level capabilities (each needs an address format, a scanner
 * and a custody adapter), so they stay a closed union; config can only pick
 * from them.
 */
export const KNOWN_NETWORKS = ["ethereum", "bsc", "base", "solana", "bitcoin"] as const;
export type Network = (typeof KNOWN_NETWORKS)[number];

export const MARKET_STATUSES = ["listed", "halted", "delisted"] as const;
/** listed = trading; halted = new orders rejected, cancels allowed; delisted = hidden + rejected. */
export type MarketStatus = (typeof MARKET_STATUSES)[number];

export interface AssetDemoSettings {
  /** Max amount per faucet request. Absent = faucet disabled for the asset. */
  faucetMaxAmount?: string;
  /** Floor kept on the wallet deposit-source treasury account. */
  depositSourceFloor?: string;
  /** Quick-pick amounts the trader-web faucet offers (each <= faucetMaxAmount). */
  faucetPresets?: string[];
}

export interface AssetDefinition {
  code: AssetCode;
  name: string;
  decimals: number;
  displayDecimals: number;
  networks: Network[];
  /** Flat withdrawal fee shown / sent by trader-web ("0" when not configured). */
  withdrawalFee: string;
  demo?: AssetDemoSettings;
}

export interface MarketSimulatorSettings {
  enabled: boolean;
  /** Starting mid price for the simulator random walk; defaults to referencePrice. */
  midPrice: string;
  minQuantity: string;
  maxQuantity: string;
  /** Base-asset inventory the ask maker keeps. */
  baseInventory: string;
  /** Quote-asset inventory the bid maker keeps. */
  quoteInventory: string;
}

export interface SpotMarketDefinition {
  market: SpotMarket;
  baseAsset: AssetCode;
  quoteAsset: AssetCode;
  status: MarketStatus;
  minQuantity: string;
  quantityStep: string;
  priceStep: string;
  maxPriceDeviationRatio: string;
  takerFeeRate: string;
  makerFeeRate: string;
  /** Configured fallback reference price (risk) and default simulator mid. */
  referencePrice: string;
  simulator: MarketSimulatorSettings;
}

export interface MarketConfig {
  version: 1;
  defaultMarket: SpotMarket;
  assets: AssetDefinition[];
  markets: SpotMarketDefinition[];
  /** Absolute path the config was read from (undefined when parsed from memory). */
  sourcePath?: string;
}

export class MarketConfigError extends Error {
  constructor(readonly issues: string[], source?: string) {
    super(
      `Invalid market config${source ? ` (${source})` : ""}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`
    );
    this.name = "MarketConfigError";
  }
}

export const MARKETS_CONFIG_ENV = "WEB3_CEX_MARKETS_CONFIG";

const ASSET_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const MARKET_KEYS = [
  "symbol",
  "baseAsset",
  "quoteAsset",
  "status",
  "priceStep",
  "quantityStep",
  "minQuantity",
  "makerFeeRate",
  "takerFeeRate",
  "maxPriceDeviationRatio",
  "referencePrice",
  "simulator"
];
const SIMULATOR_KEYS = ["enabled", "midPrice", "minQuantity", "maxQuantity", "baseInventory", "quoteInventory"];

/**
 * Validates raw JSON and returns a normalized config. Collects every problem
 * instead of stopping at the first one, so a broken file is fixed in one pass.
 */
export function parseMarketConfig(raw: unknown, source?: string): MarketConfig {
  const issues: string[] = [];
  const root = asRecord(raw);
  if (!root) {
    throw new MarketConfigError(["config must be a JSON object"], source);
  }

  if (root.version !== 1) {
    issues.push(`version must be 1 (got ${JSON.stringify(root.version)})`);
  }

  const assets: AssetDefinition[] = [];
  const assetByCode = new Map<string, AssetDefinition>();
  const rawAssets = Array.isArray(root.assets) ? root.assets : [];
  if (!Array.isArray(root.assets) || rawAssets.length === 0) {
    issues.push("assets must be a non-empty array");
  }

  rawAssets.forEach((entry, index) => {
    const asset = asRecord(entry);
    const where = `assets[${index}]`;
    if (!asset) {
      issues.push(`${where} must be an object`);
      return;
    }
    const code = typeof asset.code === "string" ? asset.code : "";
    if (!ASSET_CODE_PATTERN.test(code)) {
      issues.push(`${where}.code ${JSON.stringify(asset.code)} must match ${ASSET_CODE_PATTERN}`);
    } else if (assetByCode.has(code)) {
      issues.push(`${where}.code ${code} is duplicated`);
    }
    const name = typeof asset.name === "string" && asset.name.trim() ? asset.name : "";
    if (!name) {
      issues.push(`${where}.name is required`);
    }
    const decimals = readInteger(asset.decimals, 0, 18);
    if (decimals === undefined) {
      issues.push(`${where}.decimals must be an integer 0..18`);
    }
    const displayDecimals =
      asset.displayDecimals === undefined ? Math.min(decimals ?? 8, 8) : readInteger(asset.displayDecimals, 0, 18);
    if (displayDecimals === undefined) {
      issues.push(`${where}.displayDecimals must be an integer 0..18`);
    }
    const networks: Network[] = [];
    if (!Array.isArray(asset.networks) || asset.networks.length === 0) {
      issues.push(`${where}.networks must be a non-empty array`);
    } else {
      for (const network of asset.networks) {
        if (!(KNOWN_NETWORKS as readonly unknown[]).includes(network)) {
          issues.push(`${where}.networks contains unknown network ${JSON.stringify(network)} (known: ${KNOWN_NETWORKS.join(", ")})`);
        } else if (networks.includes(network as Network)) {
          issues.push(`${where}.networks lists ${String(network)} twice`);
        } else {
          networks.push(network as Network);
        }
      }
    }
    let demo: AssetDemoSettings | undefined;
    if (asset.demo !== undefined) {
      const rawDemo = asRecord(asset.demo);
      if (!rawDemo) {
        issues.push(`${where}.demo must be an object`);
      } else {
        demo = {};
        for (const key of ["faucetMaxAmount", "depositSourceFloor"] as const) {
          if (rawDemo[key] === undefined) {
            continue;
          }
          const value = readPositiveDecimal(rawDemo[key]);
          if (!value) {
            issues.push(`${where}.demo.${key} must be a positive decimal string`);
          } else {
            demo[key] = value;
          }
        }
        if (rawDemo.faucetPresets !== undefined) {
          const presets = Array.isArray(rawDemo.faucetPresets)
            ? rawDemo.faucetPresets.map((preset) => readPositiveDecimal(preset))
            : [];
          if (presets.length === 0 || presets.some((preset) => !preset)) {
            issues.push(`${where}.demo.faucetPresets must be a non-empty array of positive decimal strings`);
          } else if (
            demo.faucetMaxAmount &&
            presets.some((preset) => compareAmounts(preset as string, demo?.faucetMaxAmount as string) > 0)
          ) {
            issues.push(`${where}.demo.faucetPresets must not exceed faucetMaxAmount ${demo.faucetMaxAmount}`);
          } else {
            demo.faucetPresets = presets as string[];
          }
        }
        for (const key of Object.keys(rawDemo)) {
          if (!["faucetMaxAmount", "depositSourceFloor", "faucetPresets"].includes(key)) {
            issues.push(`${where}.demo has unknown key ${key}`);
          }
        }
      }
    }
    let withdrawalFee = "0";
    if (asset.withdrawalFee !== undefined) {
      const fee = readDecimal(asset.withdrawalFee);
      if (!fee) {
        issues.push(`${where}.withdrawalFee must be a non-negative decimal string`);
      } else {
        withdrawalFee = fee;
      }
    }
    for (const key of Object.keys(asset)) {
      if (!["code", "name", "decimals", "displayDecimals", "networks", "withdrawalFee", "demo"].includes(key)) {
        issues.push(`${where} has unknown key ${key}`);
      }
    }
    const definition: AssetDefinition = {
      code,
      name,
      decimals: decimals ?? 0,
      displayDecimals: displayDecimals ?? 0,
      networks,
      withdrawalFee,
      ...(demo ? { demo } : {})
    };
    if (code && !assetByCode.has(code)) {
      assetByCode.set(code, definition);
      assets.push(definition);
    }
  });

  const markets: SpotMarketDefinition[] = [];
  const marketSymbols = new Set<string>();
  const rawMarkets = Array.isArray(root.markets) ? root.markets : [];
  if (!Array.isArray(root.markets) || rawMarkets.length === 0) {
    issues.push("markets must be a non-empty array");
  }

  rawMarkets.forEach((entry, index) => {
    const market = asRecord(entry);
    const where = `markets[${index}]`;
    if (!market) {
      issues.push(`${where} must be an object`);
      return;
    }
    const symbol = typeof market.symbol === "string" ? market.symbol : "";
    const baseAsset = typeof market.baseAsset === "string" ? market.baseAsset : "";
    const quoteAsset = typeof market.quoteAsset === "string" ? market.quoteAsset : "";
    const label = symbol ? `${where} (${symbol})` : where;

    if (symbol !== `${baseAsset}-${quoteAsset}`) {
      issues.push(`${label}.symbol must equal "<baseAsset>-<quoteAsset>" (${baseAsset}-${quoteAsset})`);
    }
    if (marketSymbols.has(symbol)) {
      issues.push(`${label}.symbol is duplicated`);
    }
    const base = assetByCode.get(baseAsset);
    const quote = assetByCode.get(quoteAsset);
    if (!base) {
      issues.push(`${label}.baseAsset ${baseAsset || "(missing)"} is not a configured asset`);
    }
    if (!quote) {
      issues.push(`${label}.quoteAsset ${quoteAsset || "(missing)"} is not a configured asset`);
    }
    if (baseAsset && baseAsset === quoteAsset) {
      issues.push(`${label} baseAsset and quoteAsset must differ`);
    }
    const status = market.status;
    if (!(MARKET_STATUSES as readonly unknown[]).includes(status)) {
      issues.push(`${label}.status must be one of ${MARKET_STATUSES.join(", ")}`);
    }

    const decimalField = (key: string, options: { allowZero?: boolean } = {}): string => {
      const value = options.allowZero ? readDecimal(market[key]) : readPositiveDecimal(market[key]);
      if (!value) {
        issues.push(`${label}.${key} must be a ${options.allowZero ? "non-negative" : "positive"} decimal string`);
        return "0";
      }
      return value;
    };

    const priceStep = decimalField("priceStep");
    const quantityStep = decimalField("quantityStep");
    const minQuantity = decimalField("minQuantity");
    const makerFeeRate = decimalField("makerFeeRate", { allowZero: true });
    const takerFeeRate = decimalField("takerFeeRate", { allowZero: true });
    const maxPriceDeviationRatio = decimalField("maxPriceDeviationRatio");
    const referencePrice = decimalField("referencePrice");

    if (isPositiveAmount(quantityStep) && isPositiveAmount(minQuantity) && !alignsToStep(minQuantity, quantityStep)) {
      issues.push(`${label}.minQuantity ${minQuantity} must align to quantityStep ${quantityStep}`);
    }
    if (isPositiveAmount(priceStep) && isPositiveAmount(referencePrice) && !alignsToStep(referencePrice, priceStep)) {
      issues.push(`${label}.referencePrice ${referencePrice} must align to priceStep ${priceStep}`);
    }
    for (const [key, rate] of [["makerFeeRate", makerFeeRate], ["takerFeeRate", takerFeeRate]] as const) {
      if (compareAmounts(rate, "1") >= 0) {
        issues.push(`${label}.${key} must be below 1`);
      }
    }
    if (compareAmounts(maxPriceDeviationRatio, "1") > 0) {
      issues.push(`${label}.maxPriceDeviationRatio must be at most 1`);
    }
    if (base && countDecimals(quantityStep) > base.decimals) {
      issues.push(`${label}.quantityStep ${quantityStep} has more decimals than ${base.code} (${base.decimals})`);
    }
    if (quote && countDecimals(priceStep) > quote.decimals) {
      issues.push(`${label}.priceStep ${priceStep} has more decimals than ${quote.code} (${quote.decimals})`);
    }

    const rawSimulator = market.simulator === undefined ? {} : asRecord(market.simulator);
    if (!rawSimulator) {
      issues.push(`${label}.simulator must be an object`);
    }
    const simulatorField = (key: string, fallback: string): string => {
      const value = rawSimulator?.[key];
      if (value === undefined) {
        return fallback;
      }
      const parsed = readPositiveDecimal(value);
      if (!parsed) {
        issues.push(`${label}.simulator.${key} must be a positive decimal string`);
        return fallback;
      }
      return parsed;
    };
    const simulator: MarketSimulatorSettings = {
      enabled: rawSimulator?.enabled === undefined ? false : rawSimulator.enabled === true,
      midPrice: simulatorField("midPrice", referencePrice),
      minQuantity: simulatorField("minQuantity", minQuantity),
      maxQuantity: simulatorField("maxQuantity", minQuantity),
      baseInventory: simulatorField("baseInventory", "0"),
      quoteInventory: simulatorField("quoteInventory", "0")
    };
    if (rawSimulator && rawSimulator.enabled !== undefined && typeof rawSimulator.enabled !== "boolean") {
      issues.push(`${label}.simulator.enabled must be a boolean`);
    }
    if (compareAmounts(simulator.maxQuantity, simulator.minQuantity) < 0) {
      issues.push(`${label}.simulator.maxQuantity must be >= simulator.minQuantity`);
    }
    if (compareAmounts(simulator.minQuantity, minQuantity) < 0) {
      issues.push(`${label}.simulator.minQuantity must be >= minQuantity`);
    }

    for (const key of Object.keys(market)) {
      if (!MARKET_KEYS.includes(key)) {
        issues.push(`${label} has unknown key ${key}`);
      }
    }
    for (const key of Object.keys(rawSimulator ?? {})) {
      if (!SIMULATOR_KEYS.includes(key)) {
        issues.push(`${label}.simulator has unknown key ${key}`);
      }
    }

    if (symbol) {
      marketSymbols.add(symbol);
    }
    markets.push({
      market: symbol,
      baseAsset,
      quoteAsset,
      status: (MARKET_STATUSES as readonly unknown[]).includes(status) ? (status as MarketStatus) : "halted",
      minQuantity,
      quantityStep,
      priceStep,
      maxPriceDeviationRatio,
      takerFeeRate,
      makerFeeRate,
      referencePrice,
      simulator
    });
  });

  const defaultMarket = typeof root.defaultMarket === "string" ? root.defaultMarket : "";
  const defaultDefinition = markets.find((market) => market.market === defaultMarket);
  if (!defaultDefinition) {
    issues.push(`defaultMarket ${JSON.stringify(root.defaultMarket)} must be one of the configured markets`);
  } else if (defaultDefinition.status === "delisted") {
    issues.push(`defaultMarket ${defaultMarket} must not be delisted`);
  }

  for (const key of Object.keys(root)) {
    if (!["$schema", "version", "defaultMarket", "assets", "markets"].includes(key)) {
      issues.push(`unknown top-level key ${key}`);
    }
  }

  if (issues.length > 0) {
    throw new MarketConfigError(issues, source);
  }

  return {
    version: 1,
    defaultMarket,
    assets,
    markets,
    ...(source ? { sourcePath: source } : {})
  };
}

/** Resolves the config path: explicit > env > nearest `config/markets.json` above this package. */
export function resolveMarketConfigPath(
  options: { path?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): string {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path ?? (options.env ?? process.env)[MARKETS_CONFIG_ENV];
  if (explicit && explicit.trim()) {
    return path.resolve(cwd, explicit.trim());
  }

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(directory, "config", "markets.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new MarketConfigError([
        `config/markets.json not found above ${path.dirname(fileURLToPath(import.meta.url))}; set ${MARKETS_CONFIG_ENV}`
      ]);
    }
    directory = parent;
  }
}

export function loadMarketConfig(
  options: { path?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): MarketConfig {
  const configPath = resolveMarketConfigPath(options);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new MarketConfigError(
      [`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`],
      configPath
    );
  }
  return parseMarketConfig(raw, configPath);
}

/** Lookup helpers over one config instance (services use the module-level one below). */
export interface MarketCatalog {
  readonly config: MarketConfig;
  readonly defaultMarket: SpotMarket;
  readonly marketDefinitions: Readonly<Record<SpotMarket, SpotMarketDefinition>>;
  readonly assetDefinitions: Readonly<Record<AssetCode, AssetDefinition>>;
  /** Markets in config order; delisted ones only with `includeDelisted`. */
  listMarkets(options?: { includeDelisted?: boolean }): SpotMarket[];
  listMarketDefinitions(options?: { includeDelisted?: boolean }): SpotMarketDefinition[];
  getMarket(market: string | undefined | null): SpotMarketDefinition | undefined;
  isMarket(value: unknown): value is SpotMarket;
  listAssetCodes(): AssetCode[];
  getAsset(code: string | undefined | null): AssetDefinition | undefined;
  isAsset(value: unknown): value is AssetCode;
  /** Distinct networks used by any asset, in config order. */
  listNetworks(): Network[];
}

export function createMarketCatalog(config: MarketConfig): MarketCatalog {
  // Prototype-less records: `"constructor" in SPOT_MARKET_DEFINITIONS` must be false.
  const marketDefinitions = Object.freeze(
    Object.assign(
      Object.create(null) as Record<SpotMarket, SpotMarketDefinition>,
      Object.fromEntries(config.markets.map((market) => [market.market, Object.freeze({ ...market })]))
    )
  ) as Readonly<Record<SpotMarket, SpotMarketDefinition>>;
  const assetDefinitions = Object.freeze(
    Object.assign(
      Object.create(null) as Record<AssetCode, AssetDefinition>,
      Object.fromEntries(config.assets.map((asset) => [asset.code, Object.freeze({ ...asset })]))
    )
  ) as Readonly<Record<AssetCode, AssetDefinition>>;
  const has = (record: object, key: unknown): boolean =>
    typeof key === "string" && Object.prototype.hasOwnProperty.call(record, key);

  const listMarketDefinitions = (options: { includeDelisted?: boolean } = {}) =>
    config.markets
      .filter((market) => options.includeDelisted || market.status !== "delisted")
      .map((market) => marketDefinitions[market.market] as SpotMarketDefinition);

  return {
    config,
    defaultMarket: config.defaultMarket,
    marketDefinitions,
    assetDefinitions,
    listMarkets: (options) => listMarketDefinitions(options).map((market) => market.market),
    listMarketDefinitions,
    getMarket: (market) => (has(marketDefinitions, market) ? marketDefinitions[market as string] : undefined),
    isMarket: (value): value is SpotMarket => has(marketDefinitions, value),
    listAssetCodes: () => config.assets.map((asset) => asset.code),
    getAsset: (code) => (has(assetDefinitions, code) ? assetDefinitions[code as string] : undefined),
    isAsset: (value): value is AssetCode => has(assetDefinitions, value),
    listNetworks: () => [...new Set(config.assets.flatMap((asset) => asset.networks))]
  };
}

// ---------------------------------------------------------------------------
// Process-wide catalog, loaded once from config/markets.json.
// ---------------------------------------------------------------------------

export const MARKET_CATALOG: MarketCatalog = createMarketCatalog(loadMarketConfig());
export const MARKET_CONFIG: MarketConfig = MARKET_CATALOG.config;

/**
 * Every configured market (including delisted ones, so historical trades still
 * settle), keyed by symbol. Kept for compatibility; prefer the helpers below.
 */
export const SPOT_MARKET_DEFINITIONS: Readonly<Record<SpotMarket, SpotMarketDefinition>> =
  MARKET_CATALOG.marketDefinitions;
export const ASSET_DEFINITIONS: Readonly<Record<AssetCode, AssetDefinition>> = MARKET_CATALOG.assetDefinitions;
export const DEFAULT_SPOT_MARKET: SpotMarket = MARKET_CATALOG.defaultMarket;

export function listSpotMarkets(options?: { includeDelisted?: boolean }): SpotMarket[] {
  return MARKET_CATALOG.listMarkets(options);
}

export function listSpotMarketDefinitions(options?: { includeDelisted?: boolean }): SpotMarketDefinition[] {
  return MARKET_CATALOG.listMarketDefinitions(options);
}

export function getSpotMarketDefinition(market: string | undefined | null): SpotMarketDefinition | undefined {
  return MARKET_CATALOG.getMarket(market);
}

export function isSpotMarket(value: unknown): value is SpotMarket {
  return MARKET_CATALOG.isMarket(value);
}

export function listAssetCodes(): AssetCode[] {
  return MARKET_CATALOG.listAssetCodes();
}

export function listAssetDefinitions(): AssetDefinition[] {
  return MARKET_CATALOG.listAssetCodes().map((code) => MARKET_CATALOG.assetDefinitions[code] as AssetDefinition);
}

export function getAssetDefinition(code: string | undefined | null): AssetDefinition | undefined {
  return MARKET_CATALOG.getAsset(code);
}

export function isAssetCode(value: unknown): value is AssetCode {
  return MARKET_CATALOG.isAsset(value);
}

export function listConfiguredNetworks(): Network[] {
  return MARKET_CATALOG.listNetworks();
}

export function isKnownNetwork(value: unknown): value is Network {
  return (KNOWN_NETWORKS as readonly unknown[]).includes(value);
}

/**
 * Env override name for a market's configured reference price, e.g.
 * `RISK_REFERENCE_PRICE_SOL_USDT`. Lets ops pin a price without editing JSON.
 */
export function referencePriceEnvKey(market: SpotMarket): string {
  return `RISK_REFERENCE_PRICE_${market.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function readDecimal(value: unknown): string | undefined {
  return typeof value === "string" && DECIMAL_PATTERN.test(value) && countDecimals(value) <= 18
    ? value
    : undefined;
}

function readPositiveDecimal(value: unknown): string | undefined {
  const decimal = readDecimal(value);
  return decimal && isPositiveAmount(decimal) ? decimal : undefined;
}

function countDecimals(value: string): number {
  const fraction = value.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}
