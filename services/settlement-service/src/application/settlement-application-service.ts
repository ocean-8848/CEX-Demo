import { createHash } from "node:crypto";

import {
  DEFAULT_TRADE_EVENT_VERSION_GATE,
  getSpotMarketDefinition,
  addAmounts,
  buildTradeEventConsumerCheckpoint,
  compareAmounts,
  compareTradeExecutedEvents,
  fromAtomicUnits,
  multiplyAmounts,
  subtractAmounts,
  TRADE_EXECUTED_EVENT_SCHEMAS,
  toAtomicUnits,
  type TradeEventConsumerCheckpoint,
  type TradeEventVersionGate,
  type TradingEvent,
  validateTradeExecutedEvent
} from "@web3-cex/domain";

import { SettlementServiceError } from "../domain/errors.js";
import type { SettlementLedgerClient } from "../domain/ledger-client.js";
import type { SettlementRepository } from "../domain/repository.js";
import type {
  ConsumeTradeExecutionEventCommand,
  ConsumeTradeExecutionEventResult,
  ListTradeEventConsumerCheckpointsQuery,
  ListSettlementAutomationExecutionsQuery,
  ListSettlementRecoveryJobsQuery,
  ListTradeSettlementsQuery,
  ReplayTradeExecutionEventsCommand,
  ReplayTradeExecutionEventsResult,
  SettlementAutomationExecution,
  SettlementRecoveryMetrics,
  SettleTradeCommand,
  SettlementRecoveryJob,
  TradeSettlementEventBusReport,
  TradeSettlementReport,
  TradeSettlement
} from "../domain/types.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  recoveryDelayMs?: number;
  recoveryMaxAttempts?: number;
  recoveryLeaseMs?: number;
  tradeEventVersionGate?: TradeEventVersionGate;
}

