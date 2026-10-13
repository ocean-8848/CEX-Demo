// Spot fee tiers (VIP) and the market-maker programme.
//
// `config/fee-tiers.json` at the repo root is the single source of truth for
// the VIP ladder: 30-day trailing spot volume thresholds (in `volumeAsset`) and
// the maker / taker rate of each tier. It is loaded once at module load:
//
//   1. `WEB3_CEX_FEE_TIERS_CONFIG` (absolute, or relative to the process cwd)
//   2. the nearest `config/fee-tiers.json` walking up from this package
//
// Resolution (order-service, at trade time):
//   ops override (DB)  >  marketMakers[].feeTier (config)  >  trailing volume
// The effective rate of a fill is `min(tier rate, market rate)`: a market can
// run a promotional rate below the ladder, and VIP0 (= the default market
// rates) leaves every existing fee unchanged. The resolved tier and rate are
// recorded on the trade, so replaying a trade always charges the same fee.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareAmounts, isPositiveAmount, subtractAmounts } from "./decimal.js";
import { MARKET_CATALOG, type AssetCode, type MarketCatalog, type SpotMarketDefinition } from "./market-config.js";

export interface FeeTierDefinition {
  /** Tier code, e.g. "VIP0". */
  tier: string;
  /** Display name. */
  name: string;
  /** Inclusive lower bound of trailing volume (in `volumeAsset`). */
  minVolume: string;
  makerFeeRate: string;
  takerFeeRate: string;
}

export interface MarketMakerProgrammeMember {
  userId: string;
  /** Shown in ops-console / surveillance instead of the raw user id, e.g. "做市商 Ask". */
  label: string;
  /** Pinned tier for programme members (absent = resolved by volume like everybody else). */
  feeTier?: string;
}

export interface FeeTierConfig {
  version: 1;
  volumeAsset: AssetCode;
  volumeWindowDays: number;
  /** Ascending by `minVolume`; the first tier starts at 0. */
  tiers: FeeTierDefinition[];
  marketMakers: MarketMakerProgrammeMember[];
  sourcePath?: string;
}

export type FeeTierSource = "volume" | "programme" | "override";

export interface ResolvedFeeTier {
  tier: string;
  name: string;
  source: FeeTierSource;
  makerFeeRate: string;
  takerFeeRate: string;
}

export interface FeeTierProgress {
  current: FeeTierDefinition;
  next?: FeeTierDefinition;
  /** Volume still needed to reach `next` ("0" when already there / no next tier). */
  remainingVolume: string;
  /** 0..1 share of the way from current.minVolume to next.minVolume. */
  progressRatio: number;
}

export class FeeTierConfigError extends Error {
  constructor(readonly issues: string[], source?: string) {
    super(
      `Invalid fee tier config${source ? ` (${source})` : ""}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`
    );
    this.name = "FeeTierConfigError";
  }
}

export const FEE_TIERS_CONFIG_ENV = "WEB3_CEX_FEE_TIERS_CONFIG";

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const TIER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,15}$/;

/**
 * Validates raw JSON and returns a normalized config. Collects every problem
 * instead of stopping at the first one. `catalog` (defaults to the process
 * market catalog) is used to check that `volumeAsset` is a configured asset.
 */
