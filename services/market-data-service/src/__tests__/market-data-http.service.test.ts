import assert from "node:assert/strict";
import test from "node:test";

import { MarketDataHttpService } from "../http/market-data-http.service.js";
import type {
  MarketDataAnalyticsView,
  MarketDataAnalyticsWriter,
  MarketDataDepthSnapshot,
  MarketDataKline,
  MarketDataSnapshotStore,
  MarketDataTicker,
  MarketDataTrade
} from "../domain/types.js";

test("market-data service builds ticker and depth from order/trade snapshots", async () => {
  const snapshotStore: MarketDataSnapshotStore = {
    async getTicker() {
      return null;
    },
    async saveTicker() {},
    async getDepth() {
      return null;
    },
    async saveDepth() {},
    async getRecentTrades() {
      return null;
    },
    async saveRecentTrades() {}
  };
  const service = new MarketDataHttpService({
    orderClient: {
    async listOrders() {
      return [
        {
          orderId: "bid-1",
          market: "BTC-USDT",
          side: "buy",
          price: "65000",
          status: "accepted",
          restingQuantity: "0.01",
          updatedAt: "2026-03-08T12:00:00.000Z"
        },
        {
          orderId: "ask-1",
          market: "BTC-USDT",
          side: "sell",
          price: "65100",
          status: "partially_filled",
          restingQuantity: "0.02",
          updatedAt: "2026-03-08T12:00:00.000Z"
        }
      ];
    },
    async listTrades() {
      return [
        {
          tradeId: "trade-2",
          market: "BTC-USDT",
          price: "65100",
          quantity: "0.01",
          makerOrderId: "maker-2",
          takerOrderId: "taker-2",
          executedAt: new Date().toISOString()
        },
        {
          tradeId: "trade-1",
          market: "BTC-USDT",
          price: "65000",
          quantity: "0.02",
          makerOrderId: "maker-1",
          takerOrderId: "taker-1",
          executedAt: new Date().toISOString()
        }
      ];
    }
    },
    snapshotStore,
    analyticsWriter: {
      async recordSnapshot() {}
    }
  });

  const ticker = await service.getTicker("BTC-USDT");
  const depth = await service.getDepth("BTC-USDT", 10);

  assert.equal(ticker.lastPrice, "65100");
  assert.equal(ticker.tradeCount24h, 2);
  assert.equal(depth.bids[0]?.price, "65000");
  assert.equal(depth.asks[0]?.quantity, "0.02");
});

test("market-data service persists snapshots to cache and analytics sinks", async () => {
  const saved: {
    ticker?: MarketDataTicker;
    depth?: MarketDataDepthSnapshot;
    trades?: MarketDataTrade[];
  } = {};
  let analyticsTrigger = "";

  const snapshotStore: MarketDataSnapshotStore = {
    async getTicker() {
      return null;
    },
    async saveTicker(ticker) {
      saved.ticker = ticker;
    },
    async getDepth() {
      return null;
    },
    async saveDepth(depth) {
      saved.depth = depth;
    },
    async getRecentTrades() {
      return null;
    },
    async saveRecentTrades(_market, trades) {
      saved.trades = trades;
    }
  };
  const analyticsWriter: MarketDataAnalyticsWriter = {
    async recordSnapshot(params) {
      analyticsTrigger = params.trigger;
    }
  };

  const service = new MarketDataHttpService({
    orderClient: {
      async listOrders() {
        return [];
      },
      async listTrades() {
        return [
          {
            tradeId: "trade-1",
            market: "BTC-USDT",
            price: "65000",
            quantity: "0.02",
            makerOrderId: "maker-1",
            takerOrderId: "taker-1",
            executedAt: new Date().toISOString()
          }
        ];
      }
    },
    snapshotStore,
    analyticsWriter
  });

  const ticker = await service.getTicker("BTC-USDT");

  assert.equal(ticker.lastPrice, "65000");
  assert.equal(saved.ticker?.market, "BTC-USDT");
  assert.equal(saved.depth?.market, "BTC-USDT");
  assert.equal(saved.trades?.length, 1);
  assert.equal(analyticsTrigger, "read:ticker");
});

