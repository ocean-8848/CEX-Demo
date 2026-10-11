import {
  isSpotMarket,
  listSpotMarkets,
  addAmounts,
  compareAmounts,
  multiplyAmounts,
  subtractAmounts,
  type SpotMarket,
  type TradingEvent
} from "@web3-cex/domain";
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from "@nestjs/common";
import type { RedisClientType } from "redis";

import type {
  MarketDataAnalyticsPeriodView,
  MarketDataAnalyticsView,
  MarketDataAnalyticsWriter,
  MarketDataDepthLevel,
  MarketDataDepthSnapshot,
  MarketDataEventSubscriber,
  MarketDataKline,
  MarketDataKlineInterval,
  MarketDataOrderClient,
  MarketDataSnapshotStore,
  MarketDataTicker,
  MarketDataTrade
} from "../domain/types.js";
import { HttpOrderClient } from "../infrastructure/http-order-client.js";
import { ClickHouseMarketDataAnalyticsWriter } from "../infrastructure/market-data-clickhouse.js";
import {
  createMarketDataRedisClient,
  RedisMarketDataEventSubscriber,
  RedisMarketDataSnapshotStore
} from "../infrastructure/market-data-redis.js";

type MarketDataEventListener = (event: TradingEvent) => Promise<void> | void;
export const MARKET_DATA_HTTP_SERVICE_OPTIONS = Symbol("MARKET_DATA_HTTP_SERVICE_OPTIONS");

interface MarketDataHttpServiceOptions {
  orderClient?: MarketDataOrderClient;
  eventSubscriber?: MarketDataEventSubscriber;
  eventRedisClient?: RedisClientType;
  snapshotStore?: MarketDataSnapshotStore;
  snapshotRedisClient?: RedisClientType;
  analyticsWriter?: MarketDataAnalyticsWriter;
  tradeWindowMs?: number;
  depthSnapshotLimit?: number;
  tradeSnapshotLimit?: number;
}

