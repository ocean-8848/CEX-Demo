// VIP fee tier view helpers (A7). Pure functions so they can be unit tested.

import { toNumber } from "@web3-cex/web-ui";

import type { TradeRecord } from "./types.js";
import { userTradeSide } from "./records.js";

export interface FeeTierDefinition {
  tier: string;
  name: string;
  minVolume: string;
  makerFeeRate: string;
  takerFeeRate: string;
}

/** GET /api/v1/gateway/fees/tier */
export interface FeeTierProfile {
  userId: string;
  tier: string;
  name: string;
  /** volume = 30-day trailing volume, programme = 做市商计划, override = 运营指定 */
  source: "volume" | "programme" | "override";
  makerFeeRate: string;
  takerFeeRate: string;
  volume: string;
  volumeAsset: string;
  volumeWindowDays: number;
  nextTier: FeeTierDefinition | null;
  remainingVolume: string;
  progressRatio: number;
  override: { tier: string; updatedAt?: string } | null;
  marketMaker: { label: string; feeTier?: string } | null;
  markets: Array<{ market: string; makerFeeRate: string; takerFeeRate: string }>;
  tiers: FeeTierDefinition[];
}

export const FEE_TIER_SOURCE_LABEL: Record<FeeTierProfile["source"], string> = {
  volume: "按 30 日成交量",
  programme: "做市商计划",
  override: "运营指定"
};

/**
 * The user's effective maker / taker rate for a market: the profile's
 * per-market rate (min(tier, market)), falling back to the market defaults.
 */
export function effectiveRateFor(
  profile: FeeTierProfile | null,
  market: string,
  liquidity: "maker" | "taker",
  fallback: { makerFeeRate?: string; takerFeeRate?: string } | undefined
): number {
  const entry = profile?.markets.find((item) => item.market === market);
  const raw = liquidity === "maker" ? entry?.makerFeeRate ?? fallback?.makerFeeRate : entry?.takerFeeRate ?? fallback?.takerFeeRate;
  return toNumber(raw ?? "0") || 0;
}

/** The rate (and tier) the user was actually charged on a trade. */
export function userTradeFeeRate(trade: TradeRecord, userId: string | undefined): { rate: number; tier?: string } {
  const side = userTradeSide(trade, userId);
  if (side === "buy") {
    return { rate: toNumber(trade.buyerFeeRate ?? "0") || 0, tier: trade.buyerFeeTier };
  }
  return { rate: toNumber(trade.sellerFeeRate ?? "0") || 0, tier: trade.sellerFeeTier };
}

export function formatRate(rate: number | string): string {
  const value = typeof rate === "number" ? rate : toNumber(rate);
  return `${(value * 100).toFixed(value * 100 < 0.1 ? 3 : 2).replace(/0$/, "")}%`;
}
