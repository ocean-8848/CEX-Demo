/**
 * Read-only activity window for risk-service market surveillance (A9).
 * order-service owns trades and orders, so it serves the raw window and
 * risk-service runs the detectors.
 */
export interface SurveillanceTradeRow {
  tradeId: string;
  market: string;
  price: string;
  quantity: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerOrderId: string;
  sellerOrderId: string;
  makerOrderId: string;
  takerOrderId: string;
  executedAt: string;
}

/** A cancelled order that never filled (spoofing candidate). */
export interface SurveillanceCancelledOrderRow {
  orderId: string;
  userId: string;
  market: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  createdAt: string;
  cancelledAt: string;
}

export interface SurveillanceActivityQuery {
  since: string;
  until: string;
  market?: string;
  tradeLimit: number;
  /** Only cancelled, unfilled orders with price * quantity >= this. */
  orderMinNotional: string;
  /** Only orders cancelled within this many ms of creation. */
  orderMaxLifetimeMs: number;
  orderLimit: number;
  /** Users whose cancelled orders are skipped (e.g. market makers that requote all day). */
  orderExcludeUserIds: string[];
}

export interface SurveillanceActivity {
  since: string;
  until: string;
  trades: SurveillanceTradeRow[];
  cancelledOrders: SurveillanceCancelledOrderRow[];
  /** True when a limit cut the window short (detectors see a partial window). */
  truncated: boolean;
}

export interface SurveillanceDataSource {
  getActivity(query: SurveillanceActivityQuery): Promise<SurveillanceActivity>;
}