@Injectable()
export class MarketDataHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataHttpService.name);
  private readonly orderClient: MarketDataOrderClient;
  private readonly listeners = new Set<MarketDataEventListener>();
  private readonly eventRedisClient?: RedisClientType;
  private readonly eventSubscriber?: MarketDataEventSubscriber;
  private readonly snapshotRedisClient?: RedisClientType;
  private readonly snapshotStore?: MarketDataSnapshotStore;
  private readonly analyticsWriter?: MarketDataAnalyticsWriter;
  private readonly tradeWindowMs: number;
  private readonly depthSnapshotLimit: number;
  private readonly tradeSnapshotLimit: number;
  private readonly analyticsTradeLimit: number;

  constructor(
    @Optional()
    @Inject(MARKET_DATA_HTTP_SERVICE_OPTIONS)
    options: MarketDataHttpServiceOptions = {}
  ) {
    this.orderClient =
      options.orderClient ??
      new HttpOrderClient(
        process.env.MARKET_DATA_ORDER_SERVICE_URL ?? "http://127.0.0.1:3009"
      );
    this.tradeWindowMs =
      options.tradeWindowMs ??
      Number(process.env.MARKET_DATA_TICKER_WINDOW_MS ?? `${24 * 60 * 60 * 1000}`);
    this.depthSnapshotLimit =
      options.depthSnapshotLimit ?? Number(process.env.MARKET_DATA_DEPTH_SNAPSHOT_LIMIT ?? "100");
    this.tradeSnapshotLimit =
      options.tradeSnapshotLimit ?? Number(process.env.MARKET_DATA_TRADE_SNAPSHOT_LIMIT ?? "200");
    this.analyticsTradeLimit = Number(process.env.MARKET_DATA_ANALYTICS_TRADE_LIMIT ?? "1000");

    if (options.eventSubscriber) {
      this.eventSubscriber = options.eventSubscriber;
      this.eventRedisClient = options.eventRedisClient;
    } else if ((process.env.MARKET_DATA_EVENT_SUBSCRIBER ?? "redis") === "redis") {
      this.eventRedisClient = createMarketDataRedisClient(
        process.env.MARKET_DATA_REDIS_URL ?? "redis://127.0.0.1:6379"
      );
      this.eventSubscriber = new RedisMarketDataEventSubscriber(
        this.eventRedisClient,
        process.env.MARKET_DATA_EVENT_CHANNEL ?? "web3-cex:trading.events"
      );
    }

    if (options.snapshotStore) {
      this.snapshotStore = options.snapshotStore;
      this.snapshotRedisClient = options.snapshotRedisClient;
    } else if ((process.env.MARKET_DATA_SNAPSHOT_STORE ?? "redis") === "redis") {
      this.snapshotRedisClient = createMarketDataRedisClient(
        process.env.MARKET_DATA_REDIS_URL ?? "redis://127.0.0.1:6379"
      );
      this.snapshotStore = new RedisMarketDataSnapshotStore(
        this.snapshotRedisClient,
        process.env.MARKET_DATA_REDIS_PREFIX ?? "web3-cex:market-data",
        Number(process.env.MARKET_DATA_SNAPSHOT_TTL_SECONDS ?? "300")
      );
    }

    if (options.analyticsWriter) {
      this.analyticsWriter = options.analyticsWriter;
    } else if ((process.env.MARKET_DATA_ANALYTICS_SINK ?? "clickhouse") === "clickhouse") {
      this.analyticsWriter = new ClickHouseMarketDataAnalyticsWriter(
        process.env.MARKET_DATA_CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
        {
          database: process.env.MARKET_DATA_CLICKHOUSE_DATABASE ?? "default",
          username: process.env.MARKET_DATA_CLICKHOUSE_USER,
          password: process.env.MARKET_DATA_CLICKHOUSE_PASSWORD,
          timeoutMs: Number(process.env.MARKET_DATA_CLICKHOUSE_TIMEOUT_MS ?? "5000")
        }
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.eventRedisClient && !this.eventRedisClient.isOpen) {
      await this.eventRedisClient.connect();
    }

    if (this.snapshotRedisClient && !this.snapshotRedisClient.isOpen) {
      await this.snapshotRedisClient.connect();
    }

    if (this.eventSubscriber) {
      await this.eventSubscriber.subscribe(async (event) => {
        await this.refreshSnapshotsForMarket(event.payload.market, event.eventType);
        for (const listener of this.listeners) {
          await listener(event);
        }
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.eventSubscriber?.close();
    await this.snapshotStore?.close?.();
    await this.analyticsWriter?.close?.();
  }

  onTradingEvent(listener: MarketDataEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listTickers(): Promise<MarketDataTicker[]> {
    const markets = listSpotMarkets();
    return Promise.all(markets.map((market) => this.getTicker(market)));
  }

  async getTicker(market: SpotMarket): Promise<MarketDataTicker> {
    this.assertMarket(market);
    const snapshot = await this.loadOrRefreshSnapshot(market, "read:ticker");
    return snapshot.ticker;
  }

  async getDepth(market: SpotMarket, limit = 20): Promise<MarketDataDepthSnapshot> {
    this.assertMarket(market);
    const snapshot = await this.loadOrRefreshSnapshot(market, "read:depth");
    return {
      ...snapshot.depth,
      bids: snapshot.depth.bids.slice(0, limit),
      asks: snapshot.depth.asks.slice(0, limit)
    };
  }

  async getRecentTrades(market: SpotMarket, limit = 50): Promise<MarketDataTrade[]> {
    this.assertMarket(market);
    const snapshot = await this.loadOrRefreshSnapshot(market, "read:trades");
    return snapshot.trades.slice(0, limit);
  }

  async getKlines(
    market: SpotMarket,
    interval: MarketDataKlineInterval,
    limit = 200
  ): Promise<MarketDataKline[]> {
    this.assertMarket(market);
    const normalizedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);

    if (this.analyticsWriter?.listKlines) {
      try {
        return await this.analyticsWriter.listKlines({
          market,
          interval,
          limit: normalizedLimit
        });
      } catch (error) {
        this.logger.warn(`market-data analytics read degraded: ${readErrorMessage(error)}`);
      }
    }

    const trades = await this.loadTrades(market, Math.max(this.analyticsTradeLimit, normalizedLimit * 20));
    return buildKlinesFromTrades(
      trades,
      interval,
      normalizedLimit
    );
  }

  async getAnalyticsView(market: SpotMarket): Promise<MarketDataAnalyticsView> {
    this.assertMarket(market);
    const periods = await Promise.all(
      (["1h", "4h", "1d", "1w"] as const).map(async (interval) => {
        const [latest] = await this.getKlines(market, interval, 1);
        return latest ? toAnalyticsPeriod(latest) : emptyAnalyticsPeriod(interval);
      })
    );

    return {
      market,
      generatedAt: new Date().toISOString(),
      periods
    };
  }

  private async loadOrRefreshSnapshot(
    market: SpotMarket,
    trigger: string
  ): Promise<{
    ticker: MarketDataTicker;
    depth: MarketDataDepthSnapshot;
    trades: MarketDataTrade[];
  }> {
    const cached = await this.readSnapshotStore(market);
    if (cached) {
      return cached;
    }

    return this.refreshSnapshotsForMarket(market, trigger);
  }

  private async refreshSnapshotsForMarket(
    market: SpotMarket,
    trigger: string
  ): Promise<{
    ticker: MarketDataTicker;
    depth: MarketDataDepthSnapshot;
    trades: MarketDataTrade[];
  }> {
    const capturedAt = new Date().toISOString();
    const trades = await this.loadTrades(market, this.tradeSnapshotLimit);
    const depth = await this.buildDepthSnapshot(market, this.depthSnapshotLimit);
    const ticker = buildTickerSnapshot(market, trades, this.filterRecentTrades(trades), capturedAt);

    await this.persistSnapshot({
      market,
      ticker,
      depth,
      trades,
      trigger,
      capturedAt
    });

    return {
      ticker,
      depth,
      trades
    };
  }

  private async buildDepthSnapshot(
    market: SpotMarket,
    limit: number
  ): Promise<MarketDataDepthSnapshot> {
    const orders = await this.orderClient.listOrders({
      market,
      limit: 500,
      offset: 0
    });

    const openOrders = orders.filter(
      (order) =>
        (order.status === "accepted" || order.status === "partially_filled") &&
        compareAmounts(order.restingQuantity, "0") > 0
    );

    return {
      market,
      bids: aggregateLevels(openOrders, "buy").slice(0, limit),
      asks: aggregateLevels(openOrders, "sell").slice(0, limit),
      updatedAt: new Date().toISOString()
    };
  }

  private async loadTrades(market: SpotMarket, limit: number): Promise<MarketDataTrade[]> {
    return this.orderClient.listTrades({
      market,
      limit,
      offset: 0
    });
  }

  private filterRecentTrades(trades: MarketDataTrade[]): MarketDataTrade[] {
    const threshold = Date.now() - this.tradeWindowMs;
    return trades.filter((trade) => new Date(trade.executedAt).getTime() >= threshold);
  }

  private assertMarket(market: SpotMarket): void {
    if (!isSpotMarket(market)) {
      throw new Error(`Unsupported market ${market}`);
    }
  }

  private async readSnapshotStore(
    market: SpotMarket
  ): Promise<
    | {
        ticker: MarketDataTicker;
        depth: MarketDataDepthSnapshot;
        trades: MarketDataTrade[];
      }
    | null
  > {
    if (!this.snapshotStore) {
      return null;
    }

    const [ticker, depth, trades] = await Promise.all([
      this.snapshotStore.getTicker(market),
      this.snapshotStore.getDepth(market),
      this.snapshotStore.getRecentTrades(market)
    ]);

    if (!ticker || !depth || !trades) {
      return null;
    }

    return {
      ticker,
      depth,
      trades
    };
  }

  private async persistSnapshot(params: {
    market: SpotMarket;
    ticker: MarketDataTicker;
    depth: MarketDataDepthSnapshot;
    trades: MarketDataTrade[];
    trigger: string;
    capturedAt: string;
  }): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    if (this.snapshotStore) {
      tasks.push(
        Promise.all([
          this.snapshotStore.saveTicker(params.ticker),
          this.snapshotStore.saveDepth(params.depth),
          this.snapshotStore.saveRecentTrades(params.market, params.trades)
        ]).then(() => undefined)
      );
    }

    if (this.analyticsWriter) {
      tasks.push(this.analyticsWriter.recordSnapshot(params));
    }

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn(`market-data persistence degraded: ${readErrorMessage(result.reason)}`);
      }
    }
  }
}

