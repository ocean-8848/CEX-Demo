import type { SpotMarket, TradingEvent } from "@web3-cex/domain";

export interface SettlementTradeEventStreamEntry {
  streamKey: string;
  streamEntryId: string;
  publishedAt?: string;
  market: SpotMarket;
  executionSequence: number;
  replayCursor: string;
  protocolVersion: string;
  event: TradingEvent;
  /** W3C traceparent written by the order-service publisher (when tracing is on). */
  traceparent?: string;
}

export interface SettlementTradeEventStreamHead {
  market: SpotMarket;
  streamKey: string;
  streamLength: number;
  latestStreamEntryId?: string;
  latestExecutionSequence?: number;
  latestReplayCursor?: string;
  latestPublishedAt?: string;
}

export interface SettlementOrderEventClient {
  listTradeEventStreamEntries(query: {
    market: SpotMarket;
    afterStreamEntryId?: string;
    executionSequenceFrom?: number;
    limit?: number;
    overlapCount?: number;
  }): Promise<SettlementTradeEventStreamEntry[]>;
  getTradeEventStreamHead?(
    market: SpotMarket
  ): Promise<SettlementTradeEventStreamHead | null>;
  acknowledgeTradeSettlement(command: {
    tradeId: string;
    settlementId: string;
  }): Promise<Record<string, unknown> | null>;
}
