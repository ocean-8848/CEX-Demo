import { useEffect, useState } from "react";

import { Panel, Tabs } from "@web3-cex/web-ui";

import { isOpenOrder } from "../../lib/records.js";
import { navigate } from "../../lib/router.js";
import { useExchange } from "../../state/store.js";
import {
  BalancesTable,
  OpenOrdersTable,
  OrderHistoryTable,
  TradeHistoryTable
} from "./account-tables.js";
import { CandleChart } from "./candle-chart.js";
import { MarketHeader, MarketList } from "./market-header.js";
import { MarketPanel } from "./order-book.js";
import { OrderForm } from "./order-form.js";

type BottomTab = "open" | "history" | "trades" | "balances";

export function TradePage(props: { market?: string }) {
  const { state, actions } = useExchange();
  const [picked, setPicked] = useState<{ price: string; nonce: number }>();
  const [tab, setTab] = useState<BottomTab>("open");
  const [scope, setScope] = useState<"current" | "all">("current");

  // URL is the source of truth for the selected market.
  useEffect(() => {
    const markets = state.config?.markets.map((item) => item.market) ?? [];
    if (props.market && markets.includes(props.market)) {
      actions.selectMarket(props.market);
    } else if (markets.length > 0) {
      navigate(`/trade/${state.market}`);
    }
  }, [props.market, state.config, state.market, actions]);

  const openCount = state.orders.filter(
    (order) => isOpenOrder(order) && (scope === "all" || order.market === state.market)
  ).length;
  const marketFilter = scope === "current" ? state.market : undefined;

  return (
    <div className="trade-page">
      <MarketHeader />
      <div className="trade-grid">
        <aside className="trade-markets panel hide-md">
          <header className="panel-header">
            <h3 className="panel-title">现货市场</h3>
          </header>
          <MarketList compact onSelect={(market) => navigate(`/trade/${market}`)} />
        </aside>
        <section className="panel trade-chart">
          <CandleChart />
        </section>
        <MarketPanel onPickPrice={(price) => setPicked({ price, nonce: Date.now() })} />
        <section className="panel trade-form">
          <OrderForm pickedPrice={picked} />
        </section>
      </div>
      <Panel
        className="trade-bottom"
        flush
        title={
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: "open", label: "当前委托", count: openCount },
              { value: "history", label: "历史委托" },
              { value: "trades", label: "成交记录" },
              { value: "balances", label: "资产" }
            ]}
          />
        }
        actions={
          tab === "balances" ? null : (
            <label className="scope-toggle">
              <input
                type="checkbox"
                checked={scope === "current"}
                onChange={(event) => setScope(event.target.checked ? "current" : "all")}
              />
              只看当前交易对
            </label>
          )
        }
      >
        {tab === "open" ? <OpenOrdersTable market={marketFilter} /> : null}
        {tab === "history" ? <OrderHistoryTable market={marketFilter} limit={50} /> : null}
        {tab === "trades" ? <TradeHistoryTable market={marketFilter} limit={50} /> : null}
        {tab === "balances" ? <BalancesTable /> : null}
      </Panel>
    </div>
  );
}
