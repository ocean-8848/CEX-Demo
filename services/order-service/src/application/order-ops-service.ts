import { compareAmounts, type SpotMarket } from "@web3-cex/domain";

import type { MatchingEngineClient } from "../domain/clients.js";
import type { OrderRepository } from "../domain/repository.js";
import type { SpotOrderRecord } from "../domain/types.js";

export interface OrderOpsAnomaly {
  type: string;
  market: SpotMarket;
  orderId?: string;
  detail: string;
}

export interface OrderOpsOverview {
  generatedAt: string;
  market: SpotMarket;
  openOrderCount: number;
  filledOrderCount: number;
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  tradeCount: number;
  engineBidCount: number;
  engineAskCount: number;
  anomalyCount: number;
  status: "ok" | "alert";
}

export class OrderOpsService {
  constructor(
    private readonly repository: OrderRepository,
    private readonly matchingEngineClient: MatchingEngineClient
  ) {}

  async getOverview(market: SpotMarket): Promise<OrderOpsOverview> {
    const [openOrders, filledOrders, cancelledOrders, rejectedOrders, trades, anomalies, snapshot] =
      await Promise.all([
        this.listOpenOrders(market),
        this.repository.listOrders({ market, status: "filled", limit: 500, offset: 0 }),
        this.repository.listOrders({ market, status: "cancelled", limit: 500, offset: 0 }),
        this.repository.listOrders({ market, status: "rejected", limit: 500, offset: 0 }),
        this.repository.listTrades({ market, limit: 500, offset: 0 }),
        this.getAnomalies(market),
        this.matchingEngineClient.getBookSnapshot({ market, limit: 500 })
      ]);

    return {
      generatedAt: new Date().toISOString(),
      market,
      openOrderCount: openOrders.length,
      filledOrderCount: filledOrders.length,
      cancelledOrderCount: cancelledOrders.length,
      rejectedOrderCount: rejectedOrders.length,
      tradeCount: trades.length,
      engineBidCount: snapshot.bids.length,
      engineAskCount: snapshot.asks.length,
      anomalyCount: anomalies.length,
      status: anomalies.length > 0 ? "alert" : "ok"
    };
  }

  async getAnomalies(market: SpotMarket): Promise<OrderOpsAnomaly[]> {
    const [acceptedOrders, partiallyFilledOrders, snapshot] = await Promise.all([
      this.repository.listOrders({ market, status: "accepted", limit: 500, offset: 0 }),
      this.repository.listOrders({ market, status: "partially_filled", limit: 500, offset: 0 }),
      this.matchingEngineClient.getBookSnapshot({ market, limit: 500 })
    ]);

    const openOrders = [...acceptedOrders, ...partiallyFilledOrders];
    const engineOrderIds = new Set([...snapshot.bids, ...snapshot.asks].map((order) => order.orderId));
    const anomalies: OrderOpsAnomaly[] = [];

    for (const order of openOrders) {
      if (compareAmounts(order.restingQuantity, "0") <= 0) {
        anomalies.push({
          type: "db_open_order_without_resting_quantity",
          market,
          orderId: order.orderId,
          detail: `Order ${order.orderId} is ${order.status} but restingQuantity=${order.restingQuantity}`
        });
      }

      if (!engineOrderIds.has(order.orderId)) {
        anomalies.push({
          type: "engine_missing_open_order",
          market,
          orderId: order.orderId,
          detail: `Open order ${order.orderId} is missing from matching engine`
        });
      }
    }

    const openOrderIds = new Set(openOrders.map((order) => order.orderId));
    for (const engineOrder of [...snapshot.bids, ...snapshot.asks]) {
      if (!openOrderIds.has(engineOrder.orderId)) {
        anomalies.push({
          type: "engine_orphan_order",
          market,
          orderId: engineOrder.orderId,
          detail: `Matching engine order ${engineOrder.orderId} has no open DB order`
        });
      }
    }

    return anomalies;
  }

