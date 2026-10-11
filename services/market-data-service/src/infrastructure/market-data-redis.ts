import type { TradingEvent } from "@web3-cex/domain";
import { createClient, type RedisClientType } from "redis";

import type {
  MarketDataDepthSnapshot,
  MarketDataEventSubscriber,
  MarketDataSnapshotStore,
  MarketDataTicker,
  MarketDataTrade
} from "../domain/types.js";

export function createMarketDataRedisClient(url: string): RedisClientType {
  return createClient({ url });
}

export class RedisMarketDataEventSubscriber implements MarketDataEventSubscriber {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly channel: string
  ) {}

  async subscribe(listener: (event: TradingEvent) => Promise<void> | void): Promise<void> {
    await this.redisClient.subscribe(this.channel, async (message) => {
      const parsed = JSON.parse(message) as TradingEvent;
      await listener(parsed);
    });
  }

  async close(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.quit();
    }
  }
}

export class RedisMarketDataSnapshotStore implements MarketDataSnapshotStore {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly prefix: string,
    private readonly ttlSeconds: number
  ) {}

  async getTicker(market: string): Promise<MarketDataTicker | null> {
    return this.readJson<MarketDataTicker>(this.key("ticker", market));
  }

  async saveTicker(ticker: MarketDataTicker): Promise<void> {
    await this.writeJson(this.key("ticker", ticker.market), ticker);
  }

  async getDepth(market: string): Promise<MarketDataDepthSnapshot | null> {
    return this.readJson<MarketDataDepthSnapshot>(this.key("depth", market));
  }

  async saveDepth(snapshot: MarketDataDepthSnapshot): Promise<void> {
    await this.writeJson(this.key("depth", snapshot.market), snapshot);
  }

  async getRecentTrades(market: string): Promise<MarketDataTrade[] | null> {
    return this.readJson<MarketDataTrade[]>(this.key("trades", market));
  }

  async saveRecentTrades(market: string, trades: MarketDataTrade[]): Promise<void> {
    await this.writeJson(this.key("trades", market), trades);
  }

  async close(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.quit();
    }
  }

  private key(kind: "ticker" | "depth" | "trades", market: string): string {
    return `${this.prefix}:${kind}:${market}`;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const value = await this.redisClient.get(key);
    if (!value) {
      return null;
    }
    return JSON.parse(value) as T;
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    await this.redisClient.set(key, JSON.stringify(value), {
      EX: this.ttlSeconds
    });
  }
}
