// Post-only / self-trade prevention / stop-order helpers for the order form,
// order tables and learning mode. Pure functions so they can be unit tested.
import type { OrderRecord, OrderSide, OrderType } from "./types.js";

export function isStopType(type: OrderType | string | undefined): type is "stop_limit" | "stop_market" {
  return type === "stop_limit" || type === "stop_market";
}

/** The order type the matching engine sees once a stop order has triggered. */
export function engineTypeOf(type: OrderType | string | undefined): "limit" | "market" {
  return type === "market" || type === "stop_market" ? "market" : "limit";
}

export function describeOrderType(order: Pick<OrderRecord, "type" | "timeInForce" | "postOnly">): string {
  const tif = order.timeInForce?.toUpperCase() ?? "GTC";
  switch (order.type) {
    case "market":
      return "市价";
    case "stop_market":
      return "止损市价";
    case "stop_limit":
      return `止损限价 · ${tif}`;
    default:
      return `限价 · ${tif}${order.postOnly ? " · 只做Maker" : ""}`;
  }
}

const REASON_LABELS: Record<string, string> = {
  post_only_would_take: "只做 Maker：下单会立即成交，已拒绝",
  post_only_requires_limit: "只做 Maker 仅支持限价单",
  stp_expired_taker: "自成交保护：会与自己的挂单成交，新订单剩余部分已过期",
  stp_expired_maker: "自成交保护：被自己的新订单撤销",
  stp_expired_both: "自成交保护：挂单与新订单剩余部分均已过期",
  fok_liquidity_not_found: "FOK：没有可成交的对手盘",
  fok_quantity_not_met: "FOK：对手盘不足以一次全部成交",
  no_executable_liquidity: "没有可成交的对手盘，剩余数量已撤销"
};

/** Human label for an engine / risk reason code; unknown reasons pass through. */
export function describeOrderReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  return REASON_LABELS[reason] ?? reason;
}

/**
 * Explains when a stop order will fire relative to the current price.
 * Buy stops fire when the last price rises to the trigger (>=), sell stops
 * when it falls to the trigger (<=); a trigger already crossed fires on the
 * next price check.
 */
export function stopTriggerHint(side: OrderSide, triggerPrice: number, lastPrice: number): string | null {
  if (!(triggerPrice > 0)) {
    return null;
  }
  if (!(lastPrice > 0)) {
    return side === "buy" ? "最新成交价 ≥ 触发价时提交" : "最新成交价 ≤ 触发价时提交";
  }
  if (side === "buy") {
    return triggerPrice <= lastPrice
      ? "触发价不高于最新价：下一次价格检查就会触发"
      : `最新成交价涨到 ${triggerPrice} 及以上时提交到撮合引擎`;
  }
  return triggerPrice >= lastPrice
    ? "触发价不低于最新价：下一次价格检查就会触发"
    : `最新成交价跌到 ${triggerPrice} 及以下时提交到撮合引擎`;
}
