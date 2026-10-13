import type { Pool } from "pg";
import type { TradeEventConsumerCheckpoint } from "@web3-cex/domain";

import type { SettlementRepository } from "../domain/repository.js";
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
import type { SqlClient } from "./postgres.js";
import { withPgTransaction } from "./postgres.js";

interface SettlementRow {
  settlement_id: string;
  trade_id: string;
  market: string;
  price: string;
  quantity: string;
  quote_amount: string;
  fee_amount: string;
  buyer_fee_amount?: string | null;
  seller_fee_rate?: string | null;
  buyer_fee_rate?: string | null;
  seller_fee_tier?: string | null;
  buyer_fee_tier?: string | null;
  buyer_order_id: string;
  seller_order_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  execution_id: string | null;
  execution_batch_id: string | null;
  execution_sequence: string | null;
  execution_batch_sequence: number | null;
  replay_cursor: string | null;
  protocol_version: string | null;
  buyer_settlement_journal_id: string | null;
  seller_settlement_journal_id: string | null;
  status: TradeSettlement["status"];
  attempt_count: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_attempt_at: Date | string | null;
  settled_at: Date | string | null;
}

interface RecoveryJobRow {
  job_id: string;
  trade_id: string;
  market: string;
  stage: SettlementRecoveryJob["stage"];
  status: SettlementRecoveryJob["status"];
  payload: Record<string, unknown> | null;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_claimed_at: Date | string | null;
  lease_heartbeat_at: Date | string | null;
  last_duration_ms: number | null;
  last_result: SettlementRecoveryJob["lastResult"] | null;
}

interface SummaryRollupRow {
  scope_type: TradeSettlementSummaryRollup["scopeType"];
  scope_key: string;
  market: string | null;
  status: TradeSettlement["status"];
  settlement_count: string;
  quantity: string;
  quote_amount: string;
  fee_amount: string;
  base_fee_amount?: string | null;
  updated_at: Date | string;
}

interface RecoveryMetricsRow {
  total_jobs: string;
  pending_jobs: string;
  processing_jobs: string;
  completed_jobs: string;
  failed_jobs: string;
  leased_jobs: string;
  expired_lease_jobs: string;
  average_duration_ms: string | null;
  max_duration_ms: string | null;
  last_completed_at: Date | string | null;
  last_failed_at: Date | string | null;
}

interface AutomationExecutionRow {
  execution_id: string;
  execution_type: SettlementAutomationExecution["executionType"];
  status: SettlementAutomationExecution["status"];
  trigger: SettlementAutomationExecution["trigger"];
  market: string | null;
  worker_id: string | null;
  target_id: string | null;
  summary: Record<string, unknown> | null;
  error_message: string | null;
  started_at: Date | string;
  completed_at: Date | string;
  duration_ms: number;
}

interface ConsumerCheckpointRow {
  consumer_id: string;
  event_type: TradeEventConsumerCheckpoint["eventType"];
  market: string;
  schema_id: string;
  schema_version: number;
  protocol_version: string;
  last_event_id: string;
  last_trade_id: string;
  last_execution_sequence: string;
  last_replay_cursor: string;
  last_stream_entry_id: string | null;
  last_stream_published_at: Date | string | null;
  updated_at: Date | string;
}

