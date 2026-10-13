import { createHash } from "node:crypto";

import {
  DEFAULT_TRADE_EVENT_VERSION_GATE,
  getSpotMarketDefinition,
  addAmounts,
  compareAmounts,
  fromAtomicUnits,
  getTradeExecutedEventSchema,
  multiplyAmounts,
  subtractAmounts,
  toAtomicUnits,
  type Order,
  type SpotMarketDefinition,
  type SpotMarket,
  type Trade,
  type TradeEventVersionGate,
  type TradingEvent,
  validateTradeExecutedEvent
} from "@web3-cex/domain";
import { currentTraceId } from "@web3-cex/telemetry";

import { OrderServiceError } from "../domain/errors.js";
import type {
  LedgerOrderClient,
  MatchingEngineClient,
  RiskOrderClient,
  SettlementOrderClient
} from "../domain/clients.js";
import type { OrderEventPublisher } from "../domain/event-publisher.js";
import type { OrderRepository } from "../domain/repository.js";
import type {
  CancelSpotOrderCommand,
  CreateSpotOrderCommand,
  ListSpotOrderAutomationExecutionsQuery,
  ListSpotOrderRecoveryJobsQuery,
  ListSpotOrdersQuery,
  ListSpotTradesQuery,
  SpotOrderAutomationExecution,
  SpotOrderRecord,
  SpotOrderRecoveryMetrics,
  SpotOrderRecoveryJob,
  SpotTradeRecord
} from "../domain/types.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  eventPublisher?: OrderEventPublisher;
  recoveryDelayMs?: number;
  recoveryMaxAttempts?: number;
  recoveryLeaseMs?: number;
  tradeEventVersionGate?: TradeEventVersionGate;
  settlementMode?: "sync" | "async";
}

interface RecoveryPlan {
  jobId: string;
  stage: SpotOrderRecoveryJob["stage"];
  originalOrder: SpotOrderRecord;
  takerNextOrder: SpotOrderRecord;
  makerNextOrders: SpotOrderRecord[];
  trades: SpotTradeRecord[];
  releaseAmount: string;
}

