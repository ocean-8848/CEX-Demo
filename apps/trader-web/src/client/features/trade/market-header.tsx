import { useEffect, useRef, useState } from "react";

import {
  AssetIcon,
  changeRatio,
  decimalsOf,
  formatCompact,
  formatFixed,
  formatPercent,
  marketLabel,
  splitMarket,
  toNumber,
  trendClass
} from "@web3-cex/web-ui";

import { navigate } from "../../lib/router.js";
import { useExchange } from "../../state/store.js";

/** Best effort "current price": last trade, else order book mid. */
export function useDisplayPrice(market: string): number | undefined {
  const { state } = useExchange();
  const last = toNumber(state.tickers[market]?.lastPrice);
  if (Number.isFinite(last) && last > 0) {
    return last;
  }
  if (market === state.market) {
    const bid = toNumber(state.depth.bids[0]?.price);
    const ask = toNumber(state.depth.asks[0]?.price);
    if (bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
  }
  return undefined;
}

export function MarketHeader() {
  const { state, marketDefinition } = useExchange();
  const ticker = state.tickers[state.market];
  const priceDecimals = decimalsOf(marketDefinition?.priceStep, 2);
  const price = useDisplayPrice(state.market);
  const change = changeRatio(ticker?.lastPrice, ticker?.openPrice24h);
  const { base, quote } = splitMarket(state.market);

  useEffect(() => {
    if (price) {
      document.title = `${formatFixed(price, priceDecimals)} · ${marketLabel(state.market)} · ${state.config?.appTitle ?? "Web3 CEX"}`;
    }
  }, [price, priceDecimals, state.market, state.config?.appTitle]);

  return (
    <div className="market-header panel">
      <MarketSelector />
      <div className={`mh-price ${trendClass(change)}`} id="market-last-price">
        {price ? formatFixed(price, priceDecimals) : "--"}
      </div>
      <dl className="mh-stats">
        <div>
          <dt>24h 涨跌</dt>
          <dd className={trendClass(change)}>{formatPercent(change)}</dd>
        </div>
        <div>
          <dt>24h 最高</dt>
          <dd>{toNumber(ticker?.highPrice24h) > 0 ? formatFixed(ticker?.highPrice24h, priceDecimals) : "--"}</dd>
        </div>
        <div>
          <dt>24h 最低</dt>
          <dd>{toNumber(ticker?.lowPrice24h) > 0 ? formatFixed(ticker?.lowPrice24h, priceDecimals) : "--"}</dd>
        </div>
        <div>
          <dt>24h 成交量({base})</dt>
          <dd>{formatCompact(ticker?.volume24h)}</dd>
        </div>
        <div>
          <dt>24h 成交额({quote})</dt>
          <dd>{formatCompact(ticker?.quoteVolume24h)}</dd>
        </div>
        <div className="hide-sm">
          <dt>成交笔数</dt>
          <dd>{ticker?.tradeCount24h ?? "--"}</dd>
        </div>
      </dl>
    </div>
  );
}

function MarketSelector() {
  const { state } = useExchange();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { base } = splitMarket(state.market);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="market-selector" ref={ref}>
      <button type="button" className="ms-button" onClick={() => setOpen((value) => !value)} id="market-selector">
        <AssetIcon asset={base} size={28} />
        <span className="ms-name">{marketLabel(state.market)}</span>
        <span className="ms-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="ms-menu">
          <MarketList
            onSelect={(market) => {
              setOpen(false);
              navigate(`/trade/${market}`);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function MarketList(props: { onSelect: (market: string) => void; compact?: boolean }) {
  const { state } = useExchange();
  const markets = state.config?.markets ?? [];
  return (
    <table className="market-list">
      <thead>
        <tr>
          <th>交易对</th>
          <th className="num">最新价</th>
          <th className="num">24h 涨跌</th>
          {props.compact ? null : <th className="num hide-sm">24h 成交额</th>}
        </tr>
      </thead>
      <tbody>
        {markets.map((definition) => {
          const ticker = state.tickers[definition.market];
          const change = changeRatio(ticker?.lastPrice, ticker?.openPrice24h);
          const decimals = decimalsOf(definition.priceStep, 2);
          return (
            <tr
              key={definition.market}
              className={definition.market === state.market ? "active" : ""}
              onClick={() => props.onSelect(definition.market)}
            >
              <td>
                <span className="pair">
                  <AssetIcon asset={definition.baseAsset} />
                  <b>{definition.baseAsset}</b>
                  <span className="muted">/{definition.quoteAsset}</span>
                </span>
              </td>
              <td className="num">{toNumber(ticker?.lastPrice) > 0 ? formatFixed(ticker?.lastPrice, decimals) : "--"}</td>
              <td className={`num ${trendClass(change)}`}>{formatPercent(change)}</td>
              {props.compact ? null : <td className="num hide-sm">{formatCompact(ticker?.quoteVolume24h)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