export function parseFeeTierConfig(
  raw: unknown,
  source?: string,
  catalog: Pick<MarketCatalog, "isAsset"> = MARKET_CATALOG
): FeeTierConfig {
  const issues: string[] = [];
  const root = asRecord(raw);
  if (!root) {
    throw new FeeTierConfigError(["config must be a JSON object"], source);
  }
  if (root.version !== 1) {
    issues.push(`version must be 1 (got ${JSON.stringify(root.version)})`);
  }

  const volumeAsset = typeof root.volumeAsset === "string" ? root.volumeAsset : "";
  if (!catalog.isAsset(volumeAsset)) {
    issues.push(`volumeAsset ${JSON.stringify(root.volumeAsset)} must be a configured asset (config/markets.json)`);
  }
  const volumeWindowDays =
    typeof root.volumeWindowDays === "number" &&
    Number.isInteger(root.volumeWindowDays) &&
    root.volumeWindowDays >= 1 &&
    root.volumeWindowDays <= 365
      ? root.volumeWindowDays
      : 0;
  if (!volumeWindowDays) {
    issues.push("volumeWindowDays must be an integer 1..365");
  }

  const tiers: FeeTierDefinition[] = [];
  const rawTiers = Array.isArray(root.tiers) ? root.tiers : [];
  if (!Array.isArray(root.tiers) || rawTiers.length === 0) {
    issues.push("tiers must be a non-empty array");
  }
  rawTiers.forEach((entry, index) => {
    const tier = asRecord(entry);
    const where = `tiers[${index}]`;
    if (!tier) {
      issues.push(`${where} must be an object`);
      return;
    }
    const code = typeof tier.tier === "string" ? tier.tier : "";
    const label = code ? `${where} (${code})` : where;
    if (!TIER_CODE_PATTERN.test(code)) {
      issues.push(`${where}.tier ${JSON.stringify(tier.tier)} must match ${TIER_CODE_PATTERN}`);
    } else if (tiers.some((existing) => existing.tier === code)) {
      issues.push(`${label}.tier is duplicated`);
    }
    const decimal = (key: string): string => {
      const value = readDecimal(tier[key]);
      if (value === undefined) {
        issues.push(`${label}.${key} must be a non-negative decimal string`);
        return "0";
      }
      return value;
    };
    const minVolume = decimal("minVolume");
    const makerFeeRate = decimal("makerFeeRate");
    const takerFeeRate = decimal("takerFeeRate");
    for (const [key, rate] of [["makerFeeRate", makerFeeRate], ["takerFeeRate", takerFeeRate]] as const) {
      if (compareAmounts(rate, "1") >= 0) {
        issues.push(`${label}.${key} must be below 1`);
      }
    }
    if (tier.name !== undefined && (typeof tier.name !== "string" || !tier.name.trim())) {
      issues.push(`${label}.name must be a non-empty string`);
    }
    for (const key of Object.keys(tier)) {
      if (!["tier", "name", "minVolume", "makerFeeRate", "takerFeeRate"].includes(key)) {
        issues.push(`${label} has unknown key ${key}`);
      }
    }
    const previous = tiers.at(-1);
    if (index === 0 && isPositiveAmount(minVolume)) {
      issues.push(`${label}.minVolume must be 0 (the first tier is the default for every account)`);
    }
    if (previous) {
      if (compareAmounts(minVolume, previous.minVolume) <= 0) {
        issues.push(`${label}.minVolume ${minVolume} must be greater than ${previous.tier} (${previous.minVolume})`);
      }
      if (compareAmounts(makerFeeRate, previous.makerFeeRate) > 0) {
        issues.push(`${label}.makerFeeRate must not exceed ${previous.tier} (${previous.makerFeeRate})`);
      }
      if (compareAmounts(takerFeeRate, previous.takerFeeRate) > 0) {
        issues.push(`${label}.takerFeeRate must not exceed ${previous.tier} (${previous.takerFeeRate})`);
      }
    }
    tiers.push({
      tier: code,
      name: typeof tier.name === "string" && tier.name.trim() ? tier.name : code,
      minVolume,
      makerFeeRate,
      takerFeeRate
    });
  });

  const marketMakers: MarketMakerProgrammeMember[] = [];
  if (root.marketMakers !== undefined && !Array.isArray(root.marketMakers)) {
    issues.push("marketMakers must be an array");
  }
  (Array.isArray(root.marketMakers) ? root.marketMakers : []).forEach((entry, index) => {
    const member = asRecord(entry);
    const where = `marketMakers[${index}]`;
    if (!member) {
      issues.push(`${where} must be an object`);
      return;
    }
    const userId = typeof member.userId === "string" ? member.userId.trim() : "";
    const label = typeof member.label === "string" ? member.label.trim() : "";
    if (!userId) {
      issues.push(`${where}.userId is required`);
    } else if (marketMakers.some((existing) => existing.userId === userId)) {
      issues.push(`${where}.userId ${userId} is duplicated`);
    }
    if (!label) {
      issues.push(`${where}.label is required`);
    }
    let feeTier: string | undefined;
    if (member.feeTier !== undefined) {
      if (typeof member.feeTier !== "string" || !tiers.some((tier) => tier.tier === member.feeTier)) {
        issues.push(`${where}.feeTier ${JSON.stringify(member.feeTier)} must be one of the configured tiers`);
      } else {
        feeTier = member.feeTier;
      }
    }
    for (const key of Object.keys(member)) {
      if (!["userId", "label", "feeTier"].includes(key)) {
        issues.push(`${where} has unknown key ${key}`);
      }
    }
    marketMakers.push({ userId, label, ...(feeTier ? { feeTier } : {}) });
  });

  for (const key of Object.keys(root)) {
    if (!["$schema", "version", "volumeAsset", "volumeWindowDays", "tiers", "marketMakers"].includes(key)) {
      issues.push(`unknown top-level key ${key}`);
    }
  }

  if (issues.length > 0) {
    throw new FeeTierConfigError(issues, source);
  }

  return {
    version: 1,
    volumeAsset,
    volumeWindowDays,
    tiers,
    marketMakers,
    ...(source ? { sourcePath: source } : {})
  };
}

/** Resolves the config path: explicit > env > nearest `config/fee-tiers.json` above this package. */
export function resolveFeeTierConfigPath(
  options: { path?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): string {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path ?? (options.env ?? process.env)[FEE_TIERS_CONFIG_ENV];
  if (explicit && explicit.trim()) {
    return path.resolve(cwd, explicit.trim());
  }
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(directory, "config", "fee-tiers.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new FeeTierConfigError([
        `config/fee-tiers.json not found above ${path.dirname(fileURLToPath(import.meta.url))}; set ${FEE_TIERS_CONFIG_ENV}`
      ]);
    }
    directory = parent;
  }
}