function buildTickerSnapshot(
  market: SpotMarket,
  trades: MarketDataTrade[],
  recentTrades: MarketDataTrade[],
  updatedAt: string
): MarketDataTicker {
  const lastTrade = trades[0];
  const openTrade = recentTrades[recentTrades.length - 1];

  if (!lastTrade || recentTrades.length === 0) {
    return {
      market,
      lastPrice: "0",
      openPrice24h: "0",
      highPrice24h: "0",
      lowPrice24h: "0",
      priceChange24h: "0",
      volume24h: "0",
      quoteVolume24h: "0",
      tradeCount24h: 0,
      updatedAt
    };
  }

  let highPrice = recentTrades[0]!.price;
  let lowPrice = recentTrades[0]!.price;
  let volume = "0";
  let quoteVolume = "0";

  for (const trade of recentTrades) {
    if (compareAmounts(trade.price, highPrice) > 0) {
      highPrice = trade.price;
    }
    if (compareAmounts(trade.price, lowPrice) < 0) {
      lowPrice = trade.price;
    }

    volume = addAmounts(volume, trade.quantity);
    quoteVolume = addAmounts(quoteVolume, multiplyAmounts(trade.price, trade.quantity));
  }

  return {
    market,
    lastPrice: lastTrade.price,
    openPrice24h: openTrade?.price ?? lastTrade.price,
    highPrice24h: highPrice,
    lowPrice24h: lowPrice,
    priceChange24h: subtractAmounts(lastTrade.price, openTrade?.price ?? lastTrade.price),
    volume24h: volume,
    quoteVolume24h: quoteVolume,
    tradeCount24h: recentTrades.length,
    updatedAt
  };
}

