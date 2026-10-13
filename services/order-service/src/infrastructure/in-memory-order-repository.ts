import type { SpotMarket } from "@web3-cex/domain";

import type { OrderRepository } from "../domain/repository.js";
import type {
  ClaimSpotOrderRecoveryJobCommand,
  ClaimSpotOrderRecoveryJobsCommand,
  ListSpotOrderAutomationExecutionsQuery,
  ListSpotOrderRecoveryJobsQuery,
  ListSpotOrdersQuery,
  ListSpotTradesQuery,
  MarketExecutionCursor,
  RenewSpotOrderRecoveryLeaseCommand,
  SpotOrderAutomationExecution,
  SpotOrderRecord,
  SpotOrderRecoveryMetrics,
  SpotOrderRecoveryJob,
  SpotTradeRecord,
  UpdateSpotTradeSettlementCommand
} from "../domain/types.js";

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, SpotOrderRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly trades = new Map<string, SpotTradeRecord>();
  private readonly recoveryJobs = new Map<string, SpotOrderRecoveryJob>();
  private readonly automationExecutions = new Map<string, SpotOrderAutomationExecution>();

  async withTransaction<T>(operation: (repository: OrderRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async findOrderById(orderId: string): Promise<SpotOrderRecord | null> {
    return this.orders.get(orderId) ?? null;
  }

  async listOrdersForLockCheck(params: { orderIds: string[]; includeOpen: boolean }): Promise<SpotOrderRecord[]> {
    const wanted = new Set(params.orderIds);
    const openStatuses = new Set(["accepted", "partially_filled", "pending_risk", "recovery_pending"]);
    return [...this.orders.values()]
      .filter((order) => wanted.has(order.orderId) || (params.includeOpen && openStatuses.has(order.status)))
      .map((order) => ({ ...order }));
  }

  async listTradesForOrders(orderIds: string[]): Promise<SpotTradeRecord[]> {
    const wanted = new Set(orderIds);
    return [...this.trades.values()]
      .filter((trade) => wanted.has(trade.buyerOrderId) || wanted.has(trade.sellerOrderId))
      .map((trade) => ({ ...trade }));
  }

  async findOrderByIdempotencyKey(idempotencyKey: string): Promise<SpotOrderRecord | null> {
    const orderId = this.idempotency.get(idempotencyKey);
    return orderId ? this.orders.get(orderId) ?? null : null;
  }

  async saveOrder(order: SpotOrderRecord): Promise<void> {
    this.orders.set(order.orderId, order);
    this.idempotency.set(order.idempotencyKey, order.orderId);
  }

  async listOrders(query: ListSpotOrdersQuery): Promise<SpotOrderRecord[]> {
    return paginate(
      [...this.orders.values()].filter((item) => {
        if (query.userId && item.userId !== query.userId) {
          return false;
        }
        if (query.accountId && item.accountId !== query.accountId) {
          return false;
        }
        if (query.market && item.market !== query.market) {
          return false;
        }
        if (query.status && item.status !== query.status) {
          return false;
        }
        return true;
      }),
      query.limit,
      query.offset
    );
  }

  async saveTrade(trade: SpotTradeRecord): Promise<void> {
    this.trades.set(trade.tradeId, trade);
  }

  async findTradeById(tradeId: string): Promise<SpotTradeRecord | null> {
    return this.trades.get(tradeId) ?? null;
  }

  async getExecutionCursor(market: SpotMarket): Promise<MarketExecutionCursor> {
    let executionSequence = 0;
    let batchSequence = 0;
    for (const trade of this.trades.values()) {
      if (trade.market !== market) {
        continue;
      }
      executionSequence = Math.max(executionSequence, trade.executionSequence ?? 0);
      batchSequence = Math.max(batchSequence, Number(trade.executionBatchId?.split(":")[1] ?? 0) || 0);
    }
    return { executionSequence, batchSequence };
  }

  async listTrades(query: ListSpotTradesQuery): Promise<SpotTradeRecord[]> {
    return paginate(
      [...this.trades.values()].filter((item) => {
        if (query.userId && item.buyerUserId !== query.userId && item.sellerUserId !== query.userId) {
          return false;
        }
        if (query.market && item.market !== query.market) {
          return false;
        }
        if (
          query.orderId &&
          item.buyerOrderId !== query.orderId &&
          item.sellerOrderId !== query.orderId
        ) {
          return false;
        }
        if (query.executionBatchId && item.executionBatchId !== query.executionBatchId) {
          return false;
        }
        if (
          query.executionSequenceFrom !== undefined &&
          item.executionSequence < query.executionSequenceFrom
        ) {
          return false;
        }
        if (
          query.executionSequenceTo !== undefined &&
          item.executionSequence > query.executionSequenceTo
        ) {
          return false;
        }
        return true;
      }),
      query.limit,
      query.offset
    );
  }

  async updateTradeSettlement(
    command: UpdateSpotTradeSettlementCommand
  ): Promise<SpotTradeRecord | null> {
    const trade = this.trades.get(command.tradeId);
    if (!trade) {
      return null;
    }

    const next: SpotTradeRecord = {
      ...trade,
      settlementId: command.settlementId,
      settlementUpdatedAt: command.settlementUpdatedAt
    };
    this.trades.set(command.tradeId, next);
    return next;
  }

  async saveRecoveryJob(job: SpotOrderRecoveryJob): Promise<void> {
    this.recoveryJobs.set(job.jobId, job);
  }

  async findRecoveryJobById(jobId: string): Promise<SpotOrderRecoveryJob | null> {
    return this.recoveryJobs.get(jobId) ?? null;
  }

  async listRecoveryJobs(query: ListSpotOrderRecoveryJobsQuery): Promise<SpotOrderRecoveryJob[]> {
    return paginate(
      [...this.recoveryJobs.values()].filter((item) => {
        if (query.orderId && item.orderId !== query.orderId) {
          return false;
        }
        if (query.market && item.market !== query.market) {
          return false;
        }
        if (query.status && item.status !== query.status) {
          return false;
        }
        if (query.deadLettered !== undefined) {
          const isDeadLettered = item.deadLetteredAt !== undefined;
          if (query.deadLettered !== isDeadLettered) {
            return false;
          }
        }
        return true;
      }),
      query.limit,
      query.offset
    );
  }

  async claimRecoveryJobs(
    command: ClaimSpotOrderRecoveryJobsCommand
  ): Promise<SpotOrderRecoveryJob[]> {
    const candidates = [...this.recoveryJobs.values()]
      .filter((job) => {
        if (job.status !== "pending") {
          return false;
        }
        if (job.deadLetteredAt) {
          return false;
        }
        if (job.nextAttemptAt > command.now) {
          return false;
        }
        if (job.leaseExpiresAt && job.leaseExpiresAt > command.now && job.leaseOwner !== command.workerId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, Math.max(command.limit, 1));

    const claimed = candidates.map((job) => ({
      ...job,
      status: "processing" as const,
      attemptCount: job.attemptCount + 1,
      updatedAt: command.now,
      leaseOwner: command.workerId,
      leaseExpiresAt: command.leaseExpiresAt,
      lastClaimedAt: command.now,
      leaseHeartbeatAt: command.now
    }));

    for (const job of claimed) {
      this.recoveryJobs.set(job.jobId, job);
    }

    return claimed;
  }

  async claimRecoveryJob(
    command: ClaimSpotOrderRecoveryJobCommand
  ): Promise<SpotOrderRecoveryJob | null> {
    const job = this.recoveryJobs.get(command.jobId);
    if (!job) {
      return null;
    }

    if (!command.allowedStatuses.includes(job.status)) {
      return null;
    }

    if (job.leaseExpiresAt && job.leaseExpiresAt > command.now && job.leaseOwner !== command.workerId) {
      return null;
    }

    const claimed: SpotOrderRecoveryJob = {
      ...job,
      status: "processing",
      attemptCount: job.attemptCount + 1,
      updatedAt: command.now,
      nextAttemptAt: command.now,
      leaseOwner: command.workerId,
      leaseExpiresAt: command.leaseExpiresAt,
      lastClaimedAt: command.now,
      leaseHeartbeatAt: command.now,
      deadLetteredAt: undefined
    };
    this.recoveryJobs.set(claimed.jobId, claimed);
    return claimed;
  }

  async renewRecoveryJobLease(
    command: RenewSpotOrderRecoveryLeaseCommand
  ): Promise<SpotOrderRecoveryJob | null> {
    const job = this.recoveryJobs.get(command.jobId);
    if (!job) {
      return null;
    }

    if (job.status !== "processing" || job.leaseOwner !== command.workerId) {
      return null;
    }

    const renewed: SpotOrderRecoveryJob = {
      ...job,
      updatedAt: command.heartbeatAt,
      leaseHeartbeatAt: command.heartbeatAt,
      leaseExpiresAt: command.leaseExpiresAt
    };
    this.recoveryJobs.set(renewed.jobId, renewed);
    return renewed;
  }

  async getRecoveryMetrics(now: string): Promise<SpotOrderRecoveryMetrics> {
    const jobs = [...this.recoveryJobs.values()];
    const durationValues = jobs
      .map((job) => job.lastDurationMs)
      .filter((value): value is number => typeof value === "number");

    return {
      generatedAt: now,
      totalJobs: jobs.length,
      pendingJobs: jobs.filter((job) => job.status === "pending" && !job.deadLetteredAt).length,
      processingJobs: jobs.filter((job) => job.status === "processing").length,
      completedJobs: jobs.filter((job) => job.status === "completed").length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
      deadLetteredJobs: jobs.filter((job) => job.deadLetteredAt).length,
      leasedJobs: jobs.filter((job) => job.leaseExpiresAt && job.leaseExpiresAt > now).length,
      expiredLeaseJobs: jobs.filter(
        (job) => job.status === "processing" && job.leaseExpiresAt && job.leaseExpiresAt <= now
      ).length,
      averageDurationMs:
        durationValues.length > 0
          ? Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length)
          : 0,
      maxDurationMs: durationValues.length > 0 ? Math.max(...durationValues) : 0,
      lastCompletedAt: jobs
        .filter((job) => job.lastResult === "completed")
        .map((job) => job.updatedAt)
        .sort()
        .at(-1),
      lastFailedAt: jobs
        .filter((job) => job.lastResult === "failed" || job.lastResult === "dead_lettered")
        .map((job) => job.updatedAt)
        .sort()
        .at(-1)
    };
  }

  async saveAutomationExecution(execution: SpotOrderAutomationExecution): Promise<void> {
    this.automationExecutions.set(execution.executionId, execution);
  }

  async listAutomationExecutions(
    query: ListSpotOrderAutomationExecutionsQuery
  ): Promise<SpotOrderAutomationExecution[]> {
    return paginate(
      [...this.automationExecutions.values()]
        .filter((item) => {
          if (query.executionType && item.executionType !== query.executionType) {
            return false;
          }
          if (query.status && item.status !== query.status) {
            return false;
          }
          if (query.trigger && item.trigger !== query.trigger) {
            return false;
          }
          if (query.market && item.market !== query.market) {
            return false;
          }
          return true;
        })
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      query.limit,
      query.offset
    );
  }
}

function paginate<T>(items: T[], limit?: number, offset?: number): T[] {
  const normalizedOffset = Math.max(Math.trunc(offset ?? 0), 0);
  const normalizedLimit = Math.max(Math.trunc(limit ?? items.length), 0);
  return items.slice(normalizedOffset, normalizedOffset + normalizedLimit);
}
