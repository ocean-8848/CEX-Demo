import { isStopOrderType, isStopTriggered } from "@web3-cex/domain";

import type { SpotOrderRecord } from "../domain/types.js";

/**
 * Pure trigger rule for stop orders: an order in `pending_trigger` fires when
 * the last trade price crosses its trigger price (buy: last >= trigger,
 * sell: last <= trigger). Returned oldest first so triggering is deterministic.
 */
export function selectTriggeredStopOrders(
  orders: SpotOrderRecord[],
  lastPrice: string
): SpotOrderRecord[] {
  return orders
    .filter(
      (order) =>
        order.status === "pending_trigger" &&
        isStopOrderType(order.type) &&
        typeof order.triggerPrice === "string" &&
        isStopTriggered(order.side, order.triggerPrice, lastPrice)
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.orderId.localeCompare(right.orderId)
    );
}
