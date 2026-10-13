import { useState } from "react";

import { Button, Empty, Panel, Tabs, formatAmount, formatCompact, toNumber } from "@web3-cex/web-ui";

import { itemsOf, qs } from "../lib/api.js";
import type { OrderRecord, SettlementRecord, SettlementReport, TradeRecord } from "../lib/types.js";
import {
  ConfirmDialog,
  IdLink,
  JsonView,
  PageHeader,
  Pager,
  QueryView,
  RefreshButton,
  StatCard,
  StatusBadge,
  Time
} from "../components/kit.js";
import { useMarketConfig, useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

const PAGE_SIZE = 30;

const ORDER_TYPE_LABELS: Record<string, string> = {
  limit: "限价",
  market: "市价",
  stop_limit: "止损限价",
  stop_market: "止损市价"
};

function describeOrderType(order: OrderRecord): string {
  const parts = [ORDER_TYPE_LABELS[order.type ?? ""] ?? order.type ?? "--", order.timeInForce?.toUpperCase()];
  if (order.postOnly) {
    parts.push("Post-Only");
  }
  if (order.stpMode && order.stpMode !== "expire_taker") {
    parts.push(`STP ${order.stpMode}`);
  }
  return parts.filter(Boolean).join(" · ");
}

interface BookOverview {
  market: string;
  openOrderCount?: number;
  filledOrderCount?: number;
  cancelledOrderCount?: number;
  rejectedOrderCount?: number;
  pendingTriggerOrderCount?: number;
  tradeCount?: number;
  engineBidCount?: number;
  engineAskCount?: number;
  anomalyCount?: number;
  status?: string;
}

interface BookAnomaly {
  type: string;
  orderId?: string;
  detail?: string;
  [key: string]: unknown;
}

export function TradingPage() {
  const marketConfig = useMarketConfig();
  const [selected, setMarket] = useState("");
  // Markets come from config/markets.json; default to its defaultMarket.
  const market = selected || marketConfig.defaultMarket;
  const definition = marketConfig.markets.find((item) => item.market === market);
  const baseAsset = definition?.baseAsset ?? market.split("-")[0];
  const quoteAsset = definition?.quoteAsset ?? market.split("-")[1] ?? "";
  const [tab, setTab] = useState<"orders" | "trades" | "settlements" | "book">("orders");
  const report = useOpsQuery<SettlementReport>("/spot/settlements/report", { refreshMs: 15_000 });
  const marketTotals = report.data?.markets?.find((item) => item.market === market);

  return (
    <div className="page">
      <PageHeader
        title="交易与结算"
        subtitle="order-service 管理订单生命周期，matching-engine 撮合，settlement-service 把成交变成账本分录"
        actions={
          <div className="segmented">
            {marketConfig.markets.map(({ market: item }) => (
              <button key={item} type="button" className={item === market ? "active" : ""} onClick={() => setMarket(item)}>
                {item.replace("-", "/")}
              </button>
            ))}
          </div>
        }
      />
      <div className="stat-grid">
        <StatCard label="结算笔数" value={marketTotals ? formatCompact(marketTotals.settlementCount) : "--"} hint={`${market} 累计`} />
        <StatCard label="成交量" value={marketTotals ? formatAmount(marketTotals.quantity, 4) : "--"} hint={baseAsset} />
        <StatCard label="成交额" value={marketTotals ? formatCompact(marketTotals.quoteAmount) : "--"} hint={quoteAsset} />
        <StatCard
          label="手续费收入"
          value={marketTotals ? `${formatAmount(marketTotals.feeAmount, 2)} ${quoteAsset}` : "--"}
          hint={marketTotals ? `另有 ${formatAmount(marketTotals.baseFeeAmount ?? "0", 6)} ${baseAsset}（买方）` : undefined}
          tone="positive"
        />
        <StatCard
          label="待恢复 / 失败"
          value={marketTotals ? `${marketTotals.pendingRecoveryCount ?? 0} / ${marketTotals.failedCount ?? 0}` : "--"}
          tone={marketTotals && (marketTotals.pendingRecoveryCount || marketTotals.failedCount) ? "negative" : "positive"}
          hint="结算恢复队列"
        />
      </div>
      <Tabs
        className="page-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "orders", label: "订单" },
          { value: "trades", label: "成交" },
          { value: "settlements", label: "结算" },
          { value: "book", label: "订单簿健康" }
        ]}
      />
      {!market ? <p className="muted">正在加载市场配置…</p> : null}
      {market && tab === "orders" ? <OrdersTable market={market} /> : null}
      {market && tab === "trades" ? <TradesTable market={market} /> : null}
      {market && tab === "settlements" ? <SettlementsTable market={market} /> : null}
      {market && tab === "book" ? <BookHealth market={market} /> : null}
    </div>
  );
}

