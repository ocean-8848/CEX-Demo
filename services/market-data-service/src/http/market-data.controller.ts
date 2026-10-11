import { Controller, Get, Query } from "@nestjs/common";
import type { SpotMarket } from "@web3-cex/domain";

import { MarketDataHttpService } from "./market-data-http.service.js";
import type { MarketDataKlineInterval } from "../domain/types.js";

@Controller("/api/v1/market-data")
export class MarketDataController {
  constructor(private readonly marketDataHttpService: MarketDataHttpService) {}

  @Get("/tickers")
  async listTickers() {
    return this.marketDataHttpService.listTickers();
  }

  @Get("/ticker")
  async getTicker(@Query("market") market: SpotMarket) {
    return this.marketDataHttpService.getTicker(market);
  }

  @Get("/depth")
  async getDepth(@Query("market") market: SpotMarket, @Query("limit") limit?: string) {
    return this.marketDataHttpService.getDepth(market, parseLimit(limit, 20));
  }

  @Get("/trades")
  async getRecentTrades(@Query("market") market: SpotMarket, @Query("limit") limit?: string) {
    return this.marketDataHttpService.getRecentTrades(market, parseLimit(limit, 50));
  }

  @Get("/klines")
  async getKlines(
    @Query("market") market: SpotMarket,
    @Query("interval") interval?: string,
    @Query("limit") limit?: string
  ) {
    return this.marketDataHttpService.getKlines(
      market,
      parseInterval(interval),
      parseLimit(limit, 200)
    );
  }

  @Get("/analytics")
  async getAnalytics(@Query("market") market: SpotMarket) {
    return this.marketDataHttpService.getAnalyticsView(market);
  }
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function parseInterval(value: string | undefined): MarketDataKlineInterval {
  switch (value) {
    case "1m":
    case "5m":
    case "15m":
    case "1h":
    case "4h":
    case "1d":
    case "1w":
      return value;
    default:
      return "1m";
  }
}