export class PostgresSettlementRepository implements SettlementRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly pool: Pool
  ) {}

  async withTransaction<T>(operation: (repository: SettlementRepository) => Promise<T>): Promise<T> {
    return withPgTransaction(this.pool, (client) =>
      operation(new PostgresSettlementRepository(client, this.pool))
    );
  }

  async findSettlementByTradeId(tradeId: string): Promise<TradeSettlement | null> {
    const result = await this.db.query<SettlementRow>(
      `select * from trade_settlements where trade_id = $1`,
      [tradeId]
    );

    return result.rows[0] ? mapSettlement(result.rows[0]) : null;
  }

  async saveSettlement(settlement: TradeSettlement): Promise<void> {
    const existing = await this.findSettlementByTradeId(settlement.tradeId);

    await this.db.query(
      `insert into trade_settlements (
         settlement_id, trade_id, market, price, quantity, quote_amount, fee_amount,
         buyer_order_id, seller_order_id, buyer_user_id, seller_user_id,
         buyer_account_id, seller_account_id, execution_id, execution_batch_id,
         execution_sequence, execution_batch_sequence, replay_cursor, protocol_version,
         buyer_settlement_journal_id,
         seller_settlement_journal_id, status, attempt_count, last_error,
         created_at, updated_at, last_attempt_at, settled_at, buyer_fee_amount,
         seller_fee_rate, buyer_fee_rate, seller_fee_tier, buyer_fee_tier
       )
       values (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21, $22, $23, $24,
         $25, $26, $27, $28, $29,
         $30, $31, $32, $33
       )
       on conflict (trade_id) do update set
         settlement_id = excluded.settlement_id,
         market = excluded.market,
         price = excluded.price,
         quantity = excluded.quantity,
         quote_amount = excluded.quote_amount,
         fee_amount = excluded.fee_amount,
         buyer_order_id = excluded.buyer_order_id,
         seller_order_id = excluded.seller_order_id,
         buyer_user_id = excluded.buyer_user_id,
         seller_user_id = excluded.seller_user_id,
         buyer_account_id = excluded.buyer_account_id,
         seller_account_id = excluded.seller_account_id,
         execution_id = excluded.execution_id,
         execution_batch_id = excluded.execution_batch_id,
         execution_sequence = excluded.execution_sequence,
         execution_batch_sequence = excluded.execution_batch_sequence,
         replay_cursor = excluded.replay_cursor,
         protocol_version = excluded.protocol_version,
         buyer_settlement_journal_id = excluded.buyer_settlement_journal_id,
         seller_settlement_journal_id = excluded.seller_settlement_journal_id,
         status = excluded.status,
         attempt_count = excluded.attempt_count,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at,
         last_attempt_at = excluded.last_attempt_at,
         settled_at = excluded.settled_at,
         buyer_fee_amount = excluded.buyer_fee_amount,
         seller_fee_rate = coalesce(excluded.seller_fee_rate, trade_settlements.seller_fee_rate),
         buyer_fee_rate = coalesce(excluded.buyer_fee_rate, trade_settlements.buyer_fee_rate),
         seller_fee_tier = coalesce(excluded.seller_fee_tier, trade_settlements.seller_fee_tier),
         buyer_fee_tier = coalesce(excluded.buyer_fee_tier, trade_settlements.buyer_fee_tier)`,
      [
        settlement.settlementId,
        settlement.tradeId,
        settlement.market,
        settlement.price,
        settlement.quantity,
        settlement.quoteAmount,
        settlement.feeAmount,
        settlement.buyerOrderId,
        settlement.sellerOrderId,
        settlement.buyerUserId,
        settlement.sellerUserId,
        settlement.buyerAccountId,
        settlement.sellerAccountId,
        settlement.executionId ?? null,
        settlement.executionBatchId ?? null,
        settlement.executionSequence ?? null,
        settlement.executionBatchSequence ?? null,
        settlement.replayCursor ?? null,
        settlement.protocolVersion ?? null,
        settlement.buyerSettlementJournalId ?? null,
        settlement.sellerSettlementJournalId ?? null,
        settlement.status,
        settlement.attemptCount,
        settlement.lastError ?? null,
        settlement.createdAt,
        settlement.updatedAt,
        settlement.lastAttemptAt ?? null,
        settlement.settledAt ?? null,
        settlement.buyerFeeAmount ?? "0",
        settlement.sellerFeeRate ?? null,
        settlement.buyerFeeRate ?? null,
        settlement.sellerFeeTier ?? null,
        settlement.buyerFeeTier ?? null
      ]
    );

    await this.applySettlementSummaryDelta(existing, settlement);
  }

  async listSettlements(query: ListTradeSettlementsQuery): Promise<TradeSettlement[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.userId) {
      values.push(query.userId);
      where.push(`(buyer_user_id = $${values.length} or seller_user_id = $${values.length})`);
    }

    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }

    if (query.orderId) {
      values.push(query.orderId);
      where.push(`(buyer_order_id = $${values.length} or seller_order_id = $${values.length})`);
    }

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);

    const result = await this.db.query<SettlementRow>(
      `select * from trade_settlements
       ${whereSql}
       order by settled_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapSettlement);
  }

  async getSettlementSummaryRollups(
    query: Pick<ListTradeSettlementsQuery, "market" | "status" | "userId" | "orderId">
  ): Promise<TradeSettlementSummaryRollup[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }

    if (query.userId && !query.orderId) {
      if (query.market) {
        values.push(`${query.userId}:${query.market}`);
        where.push(`scope_type = 'user_market' and scope_key = $${values.length}`);
      } else {
        values.push(query.userId);
        const baseIndex = values.length;
        values.push(`${query.userId}:%`);
        where.push(
          `((scope_type = 'user' and scope_key = $${baseIndex}) or (scope_type = 'user_market' and scope_key like $${baseIndex + 1}))`
        );
      }
    } else if (query.orderId && !query.userId) {
      if (query.market) {
        values.push(`${query.orderId}:${query.market}`);
        where.push(`scope_type = 'order_market' and scope_key = $${values.length}`);
      } else {
        values.push(query.orderId);
        const baseIndex = values.length;
        values.push(`${query.orderId}:%`);
        where.push(
          `((scope_type = 'order' and scope_key = $${baseIndex}) or (scope_type = 'order_market' and scope_key like $${baseIndex + 1}))`
        );
      }
    } else if (query.market) {
      values.push(query.market);
      where.push(`scope_type = 'market' and market = $${values.length}`);
    } else {
      where.push(`scope_type in ('global', 'market')`);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const result = await this.db.query<SummaryRollupRow>(
      `select
         scope_type,
         scope_key,
         market,
         status,
         settlement_count::text as settlement_count,
         quantity::text as quantity,
         quote_amount::text as quote_amount,
         fee_amount::text as fee_amount,
         base_fee_amount::text as base_fee_amount,
         updated_at
       from trade_settlement_summary_rollups
       ${whereSql}
       order by scope_type asc, scope_key asc, status asc`,
      values
    );

    return result.rows.map((row) => ({
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      market: (row.market ?? undefined) as TradeSettlementSummaryRollup["market"],
      status: row.status,
      settlementCount: Number(row.settlement_count),
      quantity: row.quantity,
      quoteAmount: row.quote_amount,
      feeAmount: row.fee_amount,
      baseFeeAmount: row.base_fee_amount ?? "0",
      updatedAt: new Date(row.updated_at).toISOString()
    }));
  }

  async saveRecoveryJob(job: SettlementRecoveryJob): Promise<void> {
    await this.db.query(
      `insert into trade_settlement_recovery_jobs (
         job_id, trade_id, market, stage, status, payload, attempt_count,
         last_error, next_attempt_at, created_at, updated_at, completed_at,
         lease_owner, lease_expires_at, last_claimed_at, lease_heartbeat_at,
         last_duration_ms, last_result
       )
       values (
         $1, $2, $3, $4, $5, $6::jsonb, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18
       )
       on conflict (trade_id) do update set
         job_id = excluded.job_id,
         market = excluded.market,
         stage = excluded.stage,
         status = excluded.status,
         payload = excluded.payload,
         attempt_count = excluded.attempt_count,
         last_error = excluded.last_error,
         next_attempt_at = excluded.next_attempt_at,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at,
         lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at,
         last_claimed_at = excluded.last_claimed_at,
         lease_heartbeat_at = excluded.lease_heartbeat_at,
         last_duration_ms = excluded.last_duration_ms,
         last_result = excluded.last_result`,
      [
        job.jobId,
        job.tradeId,
        job.market,
        job.stage,
        job.status,
        JSON.stringify(job.payload),
        job.attemptCount,
        job.lastError ?? null,
        job.nextAttemptAt,
        job.createdAt,
        job.updatedAt,
        job.completedAt ?? null,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.lastClaimedAt ?? null,
        job.leaseHeartbeatAt ?? null,
        job.lastDurationMs ?? null,
        job.lastResult ?? null
      ]
    );
  }

  async findRecoveryJobByTradeId(tradeId: string): Promise<SettlementRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `select * from trade_settlement_recovery_jobs where trade_id = $1`,
      [tradeId]
    );

    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async listRecoveryJobs(
    query: ListSettlementRecoveryJobsQuery
  ): Promise<SettlementRecoveryJob[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.tradeId) {
      values.push(query.tradeId);
      where.push(`trade_id = $${values.length}`);
    }

    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);

    const result = await this.db.query<RecoveryJobRow>(
      `select * from trade_settlement_recovery_jobs
       ${whereSql}
       order by created_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapRecoveryJob);
  }

  async claimRecoveryJobs(
    command: ClaimSettlementRecoveryJobsCommand
  ): Promise<SettlementRecoveryJob[]> {
    const result = await this.db.query<RecoveryJobRow>(
      `with candidates as (
         select trade_id
         from trade_settlement_recovery_jobs
         where status = 'pending'
           and next_attempt_at <= $1
           and (lease_expires_at is null or lease_expires_at <= $1 or lease_owner = $3)
         order by next_attempt_at asc, created_at asc
         limit $2
         for update skip locked
       )
       update trade_settlement_recovery_jobs as job
       set
         status = 'processing',
         attempt_count = job.attempt_count + 1,
         updated_at = $1,
         lease_owner = $3,
         lease_expires_at = $4,
         last_claimed_at = $1,
         lease_heartbeat_at = $1
       from candidates
       where job.trade_id = candidates.trade_id
       returning job.*`,
      [command.now, Math.max(command.limit, 1), command.workerId, command.leaseExpiresAt]
    );

    return result.rows.map(mapRecoveryJob);
  }

  async claimRecoveryJob(
    command: ClaimSettlementRecoveryJobCommand
  ): Promise<SettlementRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `with candidate as (
         select trade_id
         from trade_settlement_recovery_jobs
         where trade_id = $1
           and status = any($2::text[])
           and (lease_expires_at is null or lease_expires_at <= $3 or lease_owner = $4)
         for update skip locked
       )
       update trade_settlement_recovery_jobs as job
       set
         status = 'processing',
         attempt_count = job.attempt_count + 1,
         updated_at = $3,
         next_attempt_at = $3,
         lease_owner = $4,
         lease_expires_at = $5,
         last_claimed_at = $3,
         lease_heartbeat_at = $3
       from candidate
       where job.trade_id = candidate.trade_id
       returning job.*`,
      [
        command.tradeId,
        command.allowedStatuses,
        command.now,
        command.workerId,
        command.leaseExpiresAt
      ]
    );

    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async renewRecoveryJobLease(
    command: RenewSettlementRecoveryLeaseCommand
  ): Promise<SettlementRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `update trade_settlement_recovery_jobs
       set
         updated_at = $3,
         lease_heartbeat_at = $3,
         lease_expires_at = $4
       where trade_id = $1
         and status = 'processing'
         and lease_owner = $2
       returning *`,
      [command.tradeId, command.workerId, command.heartbeatAt, command.leaseExpiresAt]
    );

    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async getRecoveryMetrics(now: string): Promise<SettlementRecoveryMetrics> {
    const result = await this.db.query<RecoveryMetricsRow>(
      `select
         count(*)::text as total_jobs,
         count(*) filter (where status = 'pending')::text as pending_jobs,
         count(*) filter (where status = 'processing')::text as processing_jobs,
         count(*) filter (where status = 'completed')::text as completed_jobs,
         count(*) filter (where status = 'failed')::text as failed_jobs,
         count(*) filter (where lease_expires_at is not null and lease_expires_at > $1::timestamptz)::text as leased_jobs,
         count(*) filter (
           where status = 'processing'
             and lease_expires_at is not null
             and lease_expires_at <= $1::timestamptz
         )::text as expired_lease_jobs,
         round(coalesce(avg(last_duration_ms), 0))::text as average_duration_ms,
         coalesce(max(last_duration_ms), 0)::text as max_duration_ms,
         max(updated_at) filter (where last_result = 'completed') as last_completed_at,
         max(updated_at) filter (where last_result = 'failed') as last_failed_at
       from trade_settlement_recovery_jobs`,
      [now]
    );
    const row = result.rows[0];

    return {
      generatedAt: now,
      totalJobs: Number(row?.total_jobs ?? "0"),
      pendingJobs: Number(row?.pending_jobs ?? "0"),
      processingJobs: Number(row?.processing_jobs ?? "0"),
      completedJobs: Number(row?.completed_jobs ?? "0"),
      failedJobs: Number(row?.failed_jobs ?? "0"),
      leasedJobs: Number(row?.leased_jobs ?? "0"),
      expiredLeaseJobs: Number(row?.expired_lease_jobs ?? "0"),
      averageDurationMs: Number(row?.average_duration_ms ?? "0"),
      maxDurationMs: Number(row?.max_duration_ms ?? "0"),
      lastCompletedAt: row?.last_completed_at ? new Date(row.last_completed_at).toISOString() : undefined,
      lastFailedAt: row?.last_failed_at ? new Date(row.last_failed_at).toISOString() : undefined
    };
  }

  async saveAutomationExecution(execution: SettlementAutomationExecution): Promise<void> {
    await this.db.query(
      `insert into settlement_automation_executions (
         execution_id, execution_type, status, trigger, market, worker_id, target_id,
         summary, error_message, started_at, completed_at, duration_ms
       )
       values (
         $1, $2, $3, $4, $5, $6, $7,
         $8::jsonb, $9, $10, $11, $12
       )
       on conflict (execution_id) do update set
         execution_type = excluded.execution_type,
         status = excluded.status,
         trigger = excluded.trigger,
         market = excluded.market,
         worker_id = excluded.worker_id,
         target_id = excluded.target_id,
         summary = excluded.summary,
         error_message = excluded.error_message,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         duration_ms = excluded.duration_ms`,
      [
        execution.executionId,
        execution.executionType,
        execution.status,
        execution.trigger,
        execution.market ?? null,
        execution.workerId ?? null,
        execution.targetId ?? null,
        JSON.stringify(execution.summary),
        execution.errorMessage ?? null,
        execution.startedAt,
        execution.completedAt,
        execution.durationMs
      ]
    );
  }

  async listAutomationExecutions(
    query: ListSettlementAutomationExecutionsQuery
  ): Promise<SettlementAutomationExecution[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.executionType) {
      values.push(query.executionType);
      where.push(`execution_type = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.trigger) {
      values.push(query.trigger);
      where.push(`trigger = $${values.length}`);
    }
    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }

    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

    const result = await this.db.query<AutomationExecutionRow>(
      `select * from settlement_automation_executions
       ${whereSql}
       order by started_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapAutomationExecution);
  }

  async findTradeEventConsumerCheckpoint(
    consumerId: string,
    market: TradeEventConsumerCheckpoint["market"]
  ): Promise<TradeEventConsumerCheckpoint | null> {
    const result = await this.db.query<ConsumerCheckpointRow>(
      `select * from trade_event_consumer_checkpoints
       where consumer_id = $1 and market = $2`,
      [consumerId, market]
    );

    return result.rows[0] ? mapConsumerCheckpoint(result.rows[0]) : null;
  }

  async saveTradeEventConsumerCheckpoint(
    checkpoint: TradeEventConsumerCheckpoint
  ): Promise<void> {
    await this.db.query(
      `insert into trade_event_consumer_checkpoints (
         consumer_id, event_type, market, schema_id, schema_version, protocol_version,
         last_event_id, last_trade_id, last_execution_sequence, last_replay_cursor,
         last_stream_entry_id, last_stream_published_at, updated_at
       )
       values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13
       )
       on conflict (consumer_id, market) do update set
         event_type = excluded.event_type,
         schema_id = excluded.schema_id,
         schema_version = excluded.schema_version,
         protocol_version = excluded.protocol_version,
         last_event_id = excluded.last_event_id,
         last_trade_id = excluded.last_trade_id,
         last_execution_sequence = excluded.last_execution_sequence,
         last_replay_cursor = excluded.last_replay_cursor,
         last_stream_entry_id = excluded.last_stream_entry_id,
         last_stream_published_at = excluded.last_stream_published_at,
         updated_at = excluded.updated_at`,
      [
        checkpoint.consumerId,
        checkpoint.eventType,
        checkpoint.market,
        checkpoint.schemaId,
        checkpoint.schemaVersion,
        checkpoint.protocolVersion,
        checkpoint.lastEventId,
        checkpoint.lastTradeId,
        checkpoint.lastExecutionSequence,
        checkpoint.lastReplayCursor,
        checkpoint.lastStreamEntryId,
        checkpoint.lastStreamPublishedAt,
        checkpoint.updatedAt
      ]
    );
  }

  async listTradeEventConsumerCheckpoints(
    query: ListTradeEventConsumerCheckpointsQuery
  ): Promise<TradeEventConsumerCheckpoint[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.consumerId) {
      values.push(query.consumerId);
      where.push(`consumer_id = $${values.length}`);
    }
    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }

    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

    const result = await this.db.query<ConsumerCheckpointRow>(
      `select * from trade_event_consumer_checkpoints
       ${whereSql}
       order by updated_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapConsumerCheckpoint);
  }

  private async applySettlementSummaryDelta(
    previous: TradeSettlement | null,
    next: TradeSettlement
  ): Promise<void> {
    if (previous) {
      await this.updateSettlementSummaryRollups(previous, -1);
    }
    await this.updateSettlementSummaryRollups(next, 1);
  }

  private async updateSettlementSummaryRollups(
    settlement: TradeSettlement,
    direction: 1 | -1
  ): Promise<void> {
    const now = settlement.updatedAt;
    const countDelta = direction;
    const quantityDelta = applySignedNumeric(settlement.quantity, direction);
    const quoteDelta = applySignedNumeric(settlement.quoteAmount, direction);
    const feeDelta = applySignedNumeric(settlement.feeAmount, direction);
    const baseFeeDelta = applySignedNumeric(settlement.buyerFeeAmount ?? "0", direction);

    for (const scope of buildSettlementRollupScopes(settlement)) {
      await this.db.query(
        `insert into trade_settlement_summary_rollups (
           scope_type,
           scope_key,
           market,
           status,
           settlement_count,
           quantity,
           quote_amount,
           fee_amount,
           updated_at,
           base_fee_amount
         )
         values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, $10::numeric)
         on conflict (scope_type, scope_key, status) do update set
           settlement_count = trade_settlement_summary_rollups.settlement_count + excluded.settlement_count,
           quantity = trade_settlement_summary_rollups.quantity + excluded.quantity,
           quote_amount = trade_settlement_summary_rollups.quote_amount + excluded.quote_amount,
           fee_amount = trade_settlement_summary_rollups.fee_amount + excluded.fee_amount,
           base_fee_amount = trade_settlement_summary_rollups.base_fee_amount + excluded.base_fee_amount,
           updated_at = excluded.updated_at`,
        [
          scope.scopeType,
          scope.scopeKey,
          scope.market,
          settlement.status,
          countDelta,
          quantityDelta,
          quoteDelta,
          feeDelta,
          now,
          baseFeeDelta
        ]
      );

      await this.db.query(
        `delete from trade_settlement_summary_rollups
         where scope_type = $1
           and scope_key = $2
           and status = $3
           and settlement_count <= 0`,
        [scope.scopeType, scope.scopeKey, settlement.status]
      );
    }
  }
}

function applySignedNumeric(value: string, direction: 1 | -1): string {
  return direction === 1 ? value : value.startsWith("-") ? value.slice(1) : `-${value}`;
}

function buildSettlementRollupScopes(settlement: TradeSettlement): Array<{
  scopeType: TradeSettlementSummaryRollup["scopeType"];
  scopeKey: string;
  market: string | null;
}> {
  const scopes = new Map<
    string,
    {
      scopeType: TradeSettlementSummaryRollup["scopeType"];
      scopeKey: string;
      market: string | null;
    }
  >();

  for (const scope of [
    { scopeType: "global" as const, scopeKey: "all", market: null },
    { scopeType: "market" as const, scopeKey: settlement.market, market: settlement.market },
    { scopeType: "user" as const, scopeKey: settlement.buyerUserId, market: null },
    { scopeType: "user" as const, scopeKey: settlement.sellerUserId, market: null },
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
    { scopeType: "order" as const, scopeKey: settlement.buyerOrderId, market: null },
    { scopeType: "order" as const, scopeKey: settlement.sellerOrderId, market: null },
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
  ]) {
    scopes.set(`${scope.scopeType}:${scope.scopeKey}`, scope);
  }

  return [...scopes.values()];
}

function mapSettlement(row: SettlementRow): TradeSettlement {
  return {
    settlementId: row.settlement_id,
    tradeId: row.trade_id,
    market: row.market as TradeSettlement["market"],
    price: row.price,
    quantity: row.quantity,
    quoteAmount: row.quote_amount,
    feeAmount: row.fee_amount,
    buyerFeeAmount: row.buyer_fee_amount ?? "0",
    ...(row.seller_fee_rate ? { sellerFeeRate: trimRate(row.seller_fee_rate) } : {}),
    ...(row.buyer_fee_rate ? { buyerFeeRate: trimRate(row.buyer_fee_rate) } : {}),
    ...(row.seller_fee_tier ? { sellerFeeTier: row.seller_fee_tier } : {}),
    ...(row.buyer_fee_tier ? { buyerFeeTier: row.buyer_fee_tier } : {}),
    buyerOrderId: row.buyer_order_id,
    sellerOrderId: row.seller_order_id,
    buyerUserId: row.buyer_user_id,
    sellerUserId: row.seller_user_id,
    buyerAccountId: row.buyer_account_id,
    sellerAccountId: row.seller_account_id,
    executionId: row.execution_id ?? undefined,
    executionBatchId: row.execution_batch_id ?? undefined,
    executionSequence: row.execution_sequence ? Number(row.execution_sequence) : undefined,
    executionBatchSequence: row.execution_batch_sequence ?? undefined,
    replayCursor: row.replay_cursor ?? undefined,
    protocolVersion: row.protocol_version ?? undefined,
    buyerSettlementJournalId: row.buyer_settlement_journal_id ?? undefined,
    sellerSettlementJournalId: row.seller_settlement_journal_id ?? undefined,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : undefined,
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : undefined
  };
}

function mapRecoveryJob(row: RecoveryJobRow): SettlementRecoveryJob {
  return {
    jobId: row.job_id,
    tradeId: row.trade_id,
    market: row.market as SettlementRecoveryJob["market"],
    stage: row.stage,
    status: row.status,
    payload: row.payload ?? {},
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at
      ? new Date(row.lease_expires_at).toISOString()
      : undefined,
    lastClaimedAt: row.last_claimed_at ? new Date(row.last_claimed_at).toISOString() : undefined,
    leaseHeartbeatAt: row.lease_heartbeat_at
      ? new Date(row.lease_heartbeat_at).toISOString()
      : undefined,
    lastDurationMs: row.last_duration_ms ?? undefined,
    lastResult: row.last_result ?? undefined
  };
}

function mapAutomationExecution(
  row: AutomationExecutionRow
): SettlementAutomationExecution {
  return {
    executionId: row.execution_id,
    executionType: row.execution_type,
    status: row.status,
    trigger: row.trigger,
    market: (row.market ?? undefined) as SettlementAutomationExecution["market"],
    workerId: row.worker_id ?? undefined,
    targetId: row.target_id ?? undefined,
    summary: row.summary ?? {},
    errorMessage: row.error_message ?? undefined,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: new Date(row.completed_at).toISOString(),
    durationMs: row.duration_ms
  };
}

function mapConsumerCheckpoint(row: ConsumerCheckpointRow): TradeEventConsumerCheckpoint {
  return {
    consumerId: row.consumer_id,
    eventType: row.event_type,
    market: row.market as TradeEventConsumerCheckpoint["market"],
    schemaId: row.schema_id,
    schemaVersion: row.schema_version,
    protocolVersion: row.protocol_version,
    lastEventId: row.last_event_id,
    lastTradeId: row.last_trade_id,
    lastExecutionSequence: Number(row.last_execution_sequence),
    lastReplayCursor: row.last_replay_cursor,
    lastStreamEntryId: row.last_stream_entry_id ?? undefined,
    lastStreamPublishedAt: row.last_stream_published_at
      ? new Date(row.last_stream_published_at).toISOString()
      : undefined,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function trimRate(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") || "0" : value;
}
