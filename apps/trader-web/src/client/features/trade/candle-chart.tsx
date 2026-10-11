import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";

import { decimalsOf, formatAmount, formatFixed } from "@web3-cex/web-ui";

import type { Kline } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function CandleChart() {
  const { state, api, marketDefinition } = useExchange();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastFetchRef = useRef(0);
  const [interval, setChartInterval] = useState<Interval>("1m");
  const [klines, setKlines] = useState<Kline[]>([]);
  const [hover, setHover] = useState<Kline | null>(null);
  const priceDecimals = decimalsOf(marketDefinition?.priceStep, 2);

  // (Re)create the chart when the theme changes so colours follow CSS tokens.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const up = cssVar("--up");
    const down = cssVar("--down");
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-muted"),
        fontSize: 11
      },
      grid: {
        vertLines: { color: cssVar("--grid") },
        horzLines: { color: cssVar("--grid") }
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cssVar("--border") },
      timeScale: {
        borderColor: cssVar("--border"),
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 9,
        rightOffset: 4
      }
    });
    const candles = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals }
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      const time = Number(param.time) * 1000;
      setHover(klinesRef.current.find((item) => Date.parse(item.openTime) === time) ?? null);
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [state.prefs.theme, priceDecimals]);

  const klinesRef = useRef<Kline[]>([]);
  klinesRef.current = klines;

  // Load candles for market/interval.
  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    setKlines([]);
    const load = () =>
      api
        .market<Kline[]>(
          `/klines?market=${encodeURIComponent(state.market)}&interval=${interval}&limit=200`
        )
        .then((items) => {
          if (!cancelled && Array.isArray(items)) {
            lastFetchRef.current = Date.now();
            setKlines(normalizeKlines(items));
          }
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, state.market, interval]);

  // New public trades -> refresh the latest candles (throttled).
  const latestTradeId = state.publicTrades[0]?.tradeId;
  useEffect(() => {
    if (!api || !latestTradeId || Date.now() - lastFetchRef.current < 2000) {
      return;
    }
    lastFetchRef.current = Date.now();
    api
      .market<Kline[]>(`/klines?market=${encodeURIComponent(state.market)}&interval=${interval}&limit=200`)
      .then((items) => Array.isArray(items) && setKlines(normalizeKlines(items)))
      .catch(() => undefined);
  }, [api, latestTradeId, state.market, interval]);

  // Push data into the series.
  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) {
      return;
    }
    const up = cssVar("--up");
    const down = cssVar("--down");
    candles.setData(
      klines.map((item) => ({
        time: (Date.parse(item.openTime) / 1000) as UTCTimestamp,
        open: Number(item.openPrice),
        high: Number(item.highPrice),
        low: Number(item.lowPrice),
        close: Number(item.closePrice)
      }))
    );
    volume.setData(
      klines.map((item) => ({
        time: (Date.parse(item.openTime) / 1000) as UTCTimestamp,
        value: Number(item.baseVolume),
        color: `${Number(item.closePrice) >= Number(item.openPrice) ? up : down}66`
      }))
    );
  }, [klines, state.prefs.theme, priceDecimals]);

  const shown = hover ?? klines[klines.length - 1];

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        <div className="intervals" role="tablist">
          {INTERVALS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === interval ? "active" : ""}
              onClick={() => setChartInterval(value)}
            >
              {value}
            </button>
          ))}
        </div>
        {shown ? (
          <div className="ohlc">
            <span>开 <b>{formatFixed(shown.openPrice, priceDecimals)}</b></span>
            <span>高 <b>{formatFixed(shown.highPrice, priceDecimals)}</b></span>
            <span>低 <b>{formatFixed(shown.lowPrice, priceDecimals)}</b></span>
            <span>
              收{" "}
              <b className={Number(shown.closePrice) >= Number(shown.openPrice) ? "up" : "down"}>
                {formatFixed(shown.closePrice, priceDecimals)}
              </b>
            </span>
            <span>量 <b>{formatAmount(shown.baseVolume, 4)}</b></span>
          </div>
        ) : null}
      </div>
      <div className="chart" ref={containerRef} />
      {klines.length === 0 ? (
        <div className="chart-empty">
          <strong>暂无 K 线</strong>
          <span>K 线由成交聚合而来；运行 demo-simulator 后做市商会持续产生成交。</span>
        </div>
      ) : null}
    </div>
  );
}

function normalizeKlines(items: Kline[]): Kline[] {
  const byTime = new Map<number, Kline>();
  for (const item of items) {
    const time = Date.parse(item.openTime);
    if (Number.isFinite(time) && Number(item.openPrice) > 0) {
      byTime.set(time, item);
    }
  }
  return [...byTime.entries()].sort((left, right) => left[0] - right[0]).map(([, item]) => item);
}
