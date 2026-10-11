import { useMemo, useState } from "react";

import { decimalsOf, formatFixed, formatTime, splitMarket, Tabs, toNumber } from "@web3-cex/web-ui";

import { takerSide } from "../../lib/records.js";
import type { DepthLevel } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";

const ROWS = 12;

interface BookRow {
  price: number;
  quantity: number;
  total: number;
  cumulative: number;
  orderCount: number;
}

function buildRows(levels: DepthLevel[], side: "bid" | "ask"): BookRow[] {
  const sorted = [...levels]
    .map((level) => ({
      price: toNumber(level.price),
      quantity: toNumber(level.quantity),
      orderCount: level.orderCount ?? 1
    }))
    .filter((level) => level.price > 0 && level.quantity > 0)
    .sort((left, right) => (side === "bid" ? right.price - left.price : left.price - right.price))
    .slice(0, ROWS);
  let cumulative = 0;
  return sorted.map((level) => {
    cumulative += level.quantity;
    return { ...level, total: level.price * level.quantity, cumulative };
  });
}

export function MarketPanel(props: { onPickPrice: (price: string) => void }) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  return (
    <section className="panel book-panel">
      <header className="panel-header">
        <Tabs
          size="sm"
          value={tab}
          onChange={setTab}
          items={[
            { value: "book", label: "订单簿" },
            { value: "trades", label: "最新成交" }
          ]}
        />
      </header>
      {tab === "book" ? <OrderBook onPickPrice={props.onPickPrice} /> : <RecentTrades onPickPrice={props.onPickPrice} />}
    </section>
  );
}

export function OrderBook(props: { onPickPrice: (price: string) => void }) {
  const { state, marketDefinition } = useExchange();
  const priceDecimals = decimalsOf(marketDefinition?.priceStep, 2);
  const quantityDecimals = decimalsOf(marketDefinition?.quantityStep, 3);
  const { base, quote } = splitMarket(state.market);

  const { asks, bids, maxCumulative, spread, mid } = useMemo(() => {
    const asks = buildRows(state.depth.asks, "ask");
    const bids = buildRows(state.depth.bids, "bid");
    const maxCumulative = Math.max(asks[asks.length - 1]?.cumulative ?? 0, bids[bids.length - 1]?.cumulative ?? 0, 1e-9);
    const bestAsk = asks[0]?.price;
    const bestBid = bids[0]?.price;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : undefined;
    const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : undefined;
    return { asks, bids, maxCumulative, spread, mid };
  }, [state.depth]);

  const lastTrade = state.publicTrades[0];
  const lastPrice = toNumber(lastTrade?.price ?? state.tickers[state.market]?.lastPrice);
  const lastDirection = lastTrade ? takerSide(lastTrade) : undefined;

  const row = (item: BookRow, side: "bid" | "ask") => (
    <button
      type="button"
      key={`${side}-${item.price}`}
      className={`book-row ${side}`}
      onClick={() => props.onPickPrice(item.price.toFixed(priceDecimals))}
      title={`${item.orderCount} 笔挂单 · 点击填入价格`}
    >
      <span
        className="depth-bar"
        style={{ width: `${Math.min((item.cumulative / maxCumulative) * 100, 100)}%` }}
      />
      <span className="price">{formatFixed(item.price, priceDecimals)}</span>
      <span>{formatFixed(item.quantity, quantityDecimals)}</span>
      <span className="muted">{formatFixed(item.cumulative, quantityDecimals)}</span>
    </button>
  );

  return (
    <div className="order-book" id="order-book">
      <div className="book-head">
        <span>价格({quote})</span>
        <span>数量({base})</span>
        <span>累计({base})</span>
      </div>
      <div className="book-side asks">
        {asks.length === 0 ? <div className="book-empty">暂无卖单</div> : [...asks].reverse().map((item) => row(item, "ask"))}
      </div>
      <div className="book-mid">
        <span className={`book-last ${lastDirection === "sell" ? "down" : lastDirection === "buy" ? "up" : ""}`}>
          {Number.isFinite(lastPrice) && lastPrice > 0 ? formatFixed(lastPrice, priceDecimals) : mid ? formatFixed(mid, priceDecimals) : "--"}
          {lastDirection === "sell" ? " ↓" : lastDirection === "buy" ? " ↑" : ""}
        </span>
        <span className="muted">
          价差 {spread !== undefined ? formatFixed(spread, priceDecimals) : "--"}
          {spread !== undefined && mid ? ` (${((spread / mid) * 100).toFixed(3)}%)` : ""}
        </span>
      </div>
      <div className="book-side bids">
        {bids.length === 0 ? <div className="book-empty">暂无买单</div> : bids.map((item) => row(item, "bid"))}
      </div>
    </div>
  );
}

export function RecentTrades(props: { onPickPrice: (price: string) => void }) {
  const { state, marketDefinition } = useExchange();
  const priceDecimals = decimalsOf(marketDefinition?.priceStep, 2);
  const quantityDecimals = decimalsOf(marketDefinition?.quantityStep, 3);
  const { base, quote } = splitMarket(state.market);
  return (
    <div className="recent-trades" id="recent-trades">
      <div className="book-head">
        <span>价格({quote})</span>
        <span>数量({base})</span>
        <span>时间</span>
      </div>
      <div className="trades-list">
        {state.publicTrades.length === 0 ? (
          <div className="book-empty">暂无成交</div>
        ) : (
          state.publicTrades.slice(0, 40).map((trade) => (
            <button
              type="button"
              key={trade.tradeId}
              className="book-row"
              onClick={() => props.onPickPrice(toNumber(trade.price).toFixed(priceDecimals))}
            >
              <span className={takerSide(trade) === "sell" ? "price down" : "price up"}>
                {formatFixed(trade.price, priceDecimals)}
              </span>
              <span>{formatFixed(trade.quantity, quantityDecimals)}</span>
              <span className="muted">{formatTime(trade.executedAt)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