export function loadFeeTierConfig(
  options: { path?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): FeeTierConfig {
  const configPath = resolveFeeTierConfigPath(options);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new FeeTierConfigError(
      [`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`],
      configPath
    );
  }
  return parseFeeTierConfig(raw, configPath);
}

// ---------------------------------------------------------------------------
// Pure resolution helpers (take the config explicitly so they are testable).
// ---------------------------------------------------------------------------

export function findFeeTier(config: FeeTierConfig, tier: string | undefined | null): FeeTierDefinition | undefined {
  return tier ? config.tiers.find((definition) => definition.tier === tier) : undefined;
}

/** Highest tier whose `minVolume` <= volume. */
export function feeTierForVolume(config: FeeTierConfig, volume: string): FeeTierDefinition {
  let resolved = config.tiers[0] as FeeTierDefinition;
  for (const tier of config.tiers) {
    if (compareAmounts(volume, tier.minVolume) >= 0) {
      resolved = tier;
    }
  }
  return resolved;
}

export function findMarketMaker(
  config: FeeTierConfig,
  userId: string | undefined | null
): MarketMakerProgrammeMember | undefined {
  return userId ? config.marketMakers.find((member) => member.userId === userId) : undefined;
}

/** override (ops) > programme (config) > volume. Unknown override tiers are ignored. */
export function resolveFeeTier(
  config: FeeTierConfig,
  input: { userId?: string; volume: string; overrideTier?: string | null }
): ResolvedFeeTier {
  const override = findFeeTier(config, input.overrideTier);
  const programme = findFeeTier(config, findMarketMaker(config, input.userId)?.feeTier);
  const definition = override ?? programme ?? feeTierForVolume(config, input.volume);
  return {
    tier: definition.tier,
    name: definition.name,
    source: override ? "override" : programme ? "programme" : "volume",
    makerFeeRate: definition.makerFeeRate,
    takerFeeRate: definition.takerFeeRate
  };
}

/** Effective rate for one side of a fill: min(tier rate, market rate). */
export function effectiveFeeRate(
  tier: Pick<ResolvedFeeTier, "makerFeeRate" | "takerFeeRate"> | undefined,
  market: Pick<SpotMarketDefinition, "makerFeeRate" | "takerFeeRate">,
  liquidity: "maker" | "taker"
): string {
  const marketRate = liquidity === "maker" ? market.makerFeeRate : market.takerFeeRate;
  if (!tier) {
    return marketRate;
  }
  const tierRate = liquidity === "maker" ? tier.makerFeeRate : tier.takerFeeRate;
  return compareAmounts(tierRate, marketRate) < 0 ? tierRate : marketRate;
}

export function describeFeeTierProgress(config: FeeTierConfig, volume: string, tier?: string): FeeTierProgress {
  const current = findFeeTier(config, tier) ?? feeTierForVolume(config, volume);
  const index = config.tiers.indexOf(current);
  // The next tier by volume, measured from what the volume alone earns.
  const byVolume = feeTierForVolume(config, volume);
  const next = config.tiers[Math.max(index, config.tiers.indexOf(byVolume)) + 1];
  if (!next) {
    return { current, remainingVolume: "0", progressRatio: 1 };
  }
  const remaining = subtractAmounts(next.minVolume, volume);
  const span = Number(subtractAmounts(next.minVolume, byVolume.minVolume));
  const done = Number(subtractAmounts(volume, byVolume.minVolume));
  return {
    current,
    next,
    remainingVolume: compareAmounts(remaining, "0") > 0 ? remaining : "0",
    progressRatio: span > 0 ? Math.min(Math.max(done / span, 0), 1) : 1
  };
}

// ---------------------------------------------------------------------------
// Process-wide config, loaded once from config/fee-tiers.json.
// ---------------------------------------------------------------------------

export const FEE_TIER_CONFIG: FeeTierConfig = loadFeeTierConfig();

export function listFeeTiers(): FeeTierDefinition[] {
  return FEE_TIER_CONFIG.tiers;
}

export function getFeeTier(tier: string | undefined | null): FeeTierDefinition | undefined {
  return findFeeTier(FEE_TIER_CONFIG, tier);
}

export function getMarketMaker(userId: string | undefined | null): MarketMakerProgrammeMember | undefined {
  return findMarketMaker(FEE_TIER_CONFIG, userId);
}

export function isMarketMakerUser(userId: string | undefined | null): boolean {
  return !!getMarketMaker(userId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readDecimal(value: unknown): string | undefined {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return undefined;
  }
  const fraction = value.split(".")[1] ?? "";
  return fraction.length <= 18 ? value : undefined;
}
