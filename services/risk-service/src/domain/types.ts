import type {
  AssetCode,
  OrderSide,
  OrderType,
  SpotMarket,
  StpMode,
  TimeInForce
} from "@web3-cex/domain";

export interface ValidateSpotOrderRiskCommand {
  userId: string;
  accountId: string;
  market: SpotMarket;
  side: OrderSide;
  type: OrderType;
  timeInForce?: TimeInForce;
  price?: string;
  quantity: string;
  referencePrice?: string;
  /** Maker-only limit order: only valid for GTC limit orders. */
  postOnly?: boolean;
  stpMode?: StpMode;
  /** stop_limit / stop_market only. */
  triggerPrice?: string;
}

export interface RiskCheckResult {
  name: string;
  status: "passed" | "failed";
  detail: string;
}

export interface SpotOrderRiskDecision {
  valid: true;
  market: SpotMarket;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  baseAsset: AssetCode;
  quoteAsset: AssetCode;
  lockAssetCode: AssetCode;
  lockAmount: string;
  feeRate: string;
  /** Price the deviation guard and market-buy lock were computed against. */
  referencePrice?: string;
  referencePriceSource?: "request" | "last_trade" | "mid_price" | "configured";
  triggerPrice?: string;
  checks: RiskCheckResult[];
}

export interface LedgerBalanceSnapshot {
  accountId: string;
  assetCode: AssetCode;
  available: string;
  locked: string;
}
