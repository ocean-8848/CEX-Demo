import { addAmounts, compareAmounts, multiplyAmounts } from "@web3-cex/domain";

import type { SpotOrderRecord, SpotTradeRecord } from "../domain/types.js";

/**
 * What the ledger's `spot_order` lock for one order should still hold,
 * according to order-service. Used by the ledger-service order-vs-lock
 * reconciliation: the ledger compares it with the lock's
 * `remaining_amount`.
 *
 *   expected = desired remaining lock (open quantity)
 *            + consumption of fills that settlement has not applied yet
 *
 * - buy limit:  desired = price × restingQuantity, a fill consumes trade.price × qty
 * - sell:       desired = restingQuantity,         a fill consumes qty
 * - terminal orders (filled / cancelled / rejected) desire 0, so only
 *   unsettled fills keep their lock alive.
 *
 * Orders that are still moving between services are flagged `inFlight` and
 * excluded from mismatch counting: `pending_risk` (lock may or may not exist
 * yet) and `recovery_pending` (matched outcome not persisted yet).
 *
 * `fills` lists every fill with the lock amount it consumes. The ledger uses
 * them instead of `unsettledAmount`: it checks in its own snapshot which
 * fills were already consumed, so a lost settlement acknowledgement (or a
 * fill settled by the recovery worker) cannot look like a mismatch.
 */
export interface OrderLockExpectation {
  orderId: string;
  accountId: string;
  userId: string;
  market: string;
  side: SpotOrderRecord["side"];
  status: SpotOrderRecord["status"];
  lockAssetCode: string;
  /** Amount the ledger lock should hold right now. */
  expectedLockAmount: string;
  /** Part of `expectedLockAmount` that backs the still-open quantity. */
  openLockAmount: string;
  /** Part of `expectedLockAmount` that unsettled fills will consume. */
  unsettledAmount: string;
  unsettledTradeCount: number;
  /** Every fill of this order: lock amount it consumes and whether settlement acknowledged it. */
  fills: Array<{ tradeId: string; amount: string; acknowledged: boolean }>;
  inFlight: boolean;
  inFlightReason?: "pending_risk" | "recovery_pending";
  updatedAt: string;
  /** Latest fill of this order (ISO), if any. */
  lastTradeAt?: string;
}

const IN_FLIGHT_STATUSES = new Set<SpotOrderRecord["status"]>(["pending_risk", "recovery_pending"]);

export function isOpenOrder(order: Pick<SpotOrderRecord, "status" | "restingQuantity">): boolean {
  return (
    (order.status === "accepted" || order.status === "partially_filled") &&
    compareAmounts(order.restingQuantity, "0") > 0
  );
}

/**
 * Lock that backs the open quantity (same rule order-service uses when
 * releasing on cancel). A stop order waiting for its trigger
 * (`pending_trigger`) keeps its whole freeze until it fires or is cancelled.
 */
export function openLockAmount(
  order: Pick<SpotOrderRecord, "side" | "price" | "restingQuantity" | "status" | "lockAmount">
): string {
  if (order.status === "pending_trigger") {
    return order.lockAmount;
  }
  if (!isOpenOrder(order)) {
    return "0";
  }
  return order.side === "sell" ? order.restingQuantity : multiplyAmounts(order.price, order.restingQuantity);
}

/** Lock a fill consumes from this order (settlement-service: base qty for the seller, price × qty for the buyer). */
export function fillLockConsumption(
  order: Pick<SpotOrderRecord, "side">,
  trade: Pick<SpotTradeRecord, "price" | "quantity">
): string {
  return order.side === "sell" ? trade.quantity : multiplyAmounts(trade.price, trade.quantity);
}

export function computeOrderLockExpectation(params: {
  order: SpotOrderRecord;
  /** Trades of this order (either side). */
  trades: SpotTradeRecord[];
  isTradeSettled: (trade: SpotTradeRecord) => boolean;
}): OrderLockExpectation {
  const { order } = params;
  let unsettledAmount = "0";
  let unsettledTradeCount = 0;
  let lastTradeAt: string | undefined;
  const fills: OrderLockExpectation["fills"] = [];
  for (const trade of params.trades) {
    if (trade.buyerOrderId !== order.orderId && trade.sellerOrderId !== order.orderId) {
      continue;
    }
    if (!lastTradeAt || trade.executedAt > lastTradeAt) {
      lastTradeAt = trade.executedAt;
    }
    const amount = fillLockConsumption(order, trade);
    const acknowledged = params.isTradeSettled(trade);
    fills.push({ tradeId: trade.tradeId, amount, acknowledged });
    if (!acknowledged) {
      unsettledAmount = addAmounts(unsettledAmount, amount);
      unsettledTradeCount += 1;
    }
  }
  const open = openLockAmount(order);
  const inFlight = IN_FLIGHT_STATUSES.has(order.status);
  return {
    orderId: order.orderId,
    accountId: order.accountId,
    userId: order.userId,
    market: order.market,
    side: order.side,
    status: order.status,
    lockAssetCode: order.lockAssetCode,
    expectedLockAmount: addAmounts(open, unsettledAmount),
    openLockAmount: open,
    unsettledAmount,
    unsettledTradeCount,
    fills,
    inFlight,
    inFlightReason: inFlight ? (order.status as "pending_risk" | "recovery_pending") : undefined,
    updatedAt: order.updatedAt,
    lastTradeAt
  };
}

/** Read side the lock-expectation report needs (implemented by both order repositories). */
export interface OrderLockSource {
  listOrdersForLockCheck(params: { orderIds: string[]; includeOpen: boolean }): Promise<SpotOrderRecord[]>;
  listTradesForOrders(orderIds: string[]): Promise<SpotTradeRecord[]>;
}

/** At most this many explicit order ids per request (the ledger sends its active locks in chunks). */
export const MAX_LOCK_EXPECTATION_ORDER_IDS = 2000;

/**
 * Builds the expectations for the open / in-flight orders (optional) plus the
 * explicitly requested ids (the ledger's active `spot_order` locks).
 * `isTradeSettled` decides whether settlement already consumed a fill.
 */
export async function buildOrderLockExpectations(params: {
  source: OrderLockSource;
  orderIds: string[];
  includeOpenOrders: boolean;
  isTradeSettled: (trade: SpotTradeRecord) => boolean;
  generatedAt: string;
}): Promise<{ generatedAt: string; items: OrderLockExpectation[] }> {
  const orders = await params.source.listOrdersForLockCheck({
    orderIds: params.orderIds,
    includeOpen: params.includeOpenOrders
  });
  const trades = await params.source.listTradesForOrders(orders.map((order) => order.orderId));
  const tradesByOrder = new Map<string, SpotTradeRecord[]>();
  for (const trade of trades) {
    for (const orderId of new Set([trade.buyerOrderId, trade.sellerOrderId])) {
      const list = tradesByOrder.get(orderId) ?? [];
      list.push(trade);
      tradesByOrder.set(orderId, list);
    }
  }
  return {
    generatedAt: params.generatedAt,
    items: orders.map((order) =>
      computeOrderLockExpectation({
        order,
        trades: tradesByOrder.get(order.orderId) ?? [],
        isTradeSettled: params.isTradeSettled
      })
    )
  };
}