export class SettlementApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly recoveryDelayMs: number;
  private readonly recoveryMaxAttempts: number;
  private readonly recoveryLeaseMs: number;
  private readonly tradeEventVersionGate: TradeEventVersionGate;

  constructor(
    private readonly repository: SettlementRepository,
    private readonly ledgerClient: SettlementLedgerClient,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }

        return `settlement_${Date.now()}`;
      });
    this.recoveryDelayMs = options.recoveryDelayMs ?? 5_000;
    this.recoveryMaxAttempts = options.recoveryMaxAttempts ?? 10;
    this.recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
    this.tradeEventVersionGate =
      options.tradeEventVersionGate ?? DEFAULT_TRADE_EVENT_VERSION_GATE;
  }

  async settleTrade(command: SettleTradeCommand): Promise<TradeSettlement> {
    const existing = await this.repository.findSettlementByTradeId(command.tradeId);
    if (existing?.status === "settled") {
      return existing;
    }

    try {
      return await this.executeSettlement(command, existing);
    } catch (error) {
      const terminal = await this.recordFailedAttempt(command, error, existing);
      throw this.buildRecoverableError(command.tradeId, error, terminal);
    }
  }

  async settleTrades(commands: SettleTradeCommand[]): Promise<TradeSettlement[]> {
    const settlements: TradeSettlement[] = [];

    for (const command of commands) {
      settlements.push(await this.settleTrade(command));
    }

    return settlements;
  }

  async replayTrade(command: SettleTradeCommand): Promise<TradeSettlement> {
    return this.recoverTrade(command.tradeId, command);
  }

  async recoverTrade(
    tradeId: string,
    fallbackCommand?: SettleTradeCommand,
    workerId = this.createRecoveryWorkerId("manual")
  ): Promise<TradeSettlement> {
    const settlement = await this.repository.findSettlementByTradeId(tradeId);
    if (settlement?.status === "settled") {
      return settlement;
    }

    const job = await this.repository.findRecoveryJobByTradeId(tradeId);
    const command = fallbackCommand ?? readRecoveryCommand(job);
    if (!command) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_JOB_NOT_FOUND",
        404,
        `Recovery job for trade ${tradeId} not found`
      );
    }

    if (!job && fallbackCommand) {
      const now = this.now().toISOString();
      await this.repository.saveRecoveryJob({
        jobId: this.createId(),
        tradeId,
        market: fallbackCommand.market,
        stage: "settle_trade",
        status: "pending",
        payload: serializeRecoveryCommand(fallbackCommand),
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now
      });
    }

    const claimed = await this.repository.claimRecoveryJob({
      tradeId,
      workerId,
      now: this.now().toISOString(),
      leaseExpiresAt: new Date(this.now().getTime() + this.recoveryLeaseMs).toISOString(),
      allowedStatuses: ["pending", "failed"]
    });
    if (!claimed) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_JOB_NOT_AVAILABLE",
        409,
        `Recovery job for trade ${tradeId} is currently leased or not recoverable`
      );
    }

    return this.processClaimedRecoveryJob(claimed.tradeId, workerId, fallbackCommand);
  }

  async processRecoveryJobs(limit = 20): Promise<{
    processedCount: number;
    completedCount: number;
    failedCount: number;
    tradeIds: string[];
  }> {
    const workerId = this.createRecoveryWorkerId("worker");
    const dueJobs = await this.claimRecoveryJobs(limit, workerId);

    let completedCount = 0;
    let failedCount = 0;

    for (const job of dueJobs) {
      try {
        await this.processClaimedRecoveryJob(job.tradeId, workerId);
        completedCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    return {
      processedCount: dueJobs.length,
      completedCount,
      failedCount,
      tradeIds: dueJobs.map((job) => job.tradeId)
    };
  }

  async listSettlements(query: ListTradeSettlementsQuery): Promise<TradeSettlement[]> {
    return this.repository.listSettlements(query);
  }

  async listRecoveryJobs(
    query: ListSettlementRecoveryJobsQuery
  ): Promise<SettlementRecoveryJob[]> {
    return this.repository.listRecoveryJobs(query);
  }

  async listAutomationExecutions(
    query: ListSettlementAutomationExecutionsQuery
  ): Promise<SettlementAutomationExecution[]> {
    return this.repository.listAutomationExecutions(query);
  }

  async listTradeEventConsumerCheckpoints(
    query: ListTradeEventConsumerCheckpointsQuery
  ): Promise<TradeEventConsumerCheckpoint[]> {
    return this.repository.listTradeEventConsumerCheckpoints(query);
  }

  async getTradeEventBusReport(
    query: ListTradeEventConsumerCheckpointsQuery = {}
  ): Promise<TradeSettlementEventBusReport> {
    return {
      generatedAt: this.now().toISOString(),
      versionGate: this.tradeEventVersionGate,
      schemas: TRADE_EXECUTED_EVENT_SCHEMAS,
      checkpoints: await this.repository.listTradeEventConsumerCheckpoints(query)
    };
  }

  async consumeTradeExecutionEvent(
    command: ConsumeTradeExecutionEventCommand
  ): Promise<ConsumeTradeExecutionEventResult> {
    const validated = validateTradeExecutedEvent(command.event, this.tradeEventVersionGate);
    const checkpoint = await this.repository.findTradeEventConsumerCheckpoint(
      command.consumerId,
      validated.trade.market as SettleTradeCommand["market"]
    );

    if (checkpoint) {
      if (validated.trade.executionSequence < checkpoint.lastExecutionSequence) {
        return await this.buildDuplicateEventResult(command.consumerId, validated.event, checkpoint);
      }
      if (
        validated.trade.executionSequence === checkpoint.lastExecutionSequence &&
        validated.trade.replayCursor <= checkpoint.lastReplayCursor
      ) {
        return await this.buildDuplicateEventResult(command.consumerId, validated.event, checkpoint);
      }
      if (
        !command.allowGap &&
        validated.trade.executionSequence > checkpoint.lastExecutionSequence + 1
      ) {
        throw new SettlementServiceError(
          "SETTLEMENT_EVENT_SEQUENCE_GAP",
          409,
          `Trade event sequence gap for ${command.consumerId}:${validated.trade.market}; expected <= ${(checkpoint.lastExecutionSequence + 1).toString()}, received ${validated.trade.executionSequence.toString()}`
        );
      }
    }

    let settlement: TradeSettlement;
    try {
      settlement = await this.settleTrade(this.toSettleTradeCommand(validated));
    } catch (error) {
      if (!isRecoveryHandoffError(error)) {
        throw error;
      }
      // settleTrade already persisted a recovery job for this trade, so the
      // recovery worker (or an operator) owns it from here. Advancing the
      // checkpoint avoids head-of-line blocking: every later trade in the
      // market would otherwise wait forever behind one poisoned event.
      const deferredCheckpoint = buildTradeEventConsumerCheckpoint(
        command.consumerId,
        validated.event,
        this.now().toISOString(),
        {
          lastStreamEntryId: command.streamEntryId,
          lastStreamPublishedAt: command.streamPublishedAt
        }
      );
      await this.repository.saveTradeEventConsumerCheckpoint(deferredCheckpoint);
      return {
        consumerId: command.consumerId,
        market: validated.trade.market as SettleTradeCommand["market"],
        tradeId: validated.trade.tradeId,
        executionSequence: validated.trade.executionSequence,
        replayCursor: validated.trade.replayCursor,
        protocolVersion: validated.protocolVersion,
        streamEntryId: command.streamEntryId,
        action: "deferred",
        error: readErrorMessage(error),
        checkpoint: deferredCheckpoint
      };
    }

    const nextCheckpoint = buildTradeEventConsumerCheckpoint(
      command.consumerId,
      validated.event,
      this.now().toISOString(),
      {
        lastStreamEntryId: command.streamEntryId,
        lastStreamPublishedAt: command.streamPublishedAt
      }
    );
    await this.repository.saveTradeEventConsumerCheckpoint(nextCheckpoint);

    return {
      consumerId: command.consumerId,
      market: validated.trade.market as SettleTradeCommand["market"],
      tradeId: validated.trade.tradeId,
      settlementId: settlement.settlementId,
      executionSequence: validated.trade.executionSequence,
      replayCursor: validated.trade.replayCursor,
      protocolVersion: validated.protocolVersion,
      streamEntryId: command.streamEntryId,
      action: "applied",
      checkpoint: nextCheckpoint
    };
  }

  async replayTradeExecutionEvents(
    command: ReplayTradeExecutionEventsCommand
  ): Promise<ReplayTradeExecutionEventsResult> {
    const results: ConsumeTradeExecutionEventResult[] = [];

    for (const event of [...command.events].sort(compareTradeExecutedEvents)) {
      results.push(
        await this.consumeTradeExecutionEvent({
          consumerId: command.consumerId,
          event,
          allowGap: command.allowGap
        })
      );
    }

    return {
      consumerId: command.consumerId,
      processedCount: results.length,
      appliedCount: results.filter((item) => item.action === "applied").length,
      duplicateCount: results.filter((item) => item.action === "duplicate").length,
      lastCheckpoint: results.at(-1)?.checkpoint,
      results
    };
  }

  async getRecoveryMetrics(): Promise<SettlementRecoveryMetrics> {
    return this.repository.getRecoveryMetrics(this.now().toISOString());
  }

  async claimRecoveryJobs(
    limit = 20,
    workerId = this.createRecoveryWorkerId("worker")
  ): Promise<SettlementRecoveryJob[]> {
    const now = this.now();
    return this.repository.claimRecoveryJobs({
      workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.recoveryLeaseMs).toISOString(),
      limit: Math.max(limit, 1)
    });
  }

  async renewRecoveryLease(tradeId: string, workerId: string): Promise<SettlementRecoveryJob> {
    const now = this.now();
    const renewed = await this.repository.renewRecoveryJobLease({
      tradeId,
      workerId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.recoveryLeaseMs).toISOString()
    });

    if (!renewed) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_JOB_LEASE_NOT_HELD",
        409,
        `Recovery job for trade ${tradeId} is not currently leased by ${workerId}`
      );
    }

    return renewed;
  }

  async processClaimedRecoveryJob(
    tradeId: string,
    workerId: string,
    fallbackCommand?: SettleTradeCommand
  ): Promise<TradeSettlement> {
    const job = await this.repository.findRecoveryJobByTradeId(tradeId);
    if (!job) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_JOB_NOT_FOUND",
        404,
        `Recovery job for trade ${tradeId} not found`
      );
    }

    if (job.status !== "processing" || job.leaseOwner !== workerId) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_JOB_LEASE_NOT_HELD",
        409,
        `Recovery job for trade ${tradeId} is not currently leased by ${workerId}`
      );
    }

    const command = fallbackCommand ?? readRecoveryCommand(job);
    if (!command) {
      throw new SettlementServiceError(
        "SETTLEMENT_RECOVERY_COMMAND_NOT_FOUND",
        404,
        `Recovery command for trade ${tradeId} not found`
      );
    }

    const settlement = await this.repository.findSettlementByTradeId(tradeId);
    const startedAt = this.now().getTime();

    try {
      const recovered = await this.executeSettlement(command, settlement);
      await this.completeRecoveryJob(job, this.now().getTime() - startedAt);
      return recovered;
    } catch (error) {
      const terminal = await this.recordFailedAttempt(
        command,
        error,
        settlement,
        job.attemptCount,
        job,
        this.now().getTime() - startedAt
      );
      throw this.buildRecoverableError(tradeId, error, terminal);
    }
  }

  async getSettlementReport(query: ListTradeSettlementsQuery): Promise<TradeSettlementReport> {
    if (this.canUseRollups(query)) {
      const rollups = await this.repository.getSettlementSummaryRollups({
        market: query.market,
        status: query.status,
        userId: query.userId,
        orderId: query.orderId
      });

      const summaryScopes = this.resolveSummaryScopes(query);
      const globalRows = rollups.filter((row) => summaryScopes.totalScopes.includes(row.scopeType));
      const marketRows = rollups.filter((row) =>
        summaryScopes.marketScopes.includes(
          row.scopeType as (typeof summaryScopes.marketScopes)[number]
        )
      );
      const totals = {
        settlementCount: 0,
        settledCount: 0,
        pendingRecoveryCount: 0,
        failedCount: 0,
        quantity: "0",
        quoteAmount: "0",
        feeAmount: "0"
      };
      const byMarket = new Map<string, TradeSettlementReport["markets"][number]>();
      let summaryUpdatedAt: string | undefined;

      for (const row of globalRows) {
        totals.settlementCount += row.settlementCount;
        totals.quantity = addAmounts(totals.quantity, row.quantity);
        totals.quoteAmount = addAmounts(totals.quoteAmount, row.quoteAmount);
        totals.feeAmount = addAmounts(totals.feeAmount, row.feeAmount);
        incrementSettlementStatus(totals, row.status, row.settlementCount);
        summaryUpdatedAt = maxIso(summaryUpdatedAt, row.updatedAt);
      }

      for (const row of marketRows) {
        const summary = byMarket.get(row.market ?? row.scopeKey) ?? {
          market: (row.market ?? row.scopeKey) as TradeSettlement["market"],
          settlementCount: 0,
          settledCount: 0,
          pendingRecoveryCount: 0,
          failedCount: 0,
          quantity: "0",
          quoteAmount: "0",
          feeAmount: "0",
          baseFeeAmount: "0"
        };

        summary.settlementCount += row.settlementCount;
        summary.quantity = addAmounts(summary.quantity, row.quantity);
        summary.quoteAmount = addAmounts(summary.quoteAmount, row.quoteAmount);
        summary.feeAmount = addAmounts(summary.feeAmount, row.feeAmount);
        summary.baseFeeAmount = addAmounts(summary.baseFeeAmount, row.baseFeeAmount);
        incrementSettlementStatus(summary, row.status, row.settlementCount);
        byMarket.set(summary.market, summary);
        summaryUpdatedAt = maxIso(summaryUpdatedAt, row.updatedAt);
      }

      return {
        generatedAt: this.now().toISOString(),
        filter: query,
        source: "materialized_summary",
        summaryUpdatedAt,
        totals,
        markets: [...byMarket.values()].sort((left, right) => left.market.localeCompare(right.market))
      };
    }

    const settlements = await this.repository.listSettlements({
      ...query,
      limit: Math.min(Math.max(query.limit ?? 500, 1), 1000),
      offset: query.offset ?? 0
    });
    const byMarket = new Map<string, TradeSettlementReport["markets"][number]>();

    const totals = {
      settlementCount: settlements.length,
      settledCount: 0,
      pendingRecoveryCount: 0,
      failedCount: 0,
      quantity: "0",
      quoteAmount: "0",
      feeAmount: "0"
    };

    for (const settlement of settlements) {
      const summary = byMarket.get(settlement.market) ?? {
        market: settlement.market,
        settlementCount: 0,
        settledCount: 0,
        pendingRecoveryCount: 0,
        failedCount: 0,
        quantity: "0",
        quoteAmount: "0",
        feeAmount: "0",
        baseFeeAmount: "0"
      };

      summary.settlementCount += 1;
      summary.quantity = addAmounts(summary.quantity, settlement.quantity);
      summary.quoteAmount = addAmounts(summary.quoteAmount, settlement.quoteAmount);
      summary.feeAmount = addAmounts(summary.feeAmount, settlement.feeAmount);
      summary.baseFeeAmount = addAmounts(summary.baseFeeAmount, settlement.buyerFeeAmount);
      incrementSettlementStatus(summary, settlement.status);
      byMarket.set(settlement.market, summary);

      totals.quantity = addAmounts(totals.quantity, settlement.quantity);
      totals.quoteAmount = addAmounts(totals.quoteAmount, settlement.quoteAmount);
      totals.feeAmount = addAmounts(totals.feeAmount, settlement.feeAmount);
      incrementSettlementStatus(totals, settlement.status);
    }

    return {
      generatedAt: this.now().toISOString(),
      filter: query,
      source: "raw_settlements",
      totals,
      markets: [...byMarket.values()].sort((left, right) => left.market.localeCompare(right.market))
    };
  }

  private canUseRollups(query: ListTradeSettlementsQuery): boolean {
    return !(query.userId && query.orderId);
  }

  private resolveSummaryScopes(query: ListTradeSettlementsQuery): {
    totalScopes: Array<
      "global" | "market" | "user" | "user_market" | "order" | "order_market"
    >;
    marketScopes: Array<"market" | "user_market" | "order_market">;
  } {
    if (query.userId) {
      return {
        totalScopes: query.market ? ["user_market"] : ["user"],
        marketScopes: ["user_market"]
      };
    }

    if (query.orderId) {
      return {
        totalScopes: query.market ? ["order_market"] : ["order"],
        marketScopes: ["order_market"]
      };
    }

    return {
      totalScopes: query.market ? ["market"] : ["global"],
      marketScopes: ["market"]
    };
  }

  private async executeSettlement(
    command: SettleTradeCommand,
    existing?: TradeSettlement | null
  ): Promise<TradeSettlement> {
    const market = getSpotMarketDefinition(command.market);
    if (!market) {
      throw new SettlementServiceError(
        "UNSUPPORTED_MARKET",
        400,
        `Market ${command.market} is not supported`
      );
    }

    const normalizedPrice = roundAmountToStep(command.price, market.priceStep);
    const normalizedQuantity = roundAmountToStep(command.quantity, market.quantityStep);
    const quoteAmount = multiplyAmounts(normalizedPrice, normalizedQuantity);
    // Each side pays its fee in the asset it receives: the seller in quote,
    // the buyer in base. Maker / taker rates were resolved by order-service.
    const feeAmount = multiplyAmounts(quoteAmount, command.sellerFeeRate);
    const sellerNetQuote = subtractAmounts(quoteAmount, feeAmount);
    const buyerFeeAmount = multiplyAmounts(normalizedQuantity, command.buyerFeeRate ?? "0");
    const buyerNetBase = subtractAmounts(normalizedQuantity, buyerFeeAmount);
    const traceId = command.traceId ?? `trade:${command.tradeId}`;
    const now = this.now().toISOString();

    const baseSettlementAccountId = await this.ensurePlatformAccount(
      `platform:spot:settlement:${market.baseAsset.toLowerCase()}`,
      "spot"
    );
    const quoteSettlementAccountId = await this.ensurePlatformAccount(
      `platform:spot:settlement:${market.quoteAsset.toLowerCase()}`,
      "spot"
    );
    const feeAccountId = await this.ensurePlatformAccount(
      `platform:spot:fee:${market.quoteAsset.toLowerCase()}`,
      "fee"
    );
    const baseFeeAccountId = await this.ensurePlatformAccount(
      `platform:spot:fee:${market.baseAsset.toLowerCase()}`,
      "fee"
    );

    await this.ledgerClient.consumeBalance({
      accountId: command.sellerAccountId,
      assetCode: market.baseAsset,
      referenceType: "spot_order",
      referenceId: command.sellerOrderId,
      amount: normalizedQuantity,
      settlementAccountId: baseSettlementAccountId,
      businessId: command.tradeId,
      traceId,
      description: `Consume seller lock for trade ${command.tradeId}`
    });

    await this.ledgerClient.consumeBalance({
      accountId: command.buyerAccountId,
      assetCode: market.quoteAsset,
      referenceType: "spot_order",
      referenceId: command.buyerOrderId,
      amount: quoteAmount,
      settlementAccountId: quoteSettlementAccountId,
      businessId: command.tradeId,
      traceId,
      description: `Consume buyer lock for trade ${command.tradeId}`
    });

    const baseJournal = await this.ledgerClient.postJournal({
      businessType: "spot_trade_settlement_base",
      businessId: command.tradeId,
      idempotencyKey: `spot_trade:base:${command.tradeId}`,
      traceId,
      description: `Settle base asset for trade ${command.tradeId}${describeAppliedFee("buyer", command.buyerFeeTier, command.buyerFeeRate)}`,
      entries: [
        {
          accountId: baseSettlementAccountId,
          assetCode: market.baseAsset,
          direction: "debit",
          amount: normalizedQuantity,
          referenceType: "spot_trade",
          referenceId: command.tradeId
        },
        {
          accountId: command.buyerAccountId,
          assetCode: market.baseAsset,
          direction: "credit",
          amount: buyerNetBase,
          referenceType: "spot_trade",
          referenceId: command.tradeId
        },
        ...(compareAmounts(buyerFeeAmount, "0") > 0
          ? [
              {
                accountId: baseFeeAccountId,
                assetCode: market.baseAsset,
                direction: "credit" as const,
                amount: buyerFeeAmount,
                referenceType: "spot_trade_fee",
                referenceId: command.tradeId
              }
            ]
          : [])
      ]
    });

    const quoteJournal = await this.ledgerClient.postJournal({
      businessType: "spot_trade_settlement_quote",
      businessId: command.tradeId,
      idempotencyKey: `spot_trade:quote:${command.tradeId}`,
      traceId,
      description: `Settle quote asset for trade ${command.tradeId}${describeAppliedFee("seller", command.sellerFeeTier, command.sellerFeeRate)}`,
      entries: [
        {
          accountId: quoteSettlementAccountId,
          assetCode: market.quoteAsset,
          direction: "debit",
          amount: quoteAmount,
          referenceType: "spot_trade",
          referenceId: command.tradeId
        },
        {
          accountId: command.sellerAccountId,
          assetCode: market.quoteAsset,
          direction: "credit",
          amount: sellerNetQuote,
          referenceType: "spot_trade",
          referenceId: command.tradeId
        },
        ...(compareAmounts(feeAmount, "0") > 0
          ? [
              {
                accountId: feeAccountId,
                assetCode: market.quoteAsset,
                direction: "credit" as const,
                amount: feeAmount,
                referenceType: "spot_trade_fee",
                referenceId: command.tradeId
              }
            ]
          : [])
      ]
    });

    const recoveryJob = await this.repository.findRecoveryJobByTradeId(command.tradeId);
    const attemptCount = Math.max(existing?.attemptCount ?? 0, recoveryJob?.attemptCount ?? 0, 1);

    const settlement: TradeSettlement = {
      settlementId: existing?.settlementId ?? this.createId(),
      tradeId: command.tradeId,
      market: command.market,
      price: normalizedPrice,
      quantity: normalizedQuantity,
      quoteAmount,
      feeAmount,
      buyerFeeAmount,
      ...appliedFeeFields(command),
      buyerOrderId: command.buyerOrderId,
      sellerOrderId: command.sellerOrderId,
      buyerUserId: command.buyerUserId,
      sellerUserId: command.sellerUserId,
      buyerAccountId: command.buyerAccountId,
      sellerAccountId: command.sellerAccountId,
      executionId: command.executionId,
      executionBatchId: command.executionBatchId,
      executionSequence: command.executionSequence,
      executionBatchSequence: command.executionBatchSequence,
      replayCursor: command.replayCursor,
      protocolVersion: command.protocolVersion,
      buyerSettlementJournalId: baseJournal.journalId,
      sellerSettlementJournalId: quoteJournal.journalId,
      status: "settled",
      attemptCount,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAttemptAt: now,
      settledAt: now
    };

    await this.repository.withTransaction(async (repository) => {
      await repository.saveSettlement(settlement);
      if (recoveryJob) {
        await repository.saveRecoveryJob({
          ...recoveryJob,
          status: "completed",
          attemptCount: settlement.attemptCount,
          lastError: undefined,
          updatedAt: now,
          nextAttemptAt: now,
          completedAt: now,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          lastClaimedAt: recoveryJob.lastClaimedAt,
          leaseHeartbeatAt: undefined,
          lastResult: "completed"
        });
      }
    });

    return settlement;
  }

  private async recordFailedAttempt(
    command: SettleTradeCommand,
    error: unknown,
    existing?: TradeSettlement | null,
    attemptCount?: number,
    existingJob?: SettlementRecoveryJob | null,
    durationMs?: number
  ): Promise<boolean> {
    const now = this.now().toISOString();
    const job = existingJob ?? (await this.repository.findRecoveryJobByTradeId(command.tradeId));
    const nextAttemptCount =
      attemptCount ?? Math.max(job?.attemptCount ?? 0, existing?.attemptCount ?? 0) + 1;
    const terminal = nextAttemptCount >= this.recoveryMaxAttempts;
    const message = readErrorMessage(error);
    const settlementId = existing?.settlementId ?? this.createId();
    const createdAt = existing?.createdAt ?? now;
    const market = getSpotMarketDefinition(command.market);
    const normalizedPrice = market
      ? roundAmountToStep(command.price, market.priceStep)
      : command.price;
    const normalizedQuantity = market
      ? roundAmountToStep(command.quantity, market.quantityStep)
      : command.quantity;
    const quoteAmount = multiplyAmounts(normalizedPrice, normalizedQuantity);
    const feeAmount = multiplyAmounts(quoteAmount, command.sellerFeeRate);
    const buyerFeeAmount = multiplyAmounts(normalizedQuantity, command.buyerFeeRate ?? "0");

    await this.repository.withTransaction(async (repository) => {
      await repository.saveSettlement({
        settlementId,
        tradeId: command.tradeId,
        market: command.market,
        price: normalizedPrice,
        quantity: normalizedQuantity,
        quoteAmount,
        feeAmount,
        buyerFeeAmount,
        ...appliedFeeFields(command),
        buyerOrderId: command.buyerOrderId,
        sellerOrderId: command.sellerOrderId,
        buyerUserId: command.buyerUserId,
        sellerUserId: command.sellerUserId,
        buyerAccountId: command.buyerAccountId,
        sellerAccountId: command.sellerAccountId,
        executionId: command.executionId,
        executionBatchId: command.executionBatchId,
        executionSequence: command.executionSequence,
        executionBatchSequence: command.executionBatchSequence,
        replayCursor: command.replayCursor,
        protocolVersion: command.protocolVersion,
        buyerSettlementJournalId: existing?.buyerSettlementJournalId,
        sellerSettlementJournalId: existing?.sellerSettlementJournalId,
        status: terminal ? "failed" : "pending_recovery",
        attemptCount: nextAttemptCount,
        lastError: message,
        createdAt,
        updatedAt: now,
        lastAttemptAt: now,
        settledAt: existing?.settledAt
      });

      await repository.saveRecoveryJob({
        jobId: job?.jobId ?? this.createId(),
        tradeId: command.tradeId,
        market: command.market,
        stage: "settle_trade",
        status: terminal ? "failed" : "pending",
        payload: serializeRecoveryCommand(command),
        attemptCount: nextAttemptCount,
        lastError: message,
        nextAttemptAt: terminal
          ? now
          : new Date(
              this.now().getTime() + this.recoveryDelayMs * Math.max(nextAttemptCount, 1)
            ).toISOString(),
        createdAt: job?.createdAt ?? createdAt,
        updatedAt: now,
        completedAt: terminal ? now : undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastClaimedAt: job?.lastClaimedAt,
        leaseHeartbeatAt: undefined,
        lastDurationMs: durationMs,
        lastResult: "failed"
      });
    });
    return terminal;
  }

  private async completeRecoveryJob(
    job: SettlementRecoveryJob,
    durationMs?: number
  ): Promise<void> {
    const now = this.now().toISOString();
    await this.repository.saveRecoveryJob({
      ...job,
      status: "completed",
      lastError: undefined,
      updatedAt: now,
      nextAttemptAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseHeartbeatAt: undefined,
      lastDurationMs: durationMs,
      lastResult: "completed"
    });
  }

  private async buildDuplicateEventResult(
    consumerId: string,
    event: TradingEvent,
    checkpoint: TradeEventConsumerCheckpoint
  ): Promise<ConsumeTradeExecutionEventResult> {
    const validated = validateTradeExecutedEvent(event, this.tradeEventVersionGate);
    const settlement = await this.repository.findSettlementByTradeId(validated.trade.tradeId);
    return {
      consumerId,
      market: validated.trade.market as SettleTradeCommand["market"],
      tradeId: validated.trade.tradeId,
      settlementId: settlement?.settlementId,
      executionSequence: validated.trade.executionSequence,
      replayCursor: validated.trade.replayCursor,
      protocolVersion: validated.protocolVersion,
      streamEntryId: checkpoint.lastStreamEntryId,
      action: "duplicate",
      checkpoint
    };
  }

  private toSettleTradeCommand(
    validated: ReturnType<typeof validateTradeExecutedEvent>
  ): SettleTradeCommand {
    return {
      tradeId: validated.trade.tradeId,
      market: validated.trade.market as SettleTradeCommand["market"],
      price: validated.trade.price,
      quantity: validated.trade.quantity,
      buyerOrderId: validated.trade.buyerOrderId,
      sellerOrderId: validated.trade.sellerOrderId,
      buyerUserId: validated.trade.buyerUserId,
      sellerUserId: validated.trade.sellerUserId,
      buyerAccountId: validated.trade.buyerAccountId,
      sellerAccountId: validated.trade.sellerAccountId,
      sellerFeeRate: validated.trade.sellerFeeRate,
      buyerFeeRate: validated.trade.buyerFeeRate,
      sellerFeeTier: validated.trade.sellerFeeTier,
      buyerFeeTier: validated.trade.buyerFeeTier,
      executionId: validated.trade.executionId,
      executionBatchId: validated.trade.executionBatchId,
      executionSequence: validated.trade.executionSequence,
      executionBatchSequence: validated.trade.executionBatchSequence,
      replayCursor: validated.trade.replayCursor,
      protocolVersion: validated.trade.protocolVersion,
      traceId: validated.event.traceId
    };
  }

  private buildRecoverableError(
    tradeId: string,
    error: unknown,
    terminal: boolean
  ): SettlementServiceError {
    return new SettlementServiceError(
      terminal ? "SETTLEMENT_RECOVERY_FAILED" : "SETTLEMENT_RECOVERY_PENDING",
      terminal ? 409 : 503,
      `Settlement for trade ${tradeId} ${terminal ? "failed" : "entered recovery"}: ${readErrorMessage(error)}`
    );
  }

  private async ensurePlatformAccount(
    scopeKey: string,
    accountType: "spot" | "fee"
  ): Promise<string> {
    const accountId = createStableUuid(scopeKey);
    const existing = await this.ledgerClient.getAccount(accountId);
    if (existing) {
      return existing.accountId;
    }

    const account = await this.ledgerClient.createAccount({
      accountId,
      accountType
    });
    return account.accountId;
  }

  async recordAutomationExecution(
    execution: Omit<SettlementAutomationExecution, "executionId"> & { executionId?: string }
  ): Promise<SettlementAutomationExecution> {
    const record: SettlementAutomationExecution = {
      ...execution,
      executionId: execution.executionId ?? this.createId()
    };
    await this.repository.saveAutomationExecution(record);
    return record;
  }

  async persistAutomationExecutionSafely(
    execution: Omit<SettlementAutomationExecution, "executionId"> & { executionId?: string }
  ): Promise<void> {
    try {
      await this.recordAutomationExecution(execution);
    } catch (error) {
      console.warn(
        `settlement automation execution persistence failed: ${readErrorMessage(error)}`
      );
    }
  }

  private createRecoveryWorkerId(scope: "manual" | "worker"): string {
    return `${scope}:${this.createId()}`;
  }
}