export class OrderApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly eventPublisher: OrderEventPublisher;
  private readonly recoveryDelayMs: number;
  private readonly recoveryMaxAttempts: number;
  private readonly recoveryLeaseMs: number;
  private readonly tradeEventVersionGate: TradeEventVersionGate;
  private readonly settlementMode: "sync" | "async";

  constructor(
    private readonly repository: OrderRepository,
    private readonly riskClient: RiskOrderClient,
    private readonly ledgerClient: LedgerOrderClient,
    private readonly settlementClient: SettlementOrderClient,
    private readonly matchingEngineClient: MatchingEngineClient,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }

        return `order_${Date.now()}`;
      });
    this.eventPublisher = options.eventPublisher ?? {
      async publish() {}
    };
    this.recoveryDelayMs = options.recoveryDelayMs ?? 5_000;
    this.recoveryMaxAttempts = options.recoveryMaxAttempts ?? 20;
    this.recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
    this.tradeEventVersionGate =
      options.tradeEventVersionGate ?? DEFAULT_TRADE_EVENT_VERSION_GATE;
    this.settlementMode = options.settlementMode ?? "sync";
  }

  async createOrder(command: CreateSpotOrderCommand): Promise<SpotOrderRecord> {
    const existing = await this.repository.findOrderByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return existing;
    }

    const riskDecision = await this.riskClient.validateSpotOrder({
      userId: command.userId,
      accountId: command.accountId,
      market: command.market,
      side: command.side,
      type: command.type,
      timeInForce: command.timeInForce,
      price: command.price,
      quantity: command.quantity
    });

    const createdAt = this.now().toISOString();
    const orderId = this.createId();
    const order: SpotOrderRecord = {
      orderId,
      idempotencyKey: command.idempotencyKey,
      traceId: command.traceId ?? `spot_order:${orderId}`,
      otelTraceId: currentTraceId(),
      userId: command.userId,
      accountId: command.accountId,
      market: command.market,
      side: command.side,
      type: command.type,
      timeInForce: riskDecision.timeInForce,
      price: command.price ?? "0",
      quantity: command.quantity,
      filledQuantity: "0",
      restingQuantity: "0",
      status: "pending_risk",
      lockAssetCode: riskDecision.lockAssetCode,
      lockAmount: riskDecision.lockAmount,
      createdAt,
      updatedAt: createdAt
    };

    await this.repository.saveOrder(order);

    await this.ledgerClient.freezeBalance({
      accountId: command.accountId,
      assetCode: riskDecision.lockAssetCode,
      amount: riskDecision.lockAmount,
      referenceType: "spot_order",
      referenceId: orderId
    });

    let compensationRequired = false;

    try {
      const engineResult = await this.matchingEngineClient.submitOrder({
        orderId,
        market: command.market,
        side: command.side,
        type: command.type,
        timeInForce: riskDecision.timeInForce,
        price: command.price,
        quantity: command.quantity,
        createdAt
      });

      if (engineResult.outcome === "resting") {
        const acceptedOrder = {
          ...order,
          restingQuantity: order.quantity,
          status: "accepted" as const,
          updatedAt: this.now().toISOString()
        };
        await this.repository.saveOrder(acceptedOrder);
        await this.publishOrderEvent("order.accepted", acceptedOrder);
        return acceptedOrder;
      }

      if (engineResult.outcome === "cancelled" || engineResult.trades.length === 0) {
        await this.ledgerClient.releaseBalance({
          accountId: order.accountId,
          assetCode: order.lockAssetCode,
          referenceType: "spot_order",
          referenceId: order.orderId
        });

        const rejectedOrder: SpotOrderRecord = {
          ...order,
          status: "rejected",
          restingQuantity: "0",
          rejectedReason:
            engineResult.reason ??
            `${order.type}:${order.timeInForce} could not find executable liquidity`,
          updatedAt: this.now().toISOString()
        };
        await this.repository.saveOrder(rejectedOrder);
        await this.publishOrderEvent("order.rejected", rejectedOrder);
        return rejectedOrder;
      }

      compensationRequired = true;
      const makerOrders = await this.loadMakerOrders(engineResult);
      const recoveryPlan = this.buildRecoveryPlan(order, engineResult, makerOrders);
      await this.repository.saveRecoveryJob(this.createRecoveryJob(recoveryPlan));

      try {
        const takerNextOrder = await this.executeRecoveryPlan(recoveryPlan);
        compensationRequired = false;
        await this.completeRecoveryJob(recoveryPlan.jobId);
        return takerNextOrder;
      } catch (error) {
        await this.failRecoveryJob(recoveryPlan, error, 1);
        compensationRequired = false;
        return this.markOrderRecoveryPending(order, recoveryPlan.jobId, error);
      }
    } catch (error) {
      if (compensationRequired) {
        await this.compensateByReplayingBook(order.market);
      }

      await this.ledgerClient.releaseBalance({
        accountId: order.accountId,
        assetCode: order.lockAssetCode,
        referenceType: "spot_order",
        referenceId: order.orderId
      });

      const rejectedOrder: SpotOrderRecord = {
        ...order,
        status: "rejected",
        restingQuantity: "0",
        rejectedReason: readErrorMessage(error),
        updatedAt: this.now().toISOString()
      };
      await this.repository.saveOrder(rejectedOrder);
      await this.publishOrderEvent("order.rejected", rejectedOrder);

      throw error;
    }
  }

  async cancelOrder(command: CancelSpotOrderCommand): Promise<SpotOrderRecord> {
    const order = await this.repository.findOrderById(command.orderId);
    if (!order || order.userId !== command.userId) {
      throw new OrderServiceError("ORDER_NOT_FOUND", 404, `Order ${command.orderId} not found`);
    }

    if (!this.isOrderOpen(order)) {
      if (order.status === "filled" || order.status === "cancelled" || order.status === "rejected") {
        return order;
      }

      throw new OrderServiceError(
        "ORDER_NOT_CANCELLABLE",
        400,
        `Order ${command.orderId} is ${order.status} and cannot be cancelled`
      );
    }

    const cancelResult = await this.matchingEngineClient.cancelOrder({
      orderId: order.orderId,
      market: order.market
    });
    if (cancelResult.outcome === "not_found") {
      throw new OrderServiceError(
        "MATCHING_ENGINE_ORDER_NOT_FOUND",
        409,
        `Order ${order.orderId} is not present in matching engine`
      );
    }

    // Release only the funds backing the quantity that was actually removed
    // from the book. Fills that were matched but are still waiting for async
    // settlement keep their share of the lock; releasing the whole lock here
    // made those settlements fail with INVALID_BALANCE_LOCK_STATE.
    const cancelledQuantity = this.normalizeQuantity(
      order.market,
      cancelResult.cancelledQuantity ?? order.restingQuantity
    );
    const releaseAmount = this.calculateDesiredRemainingLock({
      ...order,
      restingQuantity: cancelledQuantity
    });
    if (compareAmounts(releaseAmount, "0") > 0) {
      await this.ledgerClient.releaseBalance({
        accountId: order.accountId,
        assetCode: order.lockAssetCode,
        referenceType: "spot_order",
        referenceId: order.orderId,
        amount: releaseAmount
      });
    }

    const cancelledAt = this.now().toISOString();
    const cancelledOrder: SpotOrderRecord = {
      ...order,
      restingQuantity: "0",
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt
    };
    await this.repository.saveOrder(cancelledOrder);
    await this.publishOrderEvent("order.cancelled", cancelledOrder);
    return cancelledOrder;
  }

  async getOrder(orderId: string): Promise<SpotOrderRecord | null> {
    return this.repository.findOrderById(orderId);
  }

  async listOrders(query: ListSpotOrdersQuery): Promise<SpotOrderRecord[]> {
    return this.repository.listOrders(query);
  }

  async listTrades(query: ListSpotTradesQuery): Promise<SpotTradeRecord[]> {
    return this.repository.listTrades(query);
  }

  async getTrade(tradeId: string): Promise<SpotTradeRecord | null> {
    return this.repository.findTradeById(tradeId);
  }

  async listTradeEvents(query: ListSpotTradesQuery): Promise<TradingEvent[]> {
    const trades = await this.repository.listTrades(query);
    return trades
      .sort((left, right) => left.executionSequence - right.executionSequence)
      .map((trade) => this.createTradeEvent(trade));
  }

  async acknowledgeTradeSettlement(command: {
    tradeId: string;
    settlementId: string;
  }): Promise<SpotTradeRecord | null> {
    return this.repository.updateTradeSettlement({
      tradeId: command.tradeId,
      settlementId: command.settlementId,
      settlementUpdatedAt: this.now().toISOString()
    });
  }

  async listAutomationExecutions(
    query: ListSpotOrderAutomationExecutionsQuery
  ): Promise<SpotOrderAutomationExecution[]> {
    return this.repository.listAutomationExecutions(query);
  }

  async listRecoveryJobs(
    query: ListSpotOrderRecoveryJobsQuery
  ): Promise<SpotOrderRecoveryJob[]> {
    return this.repository.listRecoveryJobs(query);
  }

  async listDeadLetterRecoveryJobs(
    query: Omit<ListSpotOrderRecoveryJobsQuery, "deadLettered">
  ): Promise<SpotOrderRecoveryJob[]> {
    return this.repository.listRecoveryJobs({
      ...query,
      deadLettered: true
    });
  }

  async getRecoveryMetrics(): Promise<SpotOrderRecoveryMetrics> {
    return this.repository.getRecoveryMetrics(this.now().toISOString());
  }

  async claimRecoveryJobs(
    limit = 20,
    workerId = this.createRecoveryWorkerId("worker")
  ): Promise<SpotOrderRecoveryJob[]> {
    const now = this.now();
    return this.repository.claimRecoveryJobs({
      workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.recoveryLeaseMs).toISOString(),
      limit: Math.max(limit, 1)
    });
  }

  async renewRecoveryLease(jobId: string, workerId: string): Promise<SpotOrderRecoveryJob> {
    const now = this.now();
    const renewed = await this.repository.renewRecoveryJobLease({
      jobId,
      workerId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.recoveryLeaseMs).toISOString()
    });

    if (!renewed) {
      throw new OrderServiceError(
        "RECOVERY_JOB_LEASE_NOT_HELD",
        409,
        `Recovery job ${jobId} is not currently leased by ${workerId}`
      );
    }

    return renewed;
  }

  async recoverOrder(jobId: string, workerId = this.createRecoveryWorkerId("manual")): Promise<SpotOrderRecoveryJob> {
    const job = await this.repository.findRecoveryJobById(jobId);
    if (!job) {
      throw new OrderServiceError("RECOVERY_JOB_NOT_FOUND", 404, `Recovery job ${jobId} not found`);
    }

    if (job.status === "completed") {
      return job;
    }

    const claimed = await this.repository.claimRecoveryJob({
      jobId,
      workerId,
      now: this.now().toISOString(),
      leaseExpiresAt: new Date(this.now().getTime() + this.recoveryLeaseMs).toISOString(),
      allowedStatuses: ["pending", "failed"]
    });
    if (!claimed) {
      throw new OrderServiceError(
        "RECOVERY_JOB_NOT_AVAILABLE",
        409,
        `Recovery job ${jobId} is currently leased or not recoverable`
      );
    }

    return this.processClaimedRecoveryJob(claimed.jobId, workerId);
  }

  async processClaimedRecoveryJob(
    jobId: string,
    workerId: string
  ): Promise<SpotOrderRecoveryJob> {
    const job = await this.repository.findRecoveryJobById(jobId);
    if (!job) {
      throw new OrderServiceError("RECOVERY_JOB_NOT_FOUND", 404, `Recovery job ${jobId} not found`);
    }

    if (job.status !== "processing" || job.leaseOwner !== workerId) {
      throw new OrderServiceError(
        "RECOVERY_JOB_LEASE_NOT_HELD",
        409,
        `Recovery job ${jobId} is not currently leased by ${workerId}`
      );
    }

    return this.recoverClaimedJob(job, workerId);
  }

  async requeueDeadLetterJob(jobId: string): Promise<SpotOrderRecoveryJob> {
    const job = await this.repository.findRecoveryJobById(jobId);
    if (!job) {
      throw new OrderServiceError("RECOVERY_JOB_NOT_FOUND", 404, `Recovery job ${jobId} not found`);
    }

    if (!job.deadLetteredAt) {
      throw new OrderServiceError(
        "RECOVERY_JOB_NOT_DEAD_LETTERED",
        409,
        `Recovery job ${jobId} is not dead-lettered`
      );
    }

    const requeued: SpotOrderRecoveryJob = {
      ...job,
      status: "pending",
      updatedAt: this.now().toISOString(),
      nextAttemptAt: this.now().toISOString(),
      completedAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseHeartbeatAt: undefined,
      deadLetteredAt: undefined,
      lastResult: "failed"
    };
    await this.repository.saveRecoveryJob(requeued);
    return requeued;
  }

  async batchRequeueDeadLetterJobs(query: {
    market?: SpotOrderRecord["market"];
    limit?: number;
  }): Promise<{ requeuedCount: number; jobIds: string[] }> {
    const jobs = await this.listDeadLetterRecoveryJobs({
      market: query.market,
      status: "failed",
      limit: Math.max(query.limit ?? 20, 1),
      offset: 0
    });
    const jobIds: string[] = [];

    for (const job of jobs) {
      await this.requeueDeadLetterJob(job.jobId);
      jobIds.push(job.jobId);
    }

    return {
      requeuedCount: jobIds.length,
      jobIds
    };
  }

  async recoverPendingOrders(limit = 20, workerId = this.createRecoveryWorkerId("worker")): Promise<{
    workerId: string;
    claimedCount: number;
    processedCount: number;
    completedCount: number;
    failedCount: number;
    deadLetteredCount: number;
    jobIds: string[];
  }> {
    const claimedJobs = await this.claimRecoveryJobs(limit, workerId);

    let completedCount = 0;
    let failedCount = 0;
    let deadLetteredCount = 0;
    for (const job of claimedJobs) {
      const result = await this.processClaimedRecoveryJob(job.jobId, workerId);
      if (result.status === "completed") {
        completedCount += 1;
      } else {
        failedCount += 1;
        if (result.deadLetteredAt) {
          deadLetteredCount += 1;
        }
      }
    }

    return {
      workerId,
      claimedCount: claimedJobs.length,
      processedCount: claimedJobs.length,
      completedCount,
      failedCount,
      deadLetteredCount,
      jobIds: claimedJobs.map((job) => job.jobId)
    };
  }

  private buildTrade(
    takerOrder: SpotOrderRecord,
    makerOrder: SpotOrderRecord,
    match: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>["trades"][number]
  ): SpotTradeRecord {
    const buyerOrder = takerOrder.side === "buy" ? takerOrder : makerOrder;
    const sellerOrder = takerOrder.side === "sell" ? takerOrder : makerOrder;
    const price = this.normalizePrice(takerOrder.market, match.price);
    const quantity = this.normalizeQuantity(takerOrder.market, match.quantity);

    return {
      tradeId: createStableUuid(`trade:${match.executionId}`),
      market: takerOrder.market,
      price,
      quantity,
      makerOrderId: makerOrder.orderId,
      takerOrderId: takerOrder.orderId,
      buyerOrderId: buyerOrder.orderId,
      sellerOrderId: sellerOrder.orderId,
      buyerUserId: buyerOrder.userId,
      sellerUserId: sellerOrder.userId,
      buyerAccountId: buyerOrder.accountId,
      sellerAccountId: sellerOrder.accountId,
      // Maker / taker rate per side; each side pays in the asset it receives.
      sellerFeeRate: this.resolveFeeRate(takerOrder.market, makerOrder.orderId, sellerOrder.orderId),
      buyerFeeRate: this.resolveFeeRate(takerOrder.market, makerOrder.orderId, buyerOrder.orderId),
      executionId: match.executionId,
      executionBatchId: match.executionBatchId,
      executionSequence: match.executionSequence,
      executionBatchSequence: match.executionBatchSequence,
      replayCursor: match.replayCursor,
      protocolVersion: match.protocolVersion,
      settlementId: "pending",
      executedAt: match.executedAt
    };
  }

  private buildRecoveryPlan(
    takerOrder: SpotOrderRecord,
    result: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>,
    makerOrders: Map<string, SpotOrderRecord>
  ): RecoveryPlan {
    const normalizedResult = this.normalizeMatchingResult(takerOrder.market, result);
    const updatedAt = this.now().toISOString();
    const tradePlans = normalizedResult.trades.map((match) => {
      const makerOrder = makerOrders.get(match.makerOrderId);
      if (!makerOrder) {
        throw new OrderServiceError(
          "MAKER_ORDER_NOT_FOUND",
          500,
          `Maker order ${match.makerOrderId} not found in repository`
        );
      }

      const trade = this.buildTrade(takerOrder, makerOrder, match);
      return {
        trade,
        makerNextOrder: this.buildMakerOrderAfterTrade(
          makerOrder,
          match.quantity,
          match.makerRemainingQuantity,
          updatedAt
        )
      };
    });

    const makerNextOrders = new Map<string, SpotOrderRecord>();
    for (const item of tradePlans) {
      makerNextOrders.set(item.makerNextOrder.orderId, item.makerNextOrder);
    }

    const takerNextOrder = this.buildTakerOrderAfterTrades(takerOrder, normalizedResult, updatedAt);
    const releaseAmount = this.calculateResidualReleaseAmount(
      takerOrder,
      takerNextOrder,
      tradePlans.map((item) => item.trade)
    );

    return {
      jobId: this.createId(),
      stage: "persist_matched_outcome",
      originalOrder: takerOrder,
      takerNextOrder,
      makerNextOrders: [...makerNextOrders.values()],
      trades: tradePlans.map((item) => item.trade),
      releaseAmount
    };
  }

  private buildMakerOrderAfterTrade(
    makerOrder: SpotOrderRecord,
    fillQuantity: string,
    remainingQuantity: string,
    updatedAt: string
  ): SpotOrderRecord {
    const normalizedFillQuantity = this.normalizeQuantity(makerOrder.market, fillQuantity);
    const normalizedRemainingQuantity = this.normalizeQuantity(makerOrder.market, remainingQuantity);
    const filledQuantity = this.normalizeQuantity(
      makerOrder.market,
      addAmounts(makerOrder.filledQuantity, normalizedFillQuantity)
    );
    return {
      ...makerOrder,
      filledQuantity,
      restingQuantity: normalizedRemainingQuantity,
      status: this.isZeroAmount(normalizedRemainingQuantity) ? "filled" : "partially_filled",
      updatedAt
    };
  }

  private buildTakerOrderAfterTrades(
    takerOrder: SpotOrderRecord,
    result: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>,
    updatedAt: string
  ): SpotOrderRecord {
    const matchedQuantity = this.normalizeQuantity(
      takerOrder.market,
      this.sumTradeQuantities(result.trades)
    );
    const filledQuantity = this.normalizeQuantity(
      takerOrder.market,
      addAmounts(takerOrder.filledQuantity, matchedQuantity)
    );
    const restingQuantity =
      result.takerStatus === "resting"
        ? this.normalizeQuantity(
            takerOrder.market,
            result.takerRemainingQuantity ?? subtractAmounts(takerOrder.quantity, filledQuantity)
          )
        : "0";

    let status: SpotOrderRecord["status"];
    let cancelledAt: string | undefined;
    let rejectedReason: string | undefined;

    if (result.takerStatus === "resting") {
      status = compareAmounts(filledQuantity, "0") > 0 ? "partially_filled" : "accepted";
    } else if (compareAmounts(filledQuantity, takerOrder.quantity) === 0) {
      status = "filled";
    } else if (compareAmounts(filledQuantity, "0") > 0) {
      status = "cancelled";
      cancelledAt = updatedAt;
    } else {
      status = "rejected";
      rejectedReason = result.reason ?? "Order was cancelled by matching engine";
    }

    return {
      ...takerOrder,
      filledQuantity,
      restingQuantity,
      status,
      cancelledAt,
      rejectedReason,
      updatedAt
    };
  }

  private calculateResidualReleaseAmount(
    originalOrder: SpotOrderRecord,
    updatedOrder: SpotOrderRecord,
    trades: SpotTradeRecord[]
  ): string {
    const desiredRemainingLock = this.calculateDesiredRemainingLock(updatedOrder);
    const consumedAmount = this.calculateConsumedLockAmount(updatedOrder, trades);
    const currentRemainingLock = subtractAmounts(originalOrder.lockAmount, consumedAmount);

    if (compareAmounts(currentRemainingLock, desiredRemainingLock) <= 0) {
      return "0";
    }

    return subtractAmounts(currentRemainingLock, desiredRemainingLock);
  }

  private calculateDesiredRemainingLock(order: SpotOrderRecord): string {
    if (this.isZeroAmount(order.restingQuantity)) {
      return "0";
    }

    if (order.side === "sell") {
      return order.restingQuantity;
    }

    return multiplyAmounts(order.price, order.restingQuantity);
  }

  private calculateConsumedLockAmount(order: SpotOrderRecord, trades: SpotTradeRecord[]): string {
    if (order.side === "sell") {
      return trades.reduce((total, trade) => addAmounts(total, trade.quantity), "0");
    }

    return trades.reduce(
      (total, trade) => addAmounts(total, multiplyAmounts(trade.price, trade.quantity)),
      "0"
    );
  }

  private normalizeMatchingResult(
    market: SpotMarket,
    result: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>
  ): Awaited<ReturnType<MatchingEngineClient["submitOrder"]>> {
    return {
      ...result,
      takerRemainingQuantity:
        result.takerRemainingQuantity === undefined
          ? undefined
          : this.normalizeQuantity(market, result.takerRemainingQuantity),
      trades: result.trades.map((trade) => ({
        ...trade,
        price: this.normalizePrice(market, trade.price),
        quantity: this.normalizeQuantity(market, trade.quantity),
        makerRemainingQuantity: this.normalizeQuantity(market, trade.makerRemainingQuantity)
      }))
    };
  }

  private normalizePrice(market: SpotMarket, amount: string): string {
    return roundAmountToStep(amount, this.getMarketDefinition(market).priceStep);
  }

  private normalizeQuantity(market: SpotMarket, amount: string): string {
    return roundAmountToStep(amount, this.getMarketDefinition(market).quantityStep);
  }

  private getMarketDefinition(market: SpotMarket): SpotMarketDefinition {
    const definition = getSpotMarketDefinition(market);
    if (!definition) {
      throw new OrderServiceError("UNSUPPORTED_MARKET", 400, `Market ${market} is not supported`);
    }

    return definition;
  }

  private isOrderOpen(order: SpotOrderRecord): boolean {
    return (
      (order.status === "accepted" || order.status === "partially_filled") &&
      compareAmounts(order.restingQuantity, "0") > 0
    );
  }

  private isZeroAmount(amount: string): boolean {
    return compareAmounts(amount, "0") === 0;
  }

  private resolveFeeRate(
    market: SpotMarket,
    makerOrderId: string,
    sideOrderId: string
  ): string {
    const definition = getSpotMarketDefinition(market);
    if (!definition) {
      throw new OrderServiceError("UNSUPPORTED_MARKET", 400, `Market ${market} is not supported`);
    }

    return makerOrderId === sideOrderId ? definition.makerFeeRate : definition.takerFeeRate;
  }

  private async publishTradeEvents(
    trades: SpotTradeRecord[],
    makerOrders: SpotOrderRecord[],
    takerOrder: SpotOrderRecord
  ): Promise<void> {
    const events: TradingEvent[] = [
      ...makerOrders.map((makerOrder) =>
        this.createOrderEvent(this.mapOrderEventType(makerOrder), makerOrder)
      ),
      this.createOrderEvent(this.mapOrderEventType(takerOrder), takerOrder),
      ...trades.map((trade) => this.createTradeEvent(trade))
    ];

    await this.publishSafely(events);
  }

  private async publishOrderEvent(
    eventType: TradingEvent["eventType"],
    order: SpotOrderRecord
  ): Promise<void> {
    await this.publishSafely([this.createOrderEvent(eventType, order)]);
  }

  private async publishSafely(events: TradingEvent[]): Promise<void> {
    const publishableEvents = events.filter((event) => {
      if (event.eventType !== "trade.executed") {
        return true;
      }

      try {
        validateTradeExecutedEvent(event, this.tradeEventVersionGate);
        return true;
      } catch (error) {
        console.warn(`order trade event validation failed: ${readErrorMessage(error)}`);
        return false;
      }
    });

    if (publishableEvents.length === 0) {
      return;
    }

    try {
      await this.eventPublisher.publish(publishableEvents);
    } catch (error) {
      console.warn(`order event publish failed: ${readErrorMessage(error)}`);
    }
  }

  private createOrderEvent(
    eventType: TradingEvent["eventType"],
    order: SpotOrderRecord
  ): TradingEvent {
    return {
      eventId: this.createId(),
      eventType,
      aggregateType: "spot_order",
      aggregateId: order.orderId,
      traceId: order.traceId,
      occurredAt: this.now().toISOString(),
      payload: {
        market: order.market,
        userIds: [order.userId],
        order: this.toDomainOrder(order)
      }
    };
  }

  private createTradeEvent(trade: SpotTradeRecord): TradingEvent {
    const schema = getTradeExecutedEventSchema(trade.protocolVersion);
    return {
      eventId: trade.executionId,
      eventType: "trade.executed",
      aggregateType: "spot_trade",
      aggregateId: trade.tradeId,
      traceId: `execution:${trade.executionId}`,
      occurredAt: trade.executedAt,
      schemaId: schema?.schemaId,
      schemaVersion: schema?.schemaVersion,
      payload: {
        market: trade.market,
        userIds: [trade.buyerUserId, trade.sellerUserId],
        trade: this.toDomainTrade(trade)
      }
    };
  }

  private mapOrderEventType(order: SpotOrderRecord): TradingEvent["eventType"] {
    switch (order.status) {
      case "accepted":
        return "order.accepted";
      case "cancelled":
        return "order.cancelled";
      case "rejected":
        return "order.rejected";
      default:
        return "order.updated";
    }
  }

  private toDomainOrder(order: SpotOrderRecord): Order {
    return {
      orderId: order.orderId,
      userId: order.userId,
      market: order.market,
      side: order.side,
      type: order.type,
      price: order.type === "market" ? null : order.price,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      restingQuantity: order.restingQuantity,
      timeInForce: order.timeInForce,
      status: order.status,
      createdAt: order.createdAt
    };
  }

  private toDomainTrade(trade: SpotTradeRecord): Trade {
    return {
      tradeId: trade.tradeId,
      market: trade.market,
      price: trade.price,
      quantity: trade.quantity,
      makerOrderId: trade.makerOrderId,
      takerOrderId: trade.takerOrderId,
      buyerOrderId: trade.buyerOrderId,
      sellerOrderId: trade.sellerOrderId,
      buyerUserId: trade.buyerUserId,
      sellerUserId: trade.sellerUserId,
      buyerAccountId: trade.buyerAccountId,
      sellerAccountId: trade.sellerAccountId,
      sellerFeeRate: trade.sellerFeeRate,
      buyerFeeRate: trade.buyerFeeRate,
      executedAt: trade.executedAt,
      executionId: trade.executionId,
      executionBatchId: trade.executionBatchId,
      executionSequence: trade.executionSequence,
      executionBatchSequence: trade.executionBatchSequence,
      replayCursor: trade.replayCursor,
      protocolVersion: trade.protocolVersion
    };
  }

  private async loadMakerOrders(
    result: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>
  ): Promise<Map<string, SpotOrderRecord>> {
    const makerOrderIds = [...new Set(result.trades.map((trade) => trade.makerOrderId))];
    const makerOrders = await Promise.all(
      makerOrderIds.map(async (makerOrderId) => {
        const makerOrder = await this.repository.findOrderById(makerOrderId);
        return makerOrder ? [makerOrderId, makerOrder] : null;
      })
    );

    return new Map(
      makerOrders.filter((item): item is [string, SpotOrderRecord] => item !== null)
    );
  }

  private sumTradeQuantities(
    trades: Awaited<ReturnType<MatchingEngineClient["submitOrder"]>>["trades"]
  ): string {
    return trades.reduce((total, trade) => addAmounts(total, trade.quantity), "0");
  }

  private async persistMatchedOutcome(
    makerNextOrders: SpotOrderRecord[],
    takerNextOrder: SpotOrderRecord,
    trades: SpotTradeRecord[]
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.repository.withTransaction(async (repository) => {
          for (const makerNextOrder of makerNextOrders) {
            await repository.saveOrder(makerNextOrder);
          }
          await repository.saveOrder(takerNextOrder);
          for (const trade of trades) {
            await repository.saveTrade(trade);
          }
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("failed to persist matched outcome");
  }

  private async executeRecoveryPlan(plan: RecoveryPlan): Promise<SpotOrderRecord> {
    const trades =
      this.settlementMode === "async"
        ? plan.trades.map((trade) => ({
            ...trade,
            settlementId: createStableUuid(`pending-settlement:${trade.tradeId}`)
          }))
        : await Promise.all(
            plan.trades.map(async (trade) => {
              const settlement = await this.settlementClient.settleTrade({
                tradeId: trade.tradeId,
                market: trade.market,
                price: trade.price,
                quantity: trade.quantity,
                buyerOrderId: trade.buyerOrderId,
                sellerOrderId: trade.sellerOrderId,
                buyerUserId: trade.buyerUserId,
                sellerUserId: trade.sellerUserId,
                buyerAccountId: trade.buyerAccountId,
                sellerAccountId: trade.sellerAccountId,
                sellerFeeRate: trade.sellerFeeRate,
                buyerFeeRate: trade.buyerFeeRate,
                executionId: trade.executionId,
                executionBatchId: trade.executionBatchId,
                executionSequence: trade.executionSequence,
                executionBatchSequence: trade.executionBatchSequence,
                replayCursor: trade.replayCursor,
                protocolVersion: trade.protocolVersion,
                traceId: plan.originalOrder.traceId
              });

              return {
                ...trade,
                settlementId: settlement.settlementId
              };
            })
          );

    await this.persistMatchedOutcome(plan.makerNextOrders, plan.takerNextOrder, trades);

    if (compareAmounts(plan.releaseAmount, "0") > 0) {
      await this.ledgerClient.releaseBalance({
        accountId: plan.originalOrder.accountId,
        assetCode: plan.originalOrder.lockAssetCode,
        referenceType: "spot_order",
        referenceId: plan.originalOrder.orderId,
        amount: plan.releaseAmount
      });
    }

    await this.publishTradeEvents(trades, plan.makerNextOrders, plan.takerNextOrder);
    return plan.takerNextOrder;
  }

  private createRecoveryJob(plan: RecoveryPlan): SpotOrderRecoveryJob {
    const now = this.now().toISOString();
    return {
      jobId: plan.jobId,
      orderId: plan.originalOrder.orderId,
      market: plan.originalOrder.market,
      stage: plan.stage,
      status: "pending",
      payload: serializeRecoveryPlan(plan),
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    };
  }

  private async completeRecoveryJob(
    jobId: string,
    durationMs?: number
  ): Promise<SpotOrderRecoveryJob> {
    const existing = await this.repository.findRecoveryJobById(jobId);
    if (!existing) {
      throw new OrderServiceError("RECOVERY_JOB_NOT_FOUND", 404, `Recovery job ${jobId} not found`);
    }

    const completedAt = this.now().toISOString();
    const completed: SpotOrderRecoveryJob = {
      ...existing,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      nextAttemptAt: completedAt,
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseHeartbeatAt: undefined,
      deadLetteredAt: undefined,
      lastDurationMs: durationMs,
      lastResult: "completed"
    };
    await this.repository.saveRecoveryJob(completed);
    return completed;
  }

  private async failRecoveryJob(
    plan: RecoveryPlan,
    error: unknown,
    attemptCount?: number,
    durationMs?: number
  ): Promise<SpotOrderRecoveryJob> {
    const existing = await this.repository.findRecoveryJobById(plan.jobId);
    const attempts = attemptCount ?? (existing?.attemptCount ?? 0);
    const updatedAt = this.now().toISOString();
    const exceededMaxAttempts = attempts >= this.recoveryMaxAttempts;
    const failedJob: SpotOrderRecoveryJob = {
      ...(existing ?? this.createRecoveryJob(plan)),
      status: exceededMaxAttempts ? "failed" : "pending",
      attemptCount: attempts,
      lastError: readErrorMessage(error),
      updatedAt,
      nextAttemptAt: exceededMaxAttempts
        ? updatedAt
        : new Date(this.now().getTime() + this.recoveryDelayMs * Math.max(attempts, 1)).toISOString(),
      completedAt: exceededMaxAttempts ? updatedAt : existing?.completedAt,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseHeartbeatAt: undefined,
      deadLetteredAt: exceededMaxAttempts ? updatedAt : existing?.deadLetteredAt,
      lastDurationMs: durationMs,
      lastResult: exceededMaxAttempts ? "dead_lettered" : "failed"
    };
    await this.repository.saveRecoveryJob(failedJob);
    await this.compensateByReplayingBook(plan.originalOrder.market);
    if (exceededMaxAttempts) {
      await this.markOrderRecoveryTerminalFailure(plan.originalOrder, failedJob.jobId, error);
    }
    return failedJob;
  }

  private async markOrderRecoveryPending(
    order: SpotOrderRecord,
    jobId: string,
    error: unknown
  ): Promise<SpotOrderRecord> {
    const recoveryOrder: SpotOrderRecord = {
      ...order,
      status: "recovery_pending",
      rejectedReason: `recovery_job:${jobId}:${readErrorMessage(error)}`,
      updatedAt: this.now().toISOString()
    };
    await this.repository.saveOrder(recoveryOrder);
    await this.publishOrderEvent("order.updated", recoveryOrder);
    return recoveryOrder;
  }

  private async markOrderRecoveryTerminalFailure(
    order: SpotOrderRecord,
    jobId: string,
    error: unknown
  ): Promise<void> {
    const failedOrder: SpotOrderRecord = {
      ...order,
      status: "recovery_pending",
      rejectedReason: `recovery_failed:${jobId}:${readErrorMessage(error)}`,
      updatedAt: this.now().toISOString()
    };
    await this.repository.saveOrder(failedOrder);
    await this.publishOrderEvent("order.updated", failedOrder);
  }

  private readRecoveryPlan(job: SpotOrderRecoveryJob): RecoveryPlan {
    return deserializeRecoveryPlan(job.payload);
  }

  private async recoverClaimedJob(
    job: SpotOrderRecoveryJob,
    workerId: string
  ): Promise<SpotOrderRecoveryJob> {
    if (job.leaseOwner !== workerId) {
      throw new OrderServiceError(
        "RECOVERY_JOB_LEASE_MISMATCH",
        409,
        `Recovery job ${job.jobId} is not leased by worker ${workerId}`
      );
    }

    const recoveryPlan = this.readRecoveryPlan(job);

    const startedAt = this.now().getTime();

    try {
      await this.executeRecoveryPlan(recoveryPlan);
      return this.completeRecoveryJob(job.jobId, this.now().getTime() - startedAt);
    } catch (error) {
      return this.failRecoveryJob(
        recoveryPlan,
        error,
        job.attemptCount,
        this.now().getTime() - startedAt
      );
    }
  }

  private createRecoveryWorkerId(scope: "manual" | "worker"): string {
    return `${scope}:${this.createId()}`;
  }

  private async compensateByReplayingBook(market: SpotMarket): Promise<void> {
    const startedAt = this.now();
    try {
      const [acceptedOrders, partiallyFilledOrders] = await Promise.all([
        this.repository.listOrders({ market, status: "accepted", limit: 500, offset: 0 }),
        this.repository.listOrders({ market, status: "partially_filled", limit: 500, offset: 0 })
      ]);

      const openOrders = [...acceptedOrders, ...partiallyFilledOrders]
        .filter((order) => compareAmounts(order.restingQuantity, "0") > 0)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      await this.matchingEngineClient.resetBook({ market });
      for (const openOrder of openOrders) {
        await this.matchingEngineClient.seedOrder({
          orderId: openOrder.orderId,
          market: openOrder.market,
          side: openOrder.side,
          price: openOrder.price,
          quantity: openOrder.restingQuantity,
          createdAt: openOrder.createdAt
        });
      }
      await this.persistAutomationExecutionSafely({
        executionType: "compensation_replay",
        status: "succeeded",
        trigger: "automatic",
        market,
        summary: {
          replayedOrderCount: openOrders.length,
          replayedOrderIds: openOrders.map((order) => order.orderId)
        },
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        durationMs: this.now().getTime() - startedAt.getTime()
      });
    } catch (error) {
      await this.persistAutomationExecutionSafely({
        executionType: "compensation_replay",
        status: "failed",
        trigger: "automatic",
        market,
        summary: {},
        errorMessage: readErrorMessage(error),
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        durationMs: this.now().getTime() - startedAt.getTime()
      });
      console.warn(
        `order compensation replay failed for ${market}: ${readErrorMessage(error)}`
      );
    }
  }

  async recordAutomationExecution(
    execution: Omit<SpotOrderAutomationExecution, "executionId"> & { executionId?: string }
  ): Promise<SpotOrderAutomationExecution> {
    const record: SpotOrderAutomationExecution = {
      ...execution,
      executionId: execution.executionId ?? this.createId()
    };
    await this.repository.saveAutomationExecution(record);
    return record;
  }

  async persistAutomationExecutionSafely(
    execution: Omit<SpotOrderAutomationExecution, "executionId"> & { executionId?: string }
  ): Promise<void> {
    try {
      await this.recordAutomationExecution(execution);
    } catch (error) {
      console.warn(`order automation execution persistence failed: ${readErrorMessage(error)}`);
    }
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown order error";
}

export function createStableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  const version = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

function roundAmountToStep(amount: string, step: string): string {
  const valueAtomic = toAtomicUnits(amount);
  const stepAtomic = toAtomicUnits(step);
  if (stepAtomic <= 0n) {
    throw new Error("Step must be greater than zero");
  }

  const roundedAtomic = ((valueAtomic + stepAtomic / 2n) / stepAtomic) * stepAtomic;
  return fromAtomicUnits(roundedAtomic);
}

function serializeRecoveryPlan(plan: RecoveryPlan): Record<string, unknown> {
  return {
    jobId: plan.jobId,
    stage: plan.stage,
    originalOrder: plan.originalOrder,
    takerNextOrder: plan.takerNextOrder,
    makerNextOrders: plan.makerNextOrders,
    trades: plan.trades,
    releaseAmount: plan.releaseAmount
  };
}

function deserializeRecoveryPlan(payload: Record<string, unknown>): RecoveryPlan {
  const record = payload as unknown as RecoveryPlan;
  return {
    jobId: record.jobId,
    stage: record.stage,
    originalOrder: record.originalOrder,
    takerNextOrder: record.takerNextOrder,
    makerNextOrders: record.makerNextOrders,
    trades: record.trades,
    releaseAmount: record.releaseAmount
  };
}
