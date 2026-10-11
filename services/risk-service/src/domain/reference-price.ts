import type { SpotMarket } from "@web3-cex/domain";

/** Where the reference price used by the deviation guard came from. */
export type ReferencePriceSource = "request" | "last_trade" | "mid_price" | "configured";

export interface ReferencePrice {
  price: string;
  source: ReferencePriceSource;
}

export interface LiveReferencePrice extends ReferencePrice {
  source: "last_trade" | "mid_price";
}

/** Live market price lookup; returns null when the market has no usable price. */
export interface ReferencePriceProvider {
  getReferencePrice(market: SpotMarket): Promise<LiveReferencePrice | null>;
}
