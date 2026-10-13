import type { OrderSide, OrderType, SpotMarket, StpMode, TimeInForce } from "@web3-cex/domain";

import type { MatchingBookSnapshot, MatchingSubmitResult } from "./types.js";

export interface RiskOrderClient {
  validateSpotOrder(command: {
    userId: string;
    accountId: string;
    market: SpotMarket;
    side: OrderSide;
    type: OrderType;
    timeInForce?: TimeInForce;
    price?: string;
    quantity: string;
    postOnly?: boolean;
    stpMode?: StpMode;
    triggerPrice?: string;
  }): Promise<{
    market: SpotMarket;
    baseAsset: string;
    quoteAsset: string;
    lockAssetCode: string;
    lockAmount: string;
    feeRate: string;
    timeInForce: TimeInForce;
  }>;
}

export interface LedgerOrderClient {
  freezeBalance(command: {
    accountId: string;
    assetCode: string;
    amount: string;
    referenceType: string;
    referenceId: string;
  }): Promise<Record<string, unknown>>;
  releaseBalance(command: {
    accountId: string;
    assetCode: string;
    referenceType: string;
    referenceId: string;
    amount?: string;
  }): Promise<Record<string, unknown>>;
}

export interface SettlementOrderClient {
  settleTrade(command: {
    tradeId: string;
    market: SpotMarket;
    price: string;
    quantity: string;
    buyerOrderId: string;
    sellerOrderId: string;
    buyerUserId: string;
    sellerUserId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    sellerFeeRate: string;
    buyerFeeRate?: string;
    sellerFeeTier?: string;
    buyerFeeTier?: string;
    executionId?: string;
    executionBatchId?: string;
    executionSequence?: number;
    executionBatchSequence?: number;
    replayCursor?: string;
    protocolVersion?: string;
    traceId?: string;
  }): Promise<{ settlementId: string }>;
}

export interface MatchingEngineClient {
  submitOrder(command: {
    orderId: string;
    market: SpotMarket;
    side: OrderSide;
    /** Engine order type: stop orders are submitted as limit / market once triggered. */
    type: "limit" | "market";
    timeInForce: TimeInForce;
    price?: string;
    quantity: string;
    createdAt: string;
    /** Owner (account id) for self-trade prevention. */
    ownerId?: string;
    stpMode?: StpMode;
    postOnly?: boolean;
  }): Promise<MatchingSubmitResult>;
  seedOrder(command: {
    orderId: string;
    market: SpotMarket;
    side: OrderSide;
    price: string;
    quantity: string;
    createdAt: string;
    ownerId?: string;
  }): Promise<{ outcome: "seeded"; orderId: string }>;
  cancelOrder(command: {
    orderId: string;
    market: SpotMarket;
  }): Promise<{
    outcome: "cancelled" | "not_found";
    orderId: string;
    /** Remaining quantity removed from the book (absent on older engines). */
    cancelledQuantity?: string;
  }>;
  /**
   * Empties the market's book. Sequence counters are kept unless
   * `resetSequences` is set (which is what a real engine restart looks like).
   */
  resetBook(command: {
    market: SpotMarket;
    resetSequences?: boolean;
  }): Promise<{ outcome: "reset"; market: SpotMarket }>;
  /** Raises the engine's sequence counters (never lowers them). */
  restoreSequences?(command: {
    market: SpotMarket;
    nextExecutionSequence: number;
    nextBatchSequence: number;
  }): Promise<{ nextExecutionSequence: number; nextBatchSequence: number }>;
  getBookSnapshot(command: {
    market: SpotMarket;
    limit?: number;
  }): Promise<MatchingBookSnapshot>;
}
