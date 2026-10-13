import { useState } from "react";

import {
  AssetIcon,
  Badge,
  Button,
  decimalsOf,
  Empty,
  formatAmount,
  formatDateTime,
  formatFixed,
  marketLabel,
  splitMarket,
  toNumber
} from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { formatRate, userTradeFeeRate } from "../../lib/fee-tier.js";
import {
  describeOrderStatus,
  filledRatio,
  isOpenOrder,
  userTradeFee,
  userTradeSide
} from "../../lib/records.js";
import { href, navigate } from "../../lib/router.js";
import type { MarketDefinition, OrderRecord } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";
import { TradeJournalModal } from "./trade-journal-modal.js";

function useDecimals() {
  const { state } = useExchange();
  return (market: string | undefined) => {
    const definition: MarketDefinition | undefined = state.config?.markets.find(
      (item) => item.market === market
    );
    return {
      price: decimalsOf(definition?.priceStep, 2),
      quantity: decimalsOf(definition?.quantityStep, 3)
    };
  };
}

function LoginGate() {
  return (
    <Empty
      icon="🔒"
      title="登录后查看"
      hint="订单、成交和资产属于私有数据，需要通过 api-gateway 鉴权。"
      action={
        <Button variant="primary" size="sm" onClick={() => navigate("/login")}>
          登录 / 注册
        </Button>
      }
    />
  );
}

