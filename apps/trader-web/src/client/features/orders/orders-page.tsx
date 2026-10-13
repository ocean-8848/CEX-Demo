import { useEffect, useState } from "react";

import { Button, Empty, marketLabel, Panel, Tabs } from "@web3-cex/web-ui";

import { isOpenOrder } from "../../lib/records.js";
import { navigate } from "../../lib/router.js";
import { useExchange } from "../../state/store.js";
import { OpenOrdersTable, OrderHistoryTable, TradeHistoryTable } from "../trade/account-tables.js";

type OrdersTab = "open" | "history" | "trades";

function asOrdersTab(value: string | undefined): OrdersTab | undefined {
  return value === "open" || value === "history" || value === "trades" ? value : undefined;
}

export function OrdersPage(props: { tab?: string; highlight?: string } = {}) {
  const { state, actions } = useExchange();
  const [tab, setTab] = useState<OrdersTab>(asOrdersTab(props.tab) ?? "open");

  // Deep links (statement / notifications): switch tab and flash the row.
  useEffect(() => {
    const next = asOrdersTab(props.tab);
    if (next) {
      setTab(next);
    }
  }, [props.tab, props.highlight]);
  useEffect(() => {
    if (!props.highlight) {
      return;
    }
    const id = CSS.escape(props.highlight);
    const timer = window.setTimeout(() => {
      const row = document.querySelector(`[data-trade-id="${id}"], [data-order-id="${id}"]`);
      if (row) {
        row.classList.add("row-highlight");
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [props.highlight, tab, state.trades.length, state.orders.length]);
  const [market, setMarket] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  if (!state.token) {
    return (
      <div className="page narrow">
        <Empty
          icon="🔒"
          title="登录后查看订单"
          action={
            <Button variant="primary" onClick={() => navigate("/login?redirect=/orders")}>
              登录 / 注册
            </Button>
          }
        />
      </div>
    );
  }

  const openCount = state.orders.filter((order) => isOpenOrder(order) && (!market || order.market === market)).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>订单中心</h1>
          <p className="muted">委托由 order-service 管理生命周期，成交由 settlement-service 结算入账</p>
        </div>
        <Button variant="ghost" size="sm" loading={state.accountLoading} onClick={() => void actions.refreshAccount()}>
          刷新
        </Button>
      </div>
      <Panel
        flush
        title={
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: "open", label: "当前委托", count: openCount },
              { value: "history", label: "历史委托" },
              { value: "trades", label: "成交明细" }
            ]}
          />
        }
        actions={
          <div className="filters">
            <select value={market} onChange={(event) => setMarket(event.target.value)} aria-label="交易对筛选">
              <option value="">全部交易对</option>
              {(state.config?.markets ?? []).map((item) => (
                <option key={item.market} value={item.market}>
                  {marketLabel(item.market)}
                </option>
              ))}
            </select>
            {tab === "history" ? (
              <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状态筛选">
                <option value="">全部状态</option>
                <option value="filled">完全成交</option>
                <option value="cancelled">已撤销</option>
                <option value="rejected">已拒绝</option>
              </select>
            ) : null}
          </div>
        }
      >
        {tab === "open" ? <OpenOrdersTable market={market || undefined} /> : null}
        {tab === "history" ? <OrderHistoryTable market={market || undefined} statusFilter={status || undefined} /> : null}
        {tab === "trades" ? <TradeHistoryTable market={market || undefined} /> : null}
      </Panel>

      <section className="lifecycle panel">
        <h3 className="panel-title">一笔订单的生命周期</h3>
        <ol className="lifecycle-steps">
          <li>
            <b>风控中</b>
            <span>risk-service 检查紧急开关与市场状态，校验数量、步长、价格偏离并计算冻结金额</span>
          </li>
          <li>
            <b>冻结资金</b>
            <span>ledger-service 把资金从 available 转为 locked</span>
          </li>
          <li>
            <b>挂单中 / 部分成交</b>
            <span>matching-engine 按价格优先、时间优先撮合</span>
          </li>
          <li>
            <b>结算</b>
            <span>settlement-service 为每笔成交记双分录，买卖双方资产互换</span>
          </li>
          <li>
            <b>完全成交 / 已撤销</b>
            <span>终态：剩余冻结资金被解冻，事件推送到私有 WebSocket</span>
          </li>
        </ol>
      </section>
    </div>
  );
}