test("market-data service builds long-interval klines from trades", async () => {
  const service = new MarketDataHttpService({
    orderClient: {
      async listOrders() {
        return [];
      },
      async listTrades() {
        return [
          {
            tradeId: "trade-3",
            market: "BTC-USDT",
            price: "65100",
            quantity: "0.10",
            makerOrderId: "maker-3",
            takerOrderId: "taker-3",
            executedAt: "2026-03-08T12:11:00.000Z"
          },
          {
            tradeId: "trade-2",
            market: "BTC-USDT",
            price: "64900",
            quantity: "0.20",
            makerOrderId: "maker-2",
            takerOrderId: "taker-2",
            executedAt: "2026-03-08T12:08:00.000Z"
          },
          {
            tradeId: "trade-1",
            market: "BTC-USDT",
            price: "65000",
            quantity: "0.30",
            makerOrderId: "maker-1",
            takerOrderId: "taker-1",
            executedAt: "2026-03-08T12:03:00.000Z"
          }
        ];
      }
    },
    snapshotStore: {
      async getTicker() {
        return null;
      },
      async saveTicker() {},
      async getDepth() {
        return null;
      },
      async saveDepth() {},
      async getRecentTrades() {
        return null;
      },
      async saveRecentTrades() {}
    },
    analyticsWriter: {
      async recordSnapshot() {}
    }
  });

  const klines = await service.getKlines("BTC-USDT", "15m", 10);

  assert.equal(klines.length, 1);
  assert.equal(klines[0]?.openPrice, "65000");
  assert.equal(klines[0]?.closePrice, "65100");
  assert.equal(klines[0]?.tradeCount, 3);
});

test("market-data service builds analytics view from longer intervals", async () => {
  const longKlines: Record<string, MarketDataKline[]> = {
    "1h": [
      {
        market: "BTC-USDT",
        interval: "1h",
        openTime: "2026-03-08T12:00:00.000Z",
        closeTime: "2026-03-08T12:59:59.999Z",
        openPrice: "65000",
        highPrice: "65300",
        lowPrice: "64900",
        closePrice: "65250",
        baseVolume: "1.2",
        quoteVolume: "78100",
        tradeCount: 12
      }
    ],
    "4h": [
      {
        market: "BTC-USDT",
        interval: "4h",
        openTime: "2026-03-08T12:00:00.000Z",
        closeTime: "2026-03-08T15:59:59.999Z",
        openPrice: "64000",
        highPrice: "65300",
        lowPrice: "63800",
        closePrice: "65250",
        baseVolume: "4.8",
        quoteVolume: "309000",
        tradeCount: 48
      }
    ],
    "1d": [
      {
        market: "BTC-USDT",
        interval: "1d",
        openTime: "2026-03-08T00:00:00.000Z",
        closeTime: "2026-03-08T23:59:59.999Z",
        openPrice: "63000",
        highPrice: "65300",
        lowPrice: "62000",
        closePrice: "65250",
        baseVolume: "20",
        quoteVolume: "1290000",
        tradeCount: 120
      }
    ],
    "1w": [
      {
        market: "BTC-USDT",
        interval: "1w",
        openTime: "2026-03-02T00:00:00.000Z",
        closeTime: "2026-03-08T23:59:59.999Z",
        openPrice: "60000",
        highPrice: "65300",
        lowPrice: "59000",
        closePrice: "65250",
        baseVolume: "120",
        quoteVolume: "7600000",
        tradeCount: 720
      }
    ]
  };

  const analyticsWriter: MarketDataAnalyticsWriter = {
    async recordSnapshot() {},
    async listKlines({ interval }) {
      return longKlines[interval] ?? [];
    }
  };

  const service = new MarketDataHttpService({
    orderClient: {
      async listOrders() {
        return [];
      },
      async listTrades() {
        return [];
      }
    },
    analyticsWriter
  });

  const view: MarketDataAnalyticsView = await service.getAnalyticsView("BTC-USDT");

  assert.equal(view.periods.length, 4);
  assert.equal(view.periods[0]?.interval, "1h");
  assert.equal(view.periods[0]?.priceChange, "250");
  assert.equal(view.periods[3]?.interval, "1w");
});
