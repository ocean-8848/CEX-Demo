import type {
  MarketDataAnalyticsWriter,
  MarketDataDepthSnapshot,
  MarketDataKline,
  MarketDataKlineInterval,
  MarketDataTicker,
  MarketDataTrade
} from "../domain/types.js";

interface ClickHouseWriterOptions {
  database?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export class ClickHouseMarketDataAnalyticsWriter implements MarketDataAnalyticsWriter {
  private readonly database: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private initialized = false;

  constructor(
    private readonly baseUrl: string,
    options: ClickHouseWriterOptions = {}
  ) {
    this.database = options.database ?? "default";
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async recordSnapshot(params: {
    market: string;
    ticker: MarketDataTicker;
    depth: MarketDataDepthSnapshot;
    trades: MarketDataTrade[];
    trigger: string;
    capturedAt: string;
  }): Promise<void> {
    await this.ensureTables();

    await this.insertJsonEachRow(
      `insert into market_data_ticker_snapshots format JSONEachRow`,
      [
        {
          market: params.market,
          trigger: params.trigger,
          captured_at: params.capturedAt,
          updated_at: params.ticker.updatedAt,
          last_price: params.ticker.lastPrice,
          open_price_24h: params.ticker.openPrice24h,
          high_price_24h: params.ticker.highPrice24h,
          low_price_24h: params.ticker.lowPrice24h,
          price_change_24h: params.ticker.priceChange24h,
          volume_24h: params.ticker.volume24h,
          quote_volume_24h: params.ticker.quoteVolume24h,
          trade_count_24h: params.ticker.tradeCount24h
        }
      ]
    );

    const depthRows = [
      ...params.depth.bids.map((level) => ({
        market: params.market,
        side: "buy",
        trigger: params.trigger,
        captured_at: params.capturedAt,
        updated_at: params.depth.updatedAt,
        price: level.price,
        quantity: level.quantity,
        order_count: level.orderCount
      })),
      ...params.depth.asks.map((level) => ({
        market: params.market,
        side: "sell",
        trigger: params.trigger,
        captured_at: params.capturedAt,
        updated_at: params.depth.updatedAt,
        price: level.price,
        quantity: level.quantity,
        order_count: level.orderCount
      }))
    ];

    if (depthRows.length > 0) {
      await this.insertJsonEachRow(
        `insert into market_data_depth_snapshots format JSONEachRow`,
        depthRows
      );
    }

    if (params.trades.length > 0) {
      await this.insertJsonEachRow(
        `insert into market_data_trade_snapshots format JSONEachRow`,
        params.trades.map((trade) => ({
          trade_id: trade.tradeId,
          market: trade.market,
          trigger: params.trigger,
          captured_at: params.capturedAt,
          executed_at: trade.executedAt,
          price: trade.price,
          quantity: trade.quantity,
          maker_order_id: trade.makerOrderId,
          taker_order_id: trade.takerOrderId
        }))
      );
    }
  }

  async listKlines(params: {
    market: string;
    interval: MarketDataKlineInterval;
    limit: number;
  }): Promise<MarketDataKline[]> {
    await this.ensureTables();

    const query = `
      select
        market,
        interval,
        toString(open_time) as open_time,
        toString(open_time + interval_length_ms / 1000 - 1) as close_time,
        toString(round(argMinMerge(open_price), 18)) as open_price,
        toString(round(maxMerge(high_price), 18)) as high_price,
        toString(round(minMerge(low_price), 18)) as low_price,
        toString(round(argMaxMerge(close_price), 18)) as close_price,
        toString(round(sumMerge(base_volume), 18)) as base_volume,
        toString(round(sumMerge(quote_volume), 18)) as quote_volume,
        toUInt32(countMerge(trade_count)) as trade_count
      from market_data_kline_1m
      where market = {market:String}
        and interval = {interval:String}
      group by market, interval, open_time, interval_length_ms
      order by open_time desc
      limit {limit:UInt32}
      format JSON`;

    const rows = await this.executeJsonQuery<{
      market: string;
      interval: MarketDataKlineInterval;
      open_time: string;
      close_time: string;
      open_price: string;
      high_price: string;
      low_price: string;
      close_price: string;
      base_volume: string;
      quote_volume: string;
      trade_count: number;
    }>(query, {
      market: params.market,
      interval: params.interval,
      limit: params.limit
    });

    return rows.map((row) => ({
      market: row.market as MarketDataKline["market"],
      interval: row.interval,
      openTime: new Date(row.open_time).toISOString(),
      closeTime: new Date(row.close_time).toISOString(),
      openPrice: row.open_price,
      highPrice: row.high_price,
      lowPrice: row.low_price,
      closePrice: row.close_price,
      baseVolume: row.base_volume,
      quoteVolume: row.quote_volume,
      tradeCount: Number(row.trade_count)
    }));
  }

  private async ensureTables(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.executeQuery(
      `create table if not exists market_data_ticker_snapshots
       (
         market String,
         trigger String,
         captured_at DateTime64(3),
         updated_at DateTime64(3),
         last_price String,
         open_price_24h String,
         high_price_24h String,
         low_price_24h String,
         price_change_24h String,
         volume_24h String,
         quote_volume_24h String,
         trade_count_24h UInt32
       )
       engine = MergeTree
       order by (market, captured_at)`
    );
    await this.executeQuery(
      `create table if not exists market_data_depth_snapshots
       (
         market String,
         side String,
         trigger String,
         captured_at DateTime64(3),
         updated_at DateTime64(3),
         price String,
         quantity String,
         order_count UInt32
       )
       engine = MergeTree
       order by (market, side, captured_at, price)`
    );
    await this.executeQuery(
      `create table if not exists market_data_trade_snapshots
       (
         trade_id String,
         market String,
         trigger String,
         captured_at DateTime64(3),
         executed_at DateTime64(3),
         price String,
         quantity String,
         maker_order_id String,
         taker_order_id String
       )
       engine = MergeTree
       order by (market, executed_at, trade_id)`
    );
    await this.executeQuery(
      `create table if not exists market_data_kline_1m
       (
         market String,
         interval String,
         open_time DateTime,
         interval_length_ms UInt32,
         close_price AggregateFunction(argMax, Float64, DateTime64(3)),
         open_price AggregateFunction(argMin, Float64, DateTime64(3)),
         high_price AggregateFunction(max, Float64),
         low_price AggregateFunction(min, Float64),
         base_volume AggregateFunction(sum, Float64),
         quote_volume AggregateFunction(sum, Float64),
         trade_count AggregateFunction(count, UInt8)
       )
       engine = AggregatingMergeTree
       order by (market, interval, open_time)`
    );
    await this.executeQuery(
      `alter table market_data_kline_1m
       add column if not exists interval_length_ms UInt32 default 60000`
    );
    await this.executeQuery(
      `create materialized view if not exists market_data_trade_snapshots_to_kline_1m
       to market_data_kline_1m
       as
       select
         market,
         '1m' as interval,
         toStartOfMinute(executed_at) as open_time,
         toUInt32(60000) as interval_length_ms,
         argMaxState(toFloat64(price), executed_at) as close_price,
         argMinState(toFloat64(price), executed_at) as open_price,
         maxState(toFloat64(price)) as high_price,
         minState(toFloat64(price)) as low_price,
         sumState(toFloat64(quantity)) as base_volume,
         sumState(toFloat64(price) * toFloat64(quantity)) as quote_volume,
         countState() as trade_count
       from market_data_trade_snapshots
       group by market, interval, open_time`
    );
    await this.executeQuery(buildKlineMaterializedViewSql("5m", "toStartOfInterval(executed_at, toIntervalMinute(5))", 300000));
    await this.executeQuery(buildKlineMaterializedViewSql("15m", "toStartOfInterval(executed_at, toIntervalMinute(15))", 900000));
    await this.executeQuery(buildKlineMaterializedViewSql("1h", "toStartOfHour(executed_at)", 3600000));
    await this.executeQuery(buildKlineMaterializedViewSql("4h", "toStartOfInterval(executed_at, toIntervalHour(4))", 14400000));
    await this.executeQuery(buildKlineMaterializedViewSql("1d", "toStartOfDay(executed_at)", 86400000));
    await this.executeQuery(buildKlineMaterializedViewSql("1w", "toStartOfInterval(executed_at, toIntervalDay(7))", 604800000));

    this.initialized = true;
  }

  private async insertJsonEachRow(query: string, rows: Record<string, unknown>[]): Promise<void> {
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await this.executeQuery(query, body);
  }

  private async executeQuery(query: string, body = ""): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.buildUrl(query), {
        method: "POST",
        headers: this.buildHeaders(),
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ClickHouse rejected request: ${text || response.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeJsonQuery<T>(
    query: string,
    params: Record<string, string | number>
  ): Promise<T[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.buildUrl(query, params), {
        method: "POST",
        headers: this.buildHeaders(),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ClickHouse rejected request: ${text || response.statusText}`);
      }

      const payload = (await response.json()) as { data?: T[] };
      return payload.data ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(query: string, params: Record<string, string | number> = {}): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set("database", this.database);
    url.searchParams.set("query", query);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(`param_${key}`, String(value));
    }
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8"
    };

    if (this.username) {
      headers["x-clickhouse-user"] = this.username;
    }
    if (this.password) {
      headers["x-clickhouse-key"] = this.password;
    }

    return headers;
  }
}

function buildKlineMaterializedViewSql(
  interval: MarketDataKlineInterval,
  bucketExpression: string,
  intervalLengthMs: number
): string {
  return `create materialized view if not exists market_data_trade_snapshots_to_kline_${interval}
          to market_data_kline_1m
          as
          select
            market,
            '${interval}' as interval,
            ${bucketExpression} as open_time,
            toUInt32(${intervalLengthMs}) as interval_length_ms,
            argMaxState(toFloat64(price), executed_at) as close_price,
            argMinState(toFloat64(price), executed_at) as open_price,
            maxState(toFloat64(price)) as high_price,
            minState(toFloat64(price)) as low_price,
            sumState(toFloat64(quantity)) as base_volume,
            sumState(toFloat64(price) * toFloat64(quantity)) as quote_volume,
            countState() as trade_count
          from market_data_trade_snapshots
          group by market, interval, open_time`;
}
