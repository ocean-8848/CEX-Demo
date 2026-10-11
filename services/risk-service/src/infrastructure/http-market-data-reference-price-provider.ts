import { isPositiveAmount, type SpotMarket } from "@web3-cex/domain";

import type { LiveReferencePrice, ReferencePriceProvider } from "../domain/reference-price.js";

interface CachedPrice {
  value: LiveReferencePrice | null;
  expiresAt: number;
}

/**
 * Reads the live market price from market-data-service: last trade first,
 * order-book mid price second. Results are cached briefly so a burst of orders
 * costs one lookup, and any failure degrades to "no live price" (the caller
 * then falls back to the configured reference) instead of blocking trading.
 */
export class HttpMarketDataReferencePriceProvider implements ReferencePriceProvider {
  private readonly cache = new Map<SpotMarket, CachedPrice>();

  constructor(
    private readonly baseUrl: string,
    private readonly options: { cacheMs?: number; timeoutMs?: number } = {}
  ) {}

  async getReferencePrice(market: SpotMarket): Promise<LiveReferencePrice | null> {
    const cached = this.cache.get(market);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.lookup(market).catch(() => null);
    this.cache.set(market, { value, expiresAt: Date.now() + (this.options.cacheMs ?? 1000) });
    return value;
  }

  private async lookup(market: SpotMarket): Promise<LiveReferencePrice | null> {
    const query = `market=${encodeURIComponent(market)}`;
    const ticker = await this.fetchJson<{ lastPrice?: string }>(`/api/v1/market-data/ticker?${query}`);
    if (ticker?.lastPrice && isPositiveAmount(ticker.lastPrice)) {
      return { price: ticker.lastPrice, source: "last_trade" as const };
    }
    const depth = await this.fetchJson<{ bids?: Array<{ price: string }>; asks?: Array<{ price: string }> }>(
      `/api/v1/market-data/depth?${query}&limit=1`
    );
    const bid = Number(depth?.bids?.[0]?.price ?? 0);
    const ask = Number(depth?.asks?.[0]?.price ?? 0);
    if (bid > 0 && ask > 0) {
      return { price: ((bid + ask) / 2).toFixed(8), source: "mid_price" as const };
    }
    return null;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 800)
    });
    return response.ok ? ((await response.json()) as T) : null;
  }
}