function aggregateLevels(
  orders: Array<{
    side: "buy" | "sell";
    price: string;
    restingQuantity: string;
  }>,
  side: "buy" | "sell"
): MarketDataDepthLevel[] {
  const levels = new Map<string, MarketDataDepthLevel>();

  for (const order of orders) {
    if (order.side !== side) {
      continue;
    }

    const existing = levels.get(order.price) ?? {
      price: order.price,
      quantity: "0",
      orderCount: 0
    };
    existing.quantity = addAmounts(existing.quantity, order.restingQuantity);
    existing.orderCount += 1;
    levels.set(order.price, existing);
  }

  return [...levels.values()].sort((left, right) => {
    return side === "buy"
      ? compareAmounts(right.price, left.price)
      : compareAmounts(left.price, right.price);
  });
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown market-data error";
}

function buildKlinesFromTrades(
  trades: MarketDataTrade[],
  interval: MarketDataKlineInterval,
  limit: number
): MarketDataKline[] {
  const buckets = new Map<string, MarketDataKline>();
  const sortedTrades = [...trades].sort((left, right) => left.executedAt.localeCompare(right.executedAt));

  for (const trade of sortedTrades) {
    const openTime = getIntervalOpenTime(trade.executedAt, interval);
    const closeTime = new Date(new Date(openTime).getTime() + intervalToMs(interval) - 1).toISOString();
    const existing = buckets.get(openTime);

    if (!existing) {
      buckets.set(openTime, {
        market: trade.market as SpotMarket,
        interval,
        openTime,
        closeTime,
        openPrice: trade.price,
        highPrice: trade.price,
        lowPrice: trade.price,
        closePrice: trade.price,
        baseVolume: trade.quantity,
        quoteVolume: multiplyAmounts(trade.price, trade.quantity),
        tradeCount: 1
      });
      continue;
    }

    existing.closePrice = trade.price;
    if (compareAmounts(trade.price, existing.highPrice) > 0) {
      existing.highPrice = trade.price;
    }
    if (compareAmounts(trade.price, existing.lowPrice) < 0) {
      existing.lowPrice = trade.price;
    }
    existing.baseVolume = addAmounts(existing.baseVolume, trade.quantity);
    existing.quoteVolume = addAmounts(existing.quoteVolume, multiplyAmounts(trade.price, trade.quantity));
    existing.tradeCount += 1;
  }

  return [...buckets.values()]
    .sort((left, right) => right.openTime.localeCompare(left.openTime))
    .slice(0, limit);
}