  /**
   * The engine keeps books and sequence counters in memory. After it restarts
   * it would count from 1 again and mint execution ids that already exist, so
   * new trades would be dropped as duplicates and skipped by settlement. When
   * the engine is behind the persisted cursor we raise its counters and
   * replay the open orders into the book.
   */
  async syncEngineState(market: SpotMarket): Promise<{
    market: SpotMarket;
    restored: boolean;
    nextExecutionSequence?: number;
    replayedOrderCount?: number;
  }> {
    if (!this.matchingEngineClient.restoreSequences) {
      return { market, restored: false };
    }

    const [snapshot, cursor] = await Promise.all([
      this.matchingEngineClient.getBookSnapshot({ market, limit: 1 }),
      this.repository.getExecutionCursor(market)
    ]);
    const engineNext = snapshot.nextExecutionSequence;
    if (engineNext === undefined || engineNext > cursor.executionSequence) {
      return { market, restored: false, nextExecutionSequence: engineNext };
    }

    const restored = await this.matchingEngineClient.restoreSequences({
      market,
      nextExecutionSequence: cursor.executionSequence + 1,
      nextBatchSequence: cursor.batchSequence + 1
    });
    const replay = await this.replayEngineBook(market);
    return {
      market,
      restored: true,
      nextExecutionSequence: restored.nextExecutionSequence,
      replayedOrderCount: replay.replayedOrderCount
    };
  }

  /**
   * Fault lab: empties the engine's in-memory book for one market while the
   * database still has the open orders, which surfaces as
   * `engine_missing_open_order` anomalies.
   *
   * - book only: sequence counters survive, so the periodic syncEngineState
   *   sees nothing wrong; repair with the manual "replay engine book" action.
   * - resetSequences: looks like an engine restart; syncEngineState notices the
   *   counters fell behind the DB cursor and restores + replays automatically.
   */
  async injectEngineReset(
    market: SpotMarket,
    options: { resetSequences?: boolean } = {}
  ): Promise<{
    market: SpotMarket;
    resetSequences: boolean;
    droppedBookOrderCount: number;
    anomalyCountAfter: number;
    healsAutomatically: boolean;
  }> {
    const resetSequences = options.resetSequences === true;
    const before = await this.matchingEngineClient.getBookSnapshot({ market, limit: 500 });
    await this.matchingEngineClient.resetBook({ market, resetSequences });
    const anomalies = await this.getAnomalies(market);
    return {
      market,
      resetSequences,
      droppedBookOrderCount: before.bids.length + before.asks.length,
      anomalyCountAfter: anomalies.length,
      healsAutomatically: resetSequences
    };
  }

  async replayEngineBook(market: SpotMarket): Promise<{
    market: SpotMarket;
    replayedOrderCount: number;
    replayedOrderIds: string[];
  }> {
    const openOrders = await this.listOpenOrders(market);
    await this.matchingEngineClient.resetBook({ market });

    const replayedOrderIds: string[] = [];
    for (const order of openOrders.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (compareAmounts(order.restingQuantity, "0") <= 0) {
        continue;
      }

      await this.matchingEngineClient.seedOrder({
        orderId: order.orderId,
        market: order.market,
        side: order.side,
        price: order.price,
        quantity: order.restingQuantity,
        createdAt: order.createdAt
      });
      replayedOrderIds.push(order.orderId);
    }

    return {
      market,
      replayedOrderCount: replayedOrderIds.length,
      replayedOrderIds
    };
  }

  private async listOpenOrders(market: SpotMarket): Promise<SpotOrderRecord[]> {
    const [acceptedOrders, partiallyFilledOrders] = await Promise.all([
      this.repository.listOrders({ market, status: "accepted", limit: 500, offset: 0 }),
      this.repository.listOrders({ market, status: "partially_filled", limit: 500, offset: 0 })
    ]);

    return [...acceptedOrders, ...partiallyFilledOrders].filter(
      (order) => compareAmounts(order.restingQuantity, "0") > 0
    );
  }
}
