import type { OrderSide, OrderType, SpotMarket, TimeInForce } from "@web3-cex/domain";

import type { MarketStatusOverrideValue } from "../domain/market-status.js";

export interface ValidateSpotOrderRiskRequestDto {
  userId: string;
  accountId: string;
  market: SpotMarket;
  side: OrderSide;
  type: OrderType;
  timeInForce?: TimeInForce;
  price?: string;
  quantity: string;
  referencePrice?: string;
}

export interface SetMarketStatusRequestDto {
  status: MarketStatusOverrideValue;
  reason?: string;
  operator?: string;
}