export function OpenOrdersTable(props: { market?: string }) {
  const { state, actions } = useExchange();
  const decimals = useDecimals();
  const [busy, setBusy] = useState<string | null>(null);
  if (!state.token) {
    return <LoginGate />;
  }
  const orders = state.orders.filter(
    (order) => isOpenOrder(order) && (!props.market || order.market === props.market)
  );
  if (orders.length === 0) {
    return <Empty icon="☰" title="暂无当前委托" hint="挂单（未成交或部分成交的限价单）会显示在这里。" />;
  }

  const cancel = async (orderId: string) => {
    setBusy(orderId);
    try {
      await actions.cancelOrder(orderId);
    } catch (error) {
      actions.toast("negative", "撤单失败", readErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="table-scroll">
      <table className="data-table" id="open-orders-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>交易对</th>
            <th>方向</th>
            <th>类型</th>
            <th className="num">价格</th>
            <th className="num">数量</th>
            <th>成交进度</th>
            <th>状态</th>
            <th className="num">
              <Button size="sm" variant="ghost" onClick={() => void actions.cancelAll(props.market)}>
                全部撤销
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const d = decimals(order.market);
            const status = describeOrderStatus(order.status);
            return (
              <tr key={order.orderId} data-order-id={order.orderId}>
                <td className="muted">{formatDateTime(order.createdAt)}</td>
                <td>{marketLabel(order.market ?? "")}</td>
                <td className={order.side === "sell" ? "down" : "up"}>{order.side === "sell" ? "卖出" : "买入"}</td>
                <td>{order.type === "market" ? "市价" : `限价 · ${order.timeInForce?.toUpperCase() ?? "GTC"}`}</td>
                <td className="num">{formatFixed(order.price, d.price)}</td>
                <td className="num">{formatFixed(order.quantity, d.quantity)}</td>
                <td>
                  <FillBar order={order} />
                </td>
                <td>
                  <Badge tone={status.tone} title={status.hint}>
                    {status.label}
                  </Badge>
                </td>
                <td className="num">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === order.orderId}
                    onClick={() => void cancel(order.orderId)}
                    data-cancel-order={order.orderId}
                  >
                    撤单
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FillBar(props: { order: OrderRecord }) {
  const ratio = filledRatio(props.order);
  return (
    <span className="fill">
      <span className="fill-track">
        <span style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="muted">{(ratio * 100).toFixed(0)}%</span>
    </span>
  );
}

export function OrderHistoryTable(props: { market?: string; limit?: number; statusFilter?: string }) {
  const { state } = useExchange();
  const decimals = useDecimals();
  if (!state.token) {
    return <LoginGate />;
  }
  const orders = state.orders
    .filter((order) => !isOpenOrder(order) && (!props.market || order.market === props.market))
    .filter((order) => !props.statusFilter || order.status === props.statusFilter)
    .slice(0, props.limit ?? 100);
  if (orders.length === 0) {
    return <Empty icon="☰" title="暂无历史委托" hint="已成交、已撤销或被拒绝的委托会显示在这里。" />;
  }
  return (
    <div className="table-scroll">
      <table className="data-table" id="order-history-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>交易对</th>
            <th>方向</th>
            <th>类型</th>
            <th className="num">委托价</th>
            <th className="num">委托量</th>
            <th className="num">已成交</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const d = decimals(order.market);
            const status = describeOrderStatus(order.status);
            return (
              <tr key={order.orderId} data-order-id={order.orderId}>
                <td className="muted">{formatDateTime(order.updatedAt ?? order.createdAt)}</td>
                <td>{marketLabel(order.market ?? "")}</td>
                <td className={order.side === "sell" ? "down" : "up"}>{order.side === "sell" ? "卖出" : "买入"}</td>
                <td>{order.type === "market" ? "市价" : `限价 · ${order.timeInForce?.toUpperCase() ?? "GTC"}`}</td>
                <td className="num">{order.type === "market" ? "市价" : formatFixed(order.price, d.price)}</td>
                <td className="num">{formatFixed(order.quantity, d.quantity)}</td>
                <td className="num">{formatFixed(order.filledQuantity ?? "0", d.quantity)}</td>
                <td>
                  <Badge tone={status.tone} title={order.rejectedReason ?? status.hint}>
                    {status.label}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TradeHistoryTable(props: { market?: string; limit?: number }) {
  const { state } = useExchange();
  const decimals = useDecimals();
  const [journalTradeId, setJournalTradeId] = useState<string | null>(null);
  if (!state.token) {
    return <LoginGate />;
  }
  const userId = state.session?.userId;
  const trades = state.trades
    .filter((trade) => !props.market || trade.market === props.market)
    .slice(0, props.limit ?? 100);
  if (trades.length === 0) {
    return <Empty icon="⇄" title="暂无成交记录" hint="委托与对手单撮合后，每一笔成交都会出现在这里。" />;
  }
  return (
    <div className="table-scroll">
      <table className="data-table" id="trade-history-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>交易对</th>
            <th>方向</th>
            <th>角色</th>
            <th className="num">成交价</th>
            <th className="num">数量</th>
            <th className="num">成交额</th>
            <th className="num">手续费</th>
            <th className="num" title="查看这笔成交在账本里产生的分录">分录</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const d = decimals(trade.market);
            const side = userTradeSide(trade, userId);
            const myOrderId = side === "buy" ? trade.buyerOrderId : trade.sellerOrderId;
            const role = myOrderId && myOrderId === trade.makerOrderId ? "Maker" : "Taker";
            const fee = userTradeFee(trade, userId);
            const feeRate = userTradeFeeRate(trade, userId);
            return (
              <tr
                key={trade.tradeId}
                className="clickable-row"
                data-trade-id={trade.tradeId}
                title="点击查看这笔成交的账本分录（T 型账户）"
                onClick={() => setJournalTradeId(trade.tradeId)}
              >
                <td className="muted">{formatDateTime(trade.executedAt)}</td>
                <td>{marketLabel(trade.market ?? "")}</td>
                <td className={side === "sell" ? "down" : "up"}>{side === "sell" ? "卖出" : "买入"}</td>
                <td>
                  <Badge tone="neutral" title={role === "Maker" ? "挂单方：提供流动性" : "吃单方：消耗流动性"}>
                    {role}
                  </Badge>
                </td>
                <td className="num">{formatFixed(trade.price, d.price)}</td>
                <td className="num">{formatFixed(trade.quantity, d.quantity)}</td>
                <td className="num">{formatFixed(toNumber(trade.price) * toNumber(trade.quantity), 2)}</td>
                <td className="num muted" title={feeRate.tier ? `${feeRate.tier} 等级费率` : "成交时记录的费率"}>
                  {fee.amount > 0
                    ? `${formatAmount(fee.amount, 8)} ${fee.asset === "base" ? splitMarket(trade.market ?? "").base : splitMarket(trade.market ?? "").quote}`
                    : "0"}
                  <span className="fee-rate small" data-fee-rate={feeRate.rate}>
                    {" "}
                    · {feeRate.tier ? `${feeRate.tier} ` : ""}
                    {formatRate(feeRate.rate)}
                  </span>
                </td>
                <td className="num">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-trade-journal={trade.tradeId}
                    onClick={(event) => {
                      event.stopPropagation();
                      setJournalTradeId(trade.tradeId);
                    }}
                  >
                    T 型账户
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TradeJournalModal tradeId={journalTradeId} onClose={() => setJournalTradeId(null)} />
    </div>
  );
}

export function BalancesTable(props: { compact?: boolean }) {
  const { state, assets } = useExchange();
  if (!state.token) {
    return <LoginGate />;
  }
  if (assets.length === 0) {
    return (
      <Empty
        icon="◎"
        title="暂无资产"
        hint="可以在资产页领取测试币，体验完整的充值入账流程。"
        action={
          <Button size="sm" variant="primary" onClick={() => navigate("/assets")}>
            去充值
          </Button>
        }
      />
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table" id="balances-table">
        <thead>
          <tr>
            <th>币种</th>
            <th className="num">可用</th>
            <th className="num">冻结</th>
            <th className="num">总额</th>
            {props.compact ? null : <th className="num">操作</th>}
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => {
            // First configured market that trades this asset as base (none for quote-only assets).
            const tradeMarket = state.config?.markets.find((item) => item.baseAsset === asset.assetCode)?.market;
            return (
            <tr key={asset.assetCode}>
              <td>
                <span className="pair">
                  <AssetIcon asset={asset.assetCode} />
                  <b>{asset.assetCode}</b>
                </span>
              </td>
              <td className="num">{formatAmount(asset.available, 8)}</td>
              <td className="num muted" title="已下单未成交或提现审核中的资金">
                {formatAmount(asset.locked, 8)}
              </td>
              <td className="num">{formatAmount(asset.total, 8)}</td>
              {props.compact ? null : (
                <td className="num actions">
                  <a href={href(`/assets?action=deposit&asset=${asset.assetCode}`)}>充值</a>
                  <a href={href(`/assets?action=withdraw&asset=${asset.assetCode}`)}>提现</a>
                  {tradeMarket ? <a href={href(`/trade/${tradeMarket}`)}>交易</a> : null}
                </td>
              )}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
