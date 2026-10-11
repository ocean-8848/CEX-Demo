import { addAmounts, type TradeEventConsumerCheckpoint } from "@web3-cex/domain";

import type {
  ClaimSettlementRecoveryJobCommand,
  ClaimSettlementRecoveryJobsCommand,
  ListTradeEventConsumerCheckpointsQuery,
  ListSettlementAutomationExecutionsQuery,
  ListSettlementRecoveryJobsQuery,
  ListTradeSettlementsQuery,
  RenewSettlementRecoveryLeaseCommand,
  SettlementAutomationExecution,
  SettlementRecoveryMetrics,
  SettlementRecoveryJob,
  TradeSettlementSummaryRollup,
  TradeSettlement
} from "../domain/types.js";
import type { SettlementRepository } from "../domain/repository.js";

export class InMemorySettlementRepository implements SettlementRepository {
  private readonly settlements = new Map<string, TradeSettlement>();
  private readonly recoveryJobs = new Map<string, SettlementRecoveryJob>();
  private readonly automationExecutions = new Map<string, SettlementAutomationExecution>();
  private readonly consumerCheckpoints = new Map<string, TradeEventConsumerCheckpoint>();

  async withTransaction<T>(operation: (repository: SettlementRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async findSettlementByTradeId(tradeId: string): Promise<TradeSettlement | null> {
    return this.settlements.get(tradeId) ?? null;
  }

  async saveSettlement(settlement: TradeSettlement): Promise<void> {
    this.settlements.set(settlement.tradeId, settlement);
  }

  async listSettlements(query: ListTradeSettlementsQuery): Promise<TradeSettlement[]> {
    return paginate(
      [...this.settlements.values()].filter((item) => {
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
        if (query.status && item.status !== query.status) {
          return false;
        }
        return true;
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      query.limit,
      query.offset
    );
  }

  async getSettlementSummaryRollups(
    query: Pick<ListTradeSettlementsQuery, "market" | "status" | "userId" | "orderId">
  ): Promise<TradeSettlementSummaryRollup[]> {
    const rollups = new Map<string, TradeSettlementSummaryRollup>();

    for (const settlement of this.settlements.values()) {
      if (query.userId && settlement.buyerUserId !== query.userId && settlement.sellerUserId !== query.userId) {
        continue;
      }
      if (query.orderId && settlement.buyerOrderId !== query.orderId && settlement.sellerOrderId !== query.orderId) {
        continue;
      }
      if (query.market && settlement.market !== query.market) {
        continue;
      }
      if (query.status && settlement.status !== query.status) {
        continue;
      }

      for (const scope of buildRollupScopes(settlement)) {
        if (!matchesScopeQuery(scope, query)) {
          continue;
        }
        const key = `${scope.scopeType}:${scope.scopeKey}:${settlement.status}`;
        const existing = rollups.get(key);
        rollups.set(key, {
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          market: scope.market,
          status: settlement.status,
          settlementCount: (existing?.settlementCount ?? 0) + 1,
          quantity: addAmounts(existing?.quantity ?? "0", settlement.quantity),
          quoteAmount: addAmounts(existing?.quoteAmount ?? "0", settlement.quoteAmount),
          feeAmount: addAmounts(existing?.feeAmount ?? "0", settlement.feeAmount),
          baseFeeAmount: addAmounts(existing?.baseFeeAmount ?? "0", settlement.buyerFeeAmount ?? "0"),
          updatedAt: settlement.updatedAt
        });
      }
    }

    return [...rollups.values()];
  }

  async saveRecoveryJob(job: SettlementRecoveryJob): Promise<void> {
    this.recoveryJobs.set(job.tradeId, job);
  }

  async findRecoveryJobByTradeId(tradeId: string): Promise<SettlementRecoveryJob | null> {
    return this.recoveryJobs.get(tradeId) ?? null;
  }

  async listRecoveryJobs(
    query: ListSettlementRecoveryJobsQuery
  ): Promise<SettlementRecoveryJob[]> {
    return paginate(
      [...this.recoveryJobs.values()]
        .filter((item) => {
          if (query.tradeId && item.tradeId !== query.tradeId) {
            return false;
          }
          if (query.market && item.market !== query.market) {
            return false;
          }
          if (query.status && item.status !== query.status) {
            return false;
          }
          return true;
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      query.limit,
      query.offset
    );
  }

  async claimRecoveryJobs(
    command: ClaimSettlementRecoveryJobsCommand
  ): Promise<SettlementRecoveryJob[]> {
    const claimed = [...this.recoveryJobs.values()]
      .filter((job) => {
        if (job.status !== "pending") {
          return false;
        }
        if (job.nextAttemptAt > command.now) {
          return false;
        }
        if (
          job.leaseExpiresAt &&
          job.leaseExpiresAt > command.now &&
          job.leaseOwner !== command.workerId
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, Math.max(command.limit, 1))
      .map((job) => ({
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
      this.recoveryJobs.set(job.tradeId, job);
    }

    return claimed;
  }

  async claimRecoveryJob(
    command: ClaimSettlementRecoveryJobCommand
  ): Promise<SettlementRecoveryJob | null> {
    const job = this.recoveryJobs.get(command.tradeId);
    if (!job) {
      return null;
    }
    if (!command.allowedStatuses.includes(job.status)) {
      return null;
    }
    if (
      job.leaseExpiresAt &&
      job.leaseExpiresAt > command.now &&
      job.leaseOwner !== command.workerId
    ) {
      return null;
    }

    const claimed: SettlementRecoveryJob = {
      ...job,
      status: "processing",
      attemptCount: job.attemptCount + 1,
      updatedAt: command.now,
      nextAttemptAt: command.now,
      leaseOwner: command.workerId,
      leaseExpiresAt: command.leaseExpiresAt,
      lastClaimedAt: command.now,
      leaseHeartbeatAt: command.now
    };
    this.recoveryJobs.set(command.tradeId, claimed);
    return claimed;
  }

  async renewRecoveryJobLease(
    command: RenewSettlementRecoveryLeaseCommand
  ): Promise<SettlementRecoveryJob | null> {
    const job = this.recoveryJobs.get(command.tradeId);
    if (!job) {
      return null;
    }
    if (job.status !== "processing" || job.leaseOwner !== command.workerId) {
      return null;
    }

    const renewed: SettlementRecoveryJob = {
      ...job,
      updatedAt: command.heartbeatAt,
      leaseHeartbeatAt: command.heartbeatAt,
      leaseExpiresAt: command.leaseExpiresAt
    };
    this.recoveryJobs.set(command.tradeId, renewed);
    return renewed;
  }

  async getRecoveryMetrics(now: string): Promise<SettlementRecoveryMetrics> {
    const jobs = [...this.recoveryJobs.values()];
    const durationValues = jobs
      .map((job) => job.lastDurationMs)
      .filter((value): value is number => typeof value === "number");

    return {
      generatedAt: now,
      totalJobs: jobs.length,
      pendingJobs: jobs.filter((job) => job.status === "pending").length,
      processingJobs: jobs.filter((job) => job.status === "processing").length,
      completedJobs: jobs.filter((job) => job.status === "completed").length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
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
        .filter((job) => job.lastResult === "failed")
        .map((job) => job.updatedAt)
        .sort()
        .at(-1)
    };
  }

  async saveAutomationExecution(execution: SettlementAutomationExecution): Promise<void> {
    this.automationExecutions.set(execution.executionId, execution);
  }

  async listAutomationExecutions(
    query: ListSettlementAutomationExecutionsQuery
  ): Promise<SettlementAutomationExecution[]> {
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

  async findTradeEventConsumerCheckpoint(
    consumerId: string,
    market: TradeEventConsumerCheckpoint["market"]
  ): Promise<TradeEventConsumerCheckpoint | null> {
    return this.consumerCheckpoints.get(buildCheckpointKey(consumerId, market)) ?? null;
  }

  async saveTradeEventConsumerCheckpoint(
    checkpoint: TradeEventConsumerCheckpoint
  ): Promise<void> {
    this.consumerCheckpoints.set(
      buildCheckpointKey(checkpoint.consumerId, checkpoint.market),
      checkpoint
    );
  }

  async listTradeEventConsumerCheckpoints(
    query: ListTradeEventConsumerCheckpointsQuery
  ): Promise<TradeEventConsumerCheckpoint[]> {
    return paginate(
      [...this.consumerCheckpoints.values()]
        .filter((item) => {
          if (query.consumerId && item.consumerId !== query.consumerId) {
            return false;
          }
          if (query.market && item.market !== query.market) {
            return false;
          }
          return true;
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      query.limit,
      query.offset
    );
  }
}

function buildCheckpointKey(consumerId: string, market: TradeEventConsumerCheckpoint["market"]) {
  return `${consumerId}:${market}`;
}

function buildRollupScopes(settlement: TradeSettlement) {
  return dedupeScopes([
    { scopeType: "global" as const, scopeKey: "all", market: undefined },
    { scopeType: "market" as const, scopeKey: settlement.market, market: settlement.market },
    { scopeType: "user" as const, scopeKey: settlement.buyerUserId, market: undefined },
    { scopeType: "user" as const, scopeKey: settlement.sellerUserId, market: undefined },
    {
      scopeType: "user_market" as const,
      scopeKey: `${settlement.buyerUserId}:${settlement.market}`,
      market: settlement.market
    },
    {
      scopeType: "user_market" as const,
      scopeKey: `${settlement.sellerUserId}:${settlement.market}`,
      market: settlement.market
    },
    { scopeType: "order" as const, scopeKey: settlement.buyerOrderId, market: undefined },
    { scopeType: "order" as const, scopeKey: settlement.sellerOrderId, market: undefined },
    {
      scopeType: "order_market" as const,
      scopeKey: `${settlement.buyerOrderId}:${settlement.market}`,
      market: settlement.market
    },
    {
      scopeType: "order_market" as const,
      scopeKey: `${settlement.sellerOrderId}:${settlement.market}`,
      market: settlement.market
    }
  ]);
}

function dedupeScopes(
  scopes: Array<Pick<TradeSettlementSummaryRollup, "scopeType" | "scopeKey" | "market">>
) {
  const unique = new Map<string, Pick<TradeSettlementSummaryRollup, "scopeType" | "scopeKey" | "market">>();
  for (const scope of scopes) {
    unique.set(`${scope.scopeType}:${scope.scopeKey}`, scope);
  }
  return [...unique.values()];
}

function matchesScopeQuery(
  scope: Pick<TradeSettlementSummaryRollup, "scopeType" | "scopeKey" | "market">,
  query: Pick<ListTradeSettlementsQuery, "market" | "status" | "userId" | "orderId">
): boolean {
  if (query.userId) {
    return (
      (scope.scopeType === "user" && scope.scopeKey === query.userId) ||
      (scope.scopeType === "user_market" &&
        scope.scopeKey === `${query.userId}:${scope.market ?? query.market}`)
    );
  }
  if (query.orderId) {
    return (
      (scope.scopeType === "order" && scope.scopeKey === query.orderId) ||
      (scope.scopeType === "order_market" &&
        scope.scopeKey === `${query.orderId}:${scope.market ?? query.market}`)
    );
  }
  return (
    scope.scopeType === (query.market ? "market" : "global") ||
    (!query.market && scope.scopeType === "market")
  );
}

function paginate<T>(items: T[], limit?: number, offset?: number): T[] {
  const normalizedOffset = Math.max(Math.trunc(offset ?? 0), 0);
  const normalizedLimit = Math.max(Math.trunc(limit ?? items.length), 0);
  return items.slice(normalizedOffset, normalizedOffset + normalizedLimit);
}