function serializeRecoveryCommand(command: SettleTradeCommand): Record<string, unknown> {
  return {
    command
  };
}

function readRecoveryCommand(job: SettlementRecoveryJob | null): SettleTradeCommand | null {
  const command = job?.payload.command;
  return command ? (command as SettleTradeCommand) : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown settlement error";
}

function createStableUuid(value: string): string {
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

function incrementSettlementStatus(
  target: {
    settledCount: number;
    pendingRecoveryCount: number;
    failedCount: number;
  },
  status: TradeSettlement["status"],
  delta = 1
): void {
  if (status === "settled") {
    target.settledCount += delta;
    return;
  }

  if (status === "pending_recovery") {
    target.pendingRecoveryCount += delta;
    return;
  }

  target.failedCount += delta;
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left >= right ? left : right;
}

/** Errors raised by settleTrade after it has recorded a recovery job for the trade. */
function isRecoveryHandoffError(error: unknown): boolean {
  return (
    error instanceof SettlementServiceError &&
    (error.code === "SETTLEMENT_RECOVERY_PENDING" || error.code === "SETTLEMENT_RECOVERY_FAILED")
  );
}

/** Rate + tier actually charged, copied onto the settlement row (A7). */
function appliedFeeFields(
  command: SettleTradeCommand
): Pick<TradeSettlement, "sellerFeeRate" | "buyerFeeRate" | "sellerFeeTier" | "buyerFeeTier"> {
  return {
    sellerFeeRate: command.sellerFeeRate,
    buyerFeeRate: command.buyerFeeRate ?? "0",
    ...(command.sellerFeeTier ? { sellerFeeTier: command.sellerFeeTier } : {}),
    ...(command.buyerFeeTier ? { buyerFeeTier: command.buyerFeeTier } : {})
  };
}

/** Journal description suffix naming the fee tier + rate charged (only when a tier was resolved). */
function describeAppliedFee(side: "buyer" | "seller", tier: string | undefined, rate: string | undefined): string {
  return tier ? ` (${side} fee ${tier} @ ${rate ?? "0"})` : "";
}
