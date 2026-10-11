import type { MarketStatus, SpotMarket } from "@web3-cex/domain";

/** Statuses ops can set at runtime. `delisted` is config-only (config/markets.json). */
export type MarketStatusOverrideValue = Extract<MarketStatus, "listed" | "halted">;

/**
 * Runtime override of a market's configured status, persisted by risk-service
 * so ops can halt / resume trading without editing config/markets.json.
 */
export interface MarketStatusOverride {
  market: SpotMarket;
  status: MarketStatusOverrideValue;
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface MarketStatusRepository {
  list(): Promise<MarketStatusOverride[]>;
  upsert(override: MarketStatusOverride): Promise<MarketStatusOverride>;
  remove(market: SpotMarket): Promise<void>;
}

/** One configured market plus its effective (config + override) status. */
export interface MarketStatusView {
  market: SpotMarket;
  baseAsset: string;
  quoteAsset: string;
  /** Status from config/markets.json. */
  configuredStatus: MarketStatus;
  /** What risk-service enforces right now. */
  status: MarketStatus;
  /** Present when ops changed the status at runtime. */
  override: MarketStatusOverride | null;
  priceStep: string;
  quantityStep: string;
  minQuantity: string;
  makerFeeRate: string;
  takerFeeRate: string;
  maxPriceDeviationRatio: string;
  referencePrice: string;
}

export interface SetMarketStatusCommand {
  market: SpotMarket;
  status: MarketStatusOverrideValue;
  reason?: string;
  operator?: string;
}