function getIntervalOpenTime(timestamp: string, interval: MarketDataKlineInterval): string {
  const date = new Date(timestamp);
  const normalized = new Date(date);

  normalized.setUTCSeconds(0, 0);

  switch (interval) {
    case "1m":
      break;
    case "5m":
      normalized.setUTCMinutes(Math.floor(normalized.getUTCMinutes() / 5) * 5);
      break;
    case "15m":
      normalized.setUTCMinutes(Math.floor(normalized.getUTCMinutes() / 15) * 15);
      break;
    case "1h":
      normalized.setUTCMinutes(0);
      break;
    case "4h":
      normalized.setUTCMinutes(0);
      normalized.setUTCHours(Math.floor(normalized.getUTCHours() / 4) * 4);
      break;
    case "1d":
      normalized.setUTCMinutes(0);
      normalized.setUTCHours(0);
      break;
    case "1w": {
      normalized.setUTCMinutes(0);
      normalized.setUTCHours(0);
      const day = normalized.getUTCDay();
      const shift = day === 0 ? 6 : day - 1;
      normalized.setUTCDate(normalized.getUTCDate() - shift);
      break;
    }
  }

  return normalized.toISOString();
}

function intervalToMs(interval: MarketDataKlineInterval): number {
  switch (interval) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "4h":
      return 4 * 60 * 60_000;
    case "1d":
      return 24 * 60 * 60_000;
    case "1w":
      return 7 * 24 * 60 * 60_000;
  }
}

function toAnalyticsPeriod(
  kline: MarketDataKline
): MarketDataAnalyticsPeriodView {
  return {
    interval: kline.interval as MarketDataAnalyticsPeriodView["interval"],
    openTime: kline.openTime,
    closeTime: kline.closeTime,
    openPrice: kline.openPrice,
    highPrice: kline.highPrice,
    lowPrice: kline.lowPrice,
    closePrice: kline.closePrice,
    baseVolume: kline.baseVolume,
    quoteVolume: kline.quoteVolume,
    tradeCount: kline.tradeCount,
    priceChange: subtractAmounts(kline.closePrice, kline.openPrice)
  };
}

function emptyAnalyticsPeriod(
  interval: MarketDataAnalyticsPeriodView["interval"]
): MarketDataAnalyticsPeriodView {
  return {
    interval,
    openTime: new Date(0).toISOString(),
    closeTime: new Date(0).toISOString(),
    openPrice: "0",
    highPrice: "0",
    lowPrice: "0",
    closePrice: "0",
    baseVolume: "0",
    quoteVolume: "0",
    tradeCount: 0,
    priceChange: "0"
  };
}
