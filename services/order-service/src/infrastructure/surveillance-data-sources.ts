import { compareAmounts, multiplyAmounts } from "@web3-cex/domain";
import type { Pool } from "pg";

import type { OrderRepository } from "../domain/repository.js";
import type {
  SurveillanceActivity,
  SurveillanceActivityQuery,
  SurveillanceCancelledOrderRow,
  SurveillanceDataSource,
  SurveillanceTradeRow
} from "../domain/surveillance-data.js";

interface TradeRow {
  trade_id: string;
  market: string;
  price: string;
  quantity: string;
  buyer_user_id: string;
  seller_user_id: string;
  buyer_order_id: string;
  seller_order_id: string;
  maker_order_id: string;
  taker_order_id: string;
  executed_at: Date | string;
}

interface OrderRow {
  order_id: string;
  user_id: string;
  market: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  created_at: Date | string;
  cancelled_at: Date | string;
}

export class PostgresSurveillanceDataSource implements SurveillanceDataSource {
  constructor(private readonly pool: Pool) {}

  async getActivity(query: SurveillanceActivityQuery): Promise<SurveillanceActivity> {
    const marketFilter = query.market ? "and market = $4" : "";
    const tradeValues: unknown[] = [query.since, query.until, query.tradeLimit + 1];
    if (query.market) {
      tradeValues.push(query.market);
    }
    const trades = await this.pool.query<TradeRow>(
      `select trade_id, market, price::text, quantity::text, buyer_user_id, seller_user_id,
              buyer_order_id, seller_order_id, maker_order_id, taker_order_id, executed_at
         from spot_trades
        where executed_at >= $1 and executed_at <= $2 ${marketFilter}
        order by executed_at desc
        limit $3`,
      tradeValues
    );

    const orderValues: unknown[] = [
      query.since,
      query.until,
      query.orderLimit + 1,
      query.orderMinNotional,
      query.orderMaxLifetimeMs / 1000
    ];
    orderValues.push(query.orderExcludeUserIds);
    if (query.market) {
      orderValues.push(query.market);
    }
    const orders = await this.pool.query<OrderRow>(
      `select order_id, user_id, market, side, price::text, quantity::text, created_at, cancelled_at
         from spot_orders
        where cancelled_at is not null
          and cancelled_at >= $1 and cancelled_at <= $2
          and status = 'cancelled'
          and filled_quantity = 0
          and price * quantity >= $4::numeric
          and extract(epoch from (cancelled_at - created_at)) <= $5
          and not (user_id = any($6::text[]))
          ${query.market ? "and market = $7" : ""}
        order by cancelled_at desc
        limit $3`,
      orderValues
    );

    const truncated = trades.rows.length > query.tradeLimit || orders.rows.length > query.orderLimit;
    return {
      since: query.since,
      until: query.until,
      trades: trades.rows.slice(0, query.tradeLimit).map((row) => ({
        tradeId: row.trade_id,
        market: row.market,
        price: trimDecimal(row.price),
        quantity: trimDecimal(row.quantity),
        buyerUserId: row.buyer_user_id,
        sellerUserId: row.seller_user_id,
        buyerOrderId: row.buyer_order_id,
        sellerOrderId: row.seller_order_id,
        makerOrderId: row.maker_order_id,
        takerOrderId: row.taker_order_id,
        executedAt: new Date(row.executed_at).toISOString()
      })),
      cancelledOrders: orders.rows.slice(0, query.orderLimit).map((row) => ({
        orderId: row.order_id,
        userId: row.user_id,
        market: row.market,
        side: row.side,
        price: trimDecimal(row.price),
        quantity: trimDecimal(row.quantity),
        createdAt: new Date(row.created_at).toISOString(),
        cancelledAt: new Date(row.cancelled_at).toISOString()
      })),
      truncated
    };
  }
}

/** Memory-mode source over the in-memory order repository. */
export class RepositorySurveillanceDataSource implements SurveillanceDataSource {
  constructor(private readonly repository: OrderRepository) {}

  async getActivity(query: SurveillanceActivityQuery): Promise<SurveillanceActivity> {
    const since = Date.parse(query.since);
    const until = Date.parse(query.until);
    const inWindow = (value: string | undefined) => {
      const time = value ? Date.parse(value) : Number.NaN;
      return time >= since && time <= until;
    };
    const allTrades = (await this.repository.listTrades({ market: query.market }))
      .filter((trade) => inWindow(trade.executedAt))
      .sort((left, right) => Date.parse(right.executedAt) - Date.parse(left.executedAt));
    const allOrders = (await this.repository.listOrders({ market: query.market, status: "cancelled" }))
      .filter(
        (order) =>
          inWindow(order.cancelledAt) &&
          !query.orderExcludeUserIds.includes(order.userId) &&
          compareAmounts(order.filledQuantity, "0") === 0 &&
          compareAmounts(multiplyAmounts(order.price, order.quantity), query.orderMinNotional) >= 0 &&
          Date.parse(order.cancelledAt as string) - Date.parse(order.createdAt) <= query.orderMaxLifetimeMs
      )
      .sort((left, right) => Date.parse(right.cancelledAt as string) - Date.parse(left.cancelledAt as string));
    const trades: SurveillanceTradeRow[] = allTrades.slice(0, query.tradeLimit).map((trade) => ({
      tradeId: trade.tradeId,
      market: trade.market,
      price: trade.price,
      quantity: trade.quantity,
      buyerUserId: trade.buyerUserId,
      sellerUserId: trade.sellerUserId,
      buyerOrderId: trade.buyerOrderId,
      sellerOrderId: trade.sellerOrderId,
      makerOrderId: trade.makerOrderId,
      takerOrderId: trade.takerOrderId,
      executedAt: trade.executedAt
    }));
    const cancelledOrders: SurveillanceCancelledOrderRow[] = allOrders.slice(0, query.orderLimit).map((order) => ({
      orderId: order.orderId,
      userId: order.userId,
      market: order.market,
      side: order.side,
      price: order.price,
      quantity: order.quantity,
      createdAt: order.createdAt,
      cancelledAt: order.cancelledAt as string
    }));
    return {
      since: query.since,
      until: query.until,
      trades,
      cancelledOrders,
      truncated: allTrades.length > query.tradeLimit || allOrders.length > query.orderLimit
    };
  }
}

function trimDecimal(value: string): string {
  if (!value.includes(".")) {
    return value;
  }
  return value.replace(/0+$/, "").replace(/\.$/, "") || "0";
}