function OrdersTable(props: { market: string }) {
  const [status, setStatus] = useState("");
  const [userId, setUserId] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<OrderRecord[]>(
    `/spot/orders${qs({ market: props.market, status, userId, limit: PAGE_SIZE, offset })}`,
    { refreshMs: 10_000 }
  );
  const rows = itemsOf<OrderRecord>(query.data);
  return (
    <Panel
      flush
      title={
        <div className="filters">
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="状态">
            <option value="">全部状态</option>
            <option value="pending_trigger">待触发</option>
            <option value="accepted">挂单中</option>
            <option value="partially_filled">部分成交</option>
            <option value="filled">完全成交</option>
            <option value="cancelled">已撤销</option>
            <option value="rejected">已拒绝</option>
            <option value="recovery_pending">恢复中</option>
          </select>
          <input className="filter-input" placeholder="按 userId 过滤" value={userId} onChange={(event) => { setUserId(event.target.value.trim()); setOffset(0); }} />
        </div>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0}>
        {() => (
          <div className="table-scroll">
            <table className="data-table" id="orders-table">
              <thead>
                <tr><th>时间</th><th>订单</th><th>用户</th><th>方向</th><th>类型</th><th className="num">价格</th><th className="num">触发价</th><th className="num">数量</th><th className="num">已成交</th><th>状态</th><th>原因</th></tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.orderId}>
                    <td><Time value={order.createdAt} /></td>
                    <td><IdLink id={order.orderId} kind="orderId" /></td>
                    <td><IdLink id={order.userId} kind="userId" /></td>
                    <td className={order.side === "sell" ? "down" : "up"}>{order.side === "sell" ? "卖出" : "买入"}</td>
                    <td className="muted">{describeOrderType(order)}</td>
                    <td className="num">{order.type === "market" || order.type === "stop_market" ? "市价" : formatAmount(order.price, 2)}</td>
                    <td className="num" title={order.triggeredAt ? `已于 ${order.triggeredAt} 触发` : undefined}>
                      {order.triggerPrice ? formatAmount(order.triggerPrice, 2) : "--"}
                    </td>
                    <td className="num">{formatAmount(order.quantity)}</td>
                    <td className="num">{formatAmount(order.filledQuantity ?? "0")}</td>
                    <td><StatusBadge status={order.status} /></td>
                    <td className="muted small">{order.rejectedReason ?? "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function TradesTable(props: { market: string }) {
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<TradeRecord[]>(`/spot/trades${qs({ market: props.market, limit: PAGE_SIZE, offset })}`, { refreshMs: 10_000 });
  const rows = itemsOf<TradeRecord>(query.data);
  return (
    <Panel flush title="最近成交" actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}>
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0}>
        {() => (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>时间</th><th>成交</th><th className="num">价格</th><th className="num">数量</th><th className="num">成交额</th><th>买方</th><th>卖方</th><th>结算</th></tr>
              </thead>
              <tbody>
                {rows.map((trade) => (
                  <tr key={trade.tradeId}>
                    <td><Time value={trade.executedAt} /></td>
                    <td><IdLink id={trade.tradeId} kind="tradeId" /></td>
                    <td className="num">{formatAmount(trade.price, 2)}</td>
                    <td className="num">{formatAmount(trade.quantity)}</td>
                    <td className="num">{formatAmount(toNumber(trade.price) * toNumber(trade.quantity), 2)}</td>
                    <td><IdLink id={trade.buyerUserId} kind="userId" /></td>
                    <td><IdLink id={trade.sellerUserId} kind="userId" /></td>
                    <td>{trade.settlementId && trade.settlementId !== "pending" ? <StatusBadge status="settled" /> : <StatusBadge status="pending" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function SettlementsTable(props: { market: string }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<SettlementRecord[]>(`/spot/settlements${qs({ market: props.market, status, limit: PAGE_SIZE, offset })}`, { refreshMs: 10_000 });
  const rows = itemsOf<SettlementRecord>(query.data);
  return (
    <Panel
      flush
      title={
        <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="状态">
          <option value="">全部结算</option>
          <option value="settled">已结算</option>
          <option value="pending_recovery">待恢复</option>
          <option value="failed">失败</option>
        </select>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0}>
        {() => (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>时间</th><th>成交</th><th className="num">数量</th><th className="num">成交额</th><th className="num">卖方费 (quote)</th><th className="num">买方费 (base)</th><th>尝试</th><th>状态</th><th className="num">操作</th></tr>
              </thead>
              <tbody>
                {rows.map((settlement) => (
                  <tr key={settlement.settlementId}>
                    <td><Time value={settlement.settledAt ?? settlement.createdAt} /></td>
                    <td><IdLink id={settlement.tradeId} kind="tradeId" /></td>
                    <td className="num">{formatAmount(settlement.quantity)}</td>
                    <td className="num">{formatAmount(settlement.quoteAmount, 2)}</td>
                    <td className="num muted">{formatAmount(settlement.feeAmount, 4)}</td>
                    <td className="num muted">{formatAmount(settlement.buyerFeeAmount ?? "0", 8)}</td>
                    <td className="muted" title={settlement.lastError}>{settlement.attemptCount ?? 1}</td>
                    <td><StatusBadge status={settlement.status} /></td>
                    <td className="num">
                      {settlement.status !== "settled" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!can("ops.ledger.execute")}
                          loading={busy === settlement.tradeId}
                          onClick={async () => {
                            await run(settlement.tradeId, { path: `/spot/settlements/${encodeURIComponent(settlement.tradeId)}/recover` }, { success: "已触发结算恢复" });
                            query.reload();
                          }}
                        >
                          重试结算
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function BookHealth(props: { market: string }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [confirm, setConfirm] = useState(false);
  const overview = useOpsQuery<BookOverview>(`/spot/ops/overview${qs({ market: props.market })}`, { refreshMs: 10_000 });
  const anomalies = useOpsQuery<BookAnomaly[]>(`/spot/ops/anomalies${qs({ market: props.market })}`, { refreshMs: 10_000 });
  return (
    <div className="grid-2">
      <Panel title="数据库 vs 撮合引擎" actions={<RefreshButton onClick={() => { overview.reload(); anomalies.reload(); }} loading={overview.loading} />}>
        <QueryView state={overview}>
          {(data) => (
            <div className="book-compare">
              <div className="stat-grid compact">
                <StatCard label="DB 挂单" value={data.openOrderCount ?? "--"} />
                <StatCard label="引擎买单" value={data.engineBidCount ?? "--"} />
                <StatCard label="引擎卖单" value={data.engineAskCount ?? "--"} />
                <StatCard label="异常" value={data.anomalyCount ?? 0} tone={data.anomalyCount ? "negative" : "positive"} />
                <StatCard label="待触发止损单" value={data.pendingTriggerOrderCount ?? 0} hint="不在引擎订单簿中" />
              </div>
              <p className="muted small">
                撮合引擎的订单簿在内存中；order-service 的数据库是事实源。两者不一致时（例如引擎重启），可以用数据库中的挂单重建引擎订单簿。
                止损单在触发前只存在于数据库（pending_trigger），由 order-service 的触发器按最新成交价提交到引擎；重建时会带上账户 ID，自成交保护（STP）继续生效。
              </p>
              <Button variant="primary" disabled={!can("ops.ledger.execute")} onClick={() => setConfirm(true)}>
                从数据库重建引擎订单簿
              </Button>
            </div>
          )}
        </QueryView>
      </Panel>
      <Panel title="异常清单">
        <QueryView state={anomalies} empty={(data) => itemsOf(data).length === 0} emptyTitle="未发现异常" emptyHint="数据库挂单与引擎订单簿一致。">
          {(data) => (
            <ul className="plain-list">
              {itemsOf<BookAnomaly>(data).map((item, index) => (
                <li key={`${item.type}:${item.orderId ?? index}`}>
                  <code>{item.type}</code> <IdLink id={item.orderId} kind="orderId" />
                  {item.detail ? <div className="muted small">{item.detail}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </QueryView>
        {anomalies.data && itemsOf(anomalies.data).length > 0 ? <JsonView value={anomalies.data} /> : null}
        {!anomalies.data && !anomalies.loading ? <Empty title="暂无数据" /> : null}
      </Panel>
      <ConfirmDialog
        open={confirm}
        title={`重建 ${props.market} 引擎订单簿`}
        description="会先清空撮合引擎中该市场的订单簿，再按数据库中的挂单（价格、时间优先级）重新写入。重建期间新订单可能被拒绝。"
        confirmLabel="确认重建"
        busy={busy === "replay"}
        onConfirm={async () => {
          const result = await run("replay", { path: "/spot/ops/replay-engine", body: { market: props.market } }, { success: "订单簿已重建" });
          if (result) {
            setConfirm(false);
            overview.reload();
            anomalies.reload();
          }
        }}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}
