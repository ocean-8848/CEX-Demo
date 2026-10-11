import type { OrderSide, SpotMarket, Trade, TradingEvent } from "@web3-cex/domain";

export interface MarketDataTicker {
  market: SpotMarket;
  lastPrice: string;
  openPrice24h: string;
  highPrice24h: string;
  lowPrice24h: string;
  priceChange24h: string;
  volume24h: string;
  quoteVolume24h: string;
  tradeCount24h: number;
  updatedAt: string;
}

export interface MarketDataDepthLevel {
  price: string;
  quantity: string;
  orderCount: number;
}

export interface MarketDataDepthSnapshot {
  market: SpotMarket;
  bids: MarketDataDepthLevel[];
  asks: MarketDataDepthLevel[];
  updatedAt: string;
}

export interface MarketDataTrade extends Trade {}

export type MarketDataKlineInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export interface MarketDataKline {
  market: SpotMarket;
  interval: MarketDataKlineInterval;
  openTime: string;
  closeTime: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  baseVolume: string;
  quoteVolume: string;
  tradeCount: number;
}

export interface MarketDataAnalyticsPeriodView {
  interval: Exclude<MarketDataKlineInterval, "1m" | "5m" | "15m">;
  openTime: string;
  closeTime: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  baseVolume: string;
  quoteVolume: string;
  tradeCount: number;
  priceChange: string;
}

export interface MarketDataAnalyticsView {
  market: SpotMarket;
  generatedAt: string;
  periods: MarketDataAnalyticsPeriodView[];
}

export interface MarketDataOrderRecord {
  orderId: string;
  market: SpotMarket;
  side: OrderSide;
  price: string;
  status: string;
  restingQuantity: string;
  updatedAt: string;
}

export interface MarketDataOrderClient {
  listOrders(query: {
    market?: SpotMarket;
    limit?: number;
    offset?: number;
  }): Promise<MarketDataOrderRecord[]>;
  listTrades(query: {
    market?: SpotMarket;
    limit?: number;
    offset?: number;
  }): Promise<MarketDataTrade[]>;
}

export interface MarketDataEventSubscriber {
  subscribe(listener: (event: TradingEvent) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}

export interface MarketDataSnapshotStore {
  getTicker(market: SpotMarket): Promise<MarketDataTicker | null>;
  saveTicker(ticker: MarketDataTicker): Promise<void>;
  getDepth(market: SpotMarket): Promise<MarketDataDepthSnapshot | null>;
  saveDepth(snapshot: MarketDataDepthSnapshot): Promise<void>;
  getRecentTrades(market: SpotMarket): Promise<MarketDataTrade[] | null>;
  saveRecentTrades(market: SpotMarket, trades: MarketDataTrade[]): Promise<void>;
  close?(): Promise<void>;
}

export interface MarketDataAnalyticsWriter {
  recordSnapshot(params: {
    market: SpotMarket;
    ticker: MarketDataTicker;
    depth: MarketDataDepthSnapshot;
    trades: MarketDataTrade[];
    trigger: string;
    capturedAt: string;
  }): Promise<void>;
  listKlines?(params: {
    market: SpotMarket;
    interval: MarketDataKlineInterval;
    limit: number;
  }): Promise<MarketDataKline[]>;
  close?(): Promise<void>;
}
