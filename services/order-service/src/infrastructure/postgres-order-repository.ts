import type { SpotMarket } from "@web3-cex/domain";
import type { Pool } from "pg";

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
import type { SqlClient } from "./postgres.js";
import { withPgTransaction } from "./postgres.js";

interface OrderRow {
  order_id: string;
  idempotency_key: string;
  trace_id: string;
  otel_trace_id?: string | null;
  user_id: string;
  account_id: string;
  market: string;
  side: SpotOrderRecord["side"];
  type: SpotOrderRecord["type"];
  time_in_force: SpotOrderRecord["timeInForce"];
  price: string;
  quantity: string;
  filled_quantity: string;
  resting_quantity: string;
  status: SpotOrderRecord["status"];
  lock_asset_code: string;
  lock_amount: string;
  rejected_reason: string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TradeRow {
  trade_id: string;
  market: string;
  price: string;
  quantity: string;
  maker_order_id: string;
  taker_order_id: string;
  buyer_order_id: string;
  seller_order_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  seller_fee_rate: string;
  buyer_fee_rate?: string | null;
  execution_id: string;
  execution_batch_id: string;
  execution_sequence: string;
  execution_batch_sequence: number;
  replay_cursor: string;
  protocol_version: string;
  settlement_id: string;
  executed_at: Date | string;
}

interface RecoveryJobRow {
  job_id: string;
  order_id: string;
  market: string;
  stage: SpotOrderRecoveryJob["stage"];
  status: SpotOrderRecoveryJob["status"];
  payload: Record<string, unknown>;
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
  dead_lettered_at: Date | string | null;
  last_duration_ms: number | null;
  last_result: SpotOrderRecoveryJob["lastResult"] | null;
}

interface RecoveryMetricsRow {
  total_jobs: string;
  pending_jobs: string;
  processing_jobs: string;
  completed_jobs: string;
  failed_jobs: string;
  dead_lettered_jobs: string;
  leased_jobs: string;
  expired_lease_jobs: string;
  average_duration_ms: string | null;
  max_duration_ms: string | null;
  last_completed_at: Date | string | null;
  last_failed_at: Date | string | null;
}

interface AutomationExecutionRow {
  execution_id: string;
  execution_type: SpotOrderAutomationExecution["executionType"];
  status: SpotOrderAutomationExecution["status"];
  trigger: SpotOrderAutomationExecution["trigger"];
  market: string | null;
  worker_id: string | null;
  target_id: string | null;
  summary: Record<string, unknown> | null;
  error_message: string | null;
  started_at: Date | string;
  completed_at: Date | string;
  duration_ms: number;
}

export class PostgresOrderRepository implements OrderRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly pool: Pool
  ) {}

  async withTransaction<T>(operation: (repository: OrderRepository) => Promise<T>): Promise<T> {
    return withPgTransaction(this.pool, (client) => operation(new PostgresOrderRepository(client, this.pool)));
  }

  async findOrderById(orderId: string): Promise<SpotOrderRecord | null> {
    const result = await this.db.query<OrderRow>(`select * from spot_orders where order_id = $1`, [orderId]);
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async findOrderByIdempotencyKey(idempotencyKey: string): Promise<SpotOrderRecord | null> {
    const result = await this.db.query<OrderRow>(
      `select * from spot_orders where idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async saveOrder(order: SpotOrderRecord): Promise<void> {
    await this.db.query(
      `insert into spot_orders (
         order_id, idempotency_key, trace_id, user_id, account_id, market, side, type,
         time_in_force, price, quantity, filled_quantity, resting_quantity, status, lock_asset_code, lock_amount,
         rejected_reason, cancelled_at, created_at, updated_at, otel_trace_id
       )
       values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21
       )
       on conflict (order_id) do update set
         filled_quantity = excluded.filled_quantity,
         resting_quantity = excluded.resting_quantity,
         status = excluded.status,
         rejected_reason = excluded.rejected_reason,
         cancelled_at = excluded.cancelled_at,
         updated_at = excluded.updated_at`,
      [
        order.orderId,
        order.idempotencyKey,
        order.traceId,
        order.userId,
        order.accountId,
        order.market,
        order.side,
        order.type,
        order.timeInForce,
        order.price,
        order.quantity,
        order.filledQuantity,
        order.restingQuantity,
        order.status,
        order.lockAssetCode,
        order.lockAmount,
        order.rejectedReason ?? null,
        order.cancelledAt ?? null,
        order.createdAt,
        order.updatedAt,
        order.otelTraceId ?? null
      ]
    );
  }

  async getExecutionCursor(market: SpotMarket): Promise<MarketExecutionCursor> {
    // execution_batch_id is "<MARKET>:<batchSequence>".
    const result = await this.db.query<{ execution_sequence: string | null; batch_sequence: string | null }>(
      `select max(execution_sequence)::text as execution_sequence,
              max(nullif(split_part(execution_batch_id, ':', 2), '')::bigint)::text as batch_sequence
       from spot_trades
       where market = $1`,
      [market]
    );
    const row = result.rows[0];
    return {
      executionSequence: Number(row?.execution_sequence ?? 0),
      batchSequence: Number(row?.batch_sequence ?? 0)
    };
  }

  async listOrders(query: ListSpotOrdersQuery): Promise<SpotOrderRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.userId) {
      values.push(query.userId);
      where.push(`user_id = $${values.length}`);
    }
    if (query.accountId) {
      values.push(query.accountId);
      where.push(`account_id = $${values.length}`);
    }
    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }

    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

    const result = await this.db.query<OrderRow>(
      `select * from spot_orders
       ${whereSql}
       order by created_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapOrder);
  }

  async saveTrade(trade: SpotTradeRecord): Promise<void> {
    await this.db.query(
      `insert into spot_trades (
         trade_id, market, price, quantity, maker_order_id, taker_order_id,
         buyer_order_id, seller_order_id, buyer_user_id, seller_user_id,
         buyer_account_id, seller_account_id, seller_fee_rate, execution_id,
         execution_batch_id, execution_sequence, execution_batch_sequence,
         replay_cursor, protocol_version, settlement_id, executed_at, buyer_fee_rate
       )
       values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18,
         $19, $20, $21, $22
       )
       on conflict (trade_id) do nothing`,
      [
        trade.tradeId,
        trade.market,
        trade.price,
        trade.quantity,
        trade.makerOrderId,
        trade.takerOrderId,
        trade.buyerOrderId,
        trade.sellerOrderId,
        trade.buyerUserId,
        trade.sellerUserId,
        trade.buyerAccountId,
        trade.sellerAccountId,
        trade.sellerFeeRate,
        trade.executionId,
        trade.executionBatchId,
        trade.executionSequence,
        trade.executionBatchSequence,
        trade.replayCursor,
        trade.protocolVersion,
        trade.settlementId,
        trade.executedAt,
        trade.buyerFeeRate ?? "0"
      ]
    );
  }

  async findTradeById(tradeId: string): Promise<SpotTradeRecord | null> {
    const result = await this.db.query<TradeRow>(
      `select * from spot_trades where trade_id = $1`,
      [tradeId]
    );

    return result.rows[0] ? mapTrade(result.rows[0]) : null;
  }

  async listTrades(query: ListSpotTradesQuery): Promise<SpotTradeRecord[]> {
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
    if (query.executionBatchId) {
      values.push(query.executionBatchId);
      where.push(`execution_batch_id = $${values.length}`);
    }
    if (query.executionSequenceFrom !== undefined) {
      values.push(query.executionSequenceFrom);
      where.push(`execution_sequence >= $${values.length}`);
    }
    if (query.executionSequenceTo !== undefined) {
      values.push(query.executionSequenceTo);
      where.push(`execution_sequence <= $${values.length}`);
    }

    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

    const result = await this.db.query<TradeRow>(
      `select * from spot_trades
       ${whereSql}
       order by executed_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapTrade);
  }

  async updateTradeSettlement(
    command: UpdateSpotTradeSettlementCommand
  ): Promise<SpotTradeRecord | null> {
    const result = await this.db.query<TradeRow>(
      `update spot_trades
       set settlement_id = $2
       where trade_id = $1
       returning *`,
      [command.tradeId, command.settlementId]
    );

    return result.rows[0] ? mapTrade(result.rows[0]) : null;
  }

  async saveRecoveryJob(job: SpotOrderRecoveryJob): Promise<void> {
    await this.db.query(
      `insert into spot_order_recovery_jobs (
         job_id, order_id, market, stage, status, payload, attempt_count,
         last_error, next_attempt_at, created_at, updated_at, completed_at,
         lease_owner, lease_expires_at, last_claimed_at, lease_heartbeat_at,
         dead_lettered_at, last_duration_ms, last_result
       )
       values (
         $1, $2, $3, $4, $5, $6::jsonb, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19
       )
       on conflict (job_id) do update set
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
         dead_lettered_at = excluded.dead_lettered_at,
         last_duration_ms = excluded.last_duration_ms,
         last_result = excluded.last_result`,
      [
        job.jobId,
        job.orderId,
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
        job.deadLetteredAt ?? null,
        job.lastDurationMs ?? null,
        job.lastResult ?? null
      ]
    );
  }

  async findRecoveryJobById(jobId: string): Promise<SpotOrderRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `select * from spot_order_recovery_jobs where job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async listRecoveryJobs(query: ListSpotOrderRecoveryJobsQuery): Promise<SpotOrderRecoveryJob[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.orderId) {
      values.push(query.orderId);
      where.push(`order_id = $${values.length}`);
    }
    if (query.market) {
      values.push(query.market);
      where.push(`market = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.deadLettered !== undefined) {
      where.push(query.deadLettered ? `dead_lettered_at is not null` : `dead_lettered_at is null`);
    }

    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    values.push(limit);
    values.push(offset);
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

    const result = await this.db.query<RecoveryJobRow>(
      `select * from spot_order_recovery_jobs
       ${whereSql}
       order by created_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapRecoveryJob);
  }

  async claimRecoveryJobs(
    command: ClaimSpotOrderRecoveryJobsCommand
  ): Promise<SpotOrderRecoveryJob[]> {
    const result = await this.db.query<RecoveryJobRow>(
      `with candidates as (
         select job_id
         from spot_order_recovery_jobs
         where status = 'pending'
           and dead_lettered_at is null
           and next_attempt_at <= $1
           and (lease_expires_at is null or lease_expires_at <= $1 or lease_owner = $3)
         order by next_attempt_at asc, created_at asc
         limit $2
         for update skip locked
       )
       update spot_order_recovery_jobs as job
       set
         status = 'processing',
         attempt_count = job.attempt_count + 1,
         updated_at = $1,
         lease_owner = $3,
         lease_expires_at = $4,
         last_claimed_at = $1,
         lease_heartbeat_at = $1
       from candidates
       where job.job_id = candidates.job_id
       returning job.*`,
      [command.now, Math.max(command.limit, 1), command.workerId, command.leaseExpiresAt]
    );

    return result.rows.map(mapRecoveryJob);
  }

  async claimRecoveryJob(
    command: ClaimSpotOrderRecoveryJobCommand
  ): Promise<SpotOrderRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `with candidate as (
         select job_id
         from spot_order_recovery_jobs
         where job_id = $1
           and status = any($2::text[])
           and (lease_expires_at is null or lease_expires_at <= $3 or lease_owner = $4)
         for update skip locked
       )
       update spot_order_recovery_jobs as job
       set
         status = 'processing',
         attempt_count = job.attempt_count + 1,
         updated_at = $3,
         next_attempt_at = $3,
         lease_owner = $4,
         lease_expires_at = $5,
         last_claimed_at = $3,
         lease_heartbeat_at = $3,
         dead_lettered_at = null
       from candidate
       where job.job_id = candidate.job_id
       returning job.*`,
      [
        command.jobId,
        command.allowedStatuses,
        command.now,
        command.workerId,
        command.leaseExpiresAt
      ]
    );

    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async renewRecoveryJobLease(
    command: RenewSpotOrderRecoveryLeaseCommand
  ): Promise<SpotOrderRecoveryJob | null> {
    const result = await this.db.query<RecoveryJobRow>(
      `update spot_order_recovery_jobs
       set
         updated_at = $3,
         lease_heartbeat_at = $3,
         lease_expires_at = $4
       where job_id = $1
         and status = 'processing'
         and lease_owner = $2
       returning *`,
      [command.jobId, command.workerId, command.heartbeatAt, command.leaseExpiresAt]
    );

    return result.rows[0] ? mapRecoveryJob(result.rows[0]) : null;
  }

  async getRecoveryMetrics(now: string): Promise<SpotOrderRecoveryMetrics> {
    const result = await this.db.query<RecoveryMetricsRow>(
      `select
         count(*)::text as total_jobs,
         count(*) filter (where status = 'pending' and dead_lettered_at is null)::text as pending_jobs,
         count(*) filter (where status = 'processing')::text as processing_jobs,
         count(*) filter (where status = 'completed')::text as completed_jobs,
         count(*) filter (where status = 'failed')::text as failed_jobs,
         count(*) filter (where dead_lettered_at is not null)::text as dead_lettered_jobs,
         count(*) filter (where lease_expires_at is not null and lease_expires_at > $1::timestamptz)::text as leased_jobs,
         count(*) filter (
           where status = 'processing'
             and lease_expires_at is not null
             and lease_expires_at <= $1::timestamptz
         )::text as expired_lease_jobs,
         round(coalesce(avg(last_duration_ms), 0))::text as average_duration_ms,
         coalesce(max(last_duration_ms), 0)::text as max_duration_ms,
         max(updated_at) filter (where last_result = 'completed') as last_completed_at,
         max(updated_at) filter (where last_result in ('failed', 'dead_lettered')) as last_failed_at
       from spot_order_recovery_jobs`,
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
      deadLetteredJobs: Number(row?.dead_lettered_jobs ?? "0"),
      leasedJobs: Number(row?.leased_jobs ?? "0"),
      expiredLeaseJobs: Number(row?.expired_lease_jobs ?? "0"),
      averageDurationMs: Number(row?.average_duration_ms ?? "0"),
      maxDurationMs: Number(row?.max_duration_ms ?? "0"),
      lastCompletedAt: row?.last_completed_at ? new Date(row.last_completed_at).toISOString() : undefined,
      lastFailedAt: row?.last_failed_at ? new Date(row.last_failed_at).toISOString() : undefined
    };
  }

  async saveAutomationExecution(execution: SpotOrderAutomationExecution): Promise<void> {
    await this.db.query(
      `insert into spot_order_automation_executions (
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
    query: ListSpotOrderAutomationExecutionsQuery
  ): Promise<SpotOrderAutomationExecution[]> {
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
      `select * from spot_order_automation_executions
       ${whereSql}
       order by started_at desc
       limit $${values.length - 1}
       offset $${values.length}`,
      values
    );

    return result.rows.map(mapAutomationExecution);
  }
}

function mapOrder(row: OrderRow): SpotOrderRecord {
  return {
    orderId: row.order_id,
    idempotencyKey: row.idempotency_key,
    traceId: row.trace_id,
    otelTraceId: row.otel_trace_id ?? undefined,
    userId: row.user_id,
    accountId: row.account_id,
    market: row.market as SpotOrderRecord["market"],
    side: row.side,
    type: row.type,
    timeInForce: row.time_in_force,
    price: row.price,
    quantity: row.quantity,
    filledQuantity: row.filled_quantity,
    restingQuantity: row.resting_quantity,
    status: row.status,
    lockAssetCode: row.lock_asset_code,
    lockAmount: row.lock_amount,
    rejectedReason: row.rejected_reason ?? undefined,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapTrade(row: TradeRow): SpotTradeRecord {
  return {
    tradeId: row.trade_id,
    market: row.market as SpotTradeRecord["market"],
    price: row.price,
    quantity: row.quantity,
    makerOrderId: row.maker_order_id,
    takerOrderId: row.taker_order_id,
    buyerOrderId: row.buyer_order_id,
    sellerOrderId: row.seller_order_id,
    buyerUserId: row.buyer_user_id,
    sellerUserId: row.seller_user_id,
    buyerAccountId: row.buyer_account_id,
    sellerAccountId: row.seller_account_id,
    sellerFeeRate: row.seller_fee_rate,
    buyerFeeRate: row.buyer_fee_rate ?? "0",
    executionId: row.execution_id,
    executionBatchId: row.execution_batch_id,
    executionSequence: Number(row.execution_sequence),
    executionBatchSequence: row.execution_batch_sequence,
    replayCursor: row.replay_cursor,
    protocolVersion: row.protocol_version,
    settlementId: row.settlement_id,
    executedAt: new Date(row.executed_at).toISOString()
  };
}

function mapRecoveryJob(row: RecoveryJobRow): SpotOrderRecoveryJob {
  return {
    jobId: row.job_id,
    orderId: row.order_id,
    market: row.market as SpotOrderRecoveryJob["market"],
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
    deadLetteredAt: row.dead_lettered_at
      ? new Date(row.dead_lettered_at).toISOString()
      : undefined,
    lastDurationMs: row.last_duration_ms ?? undefined,
    lastResult: row.last_result ?? undefined
  };
}

function mapAutomationExecution(
  row: AutomationExecutionRow
): SpotOrderAutomationExecution {
  return {
    executionId: row.execution_id,
    executionType: row.execution_type,
    status: row.status,
    trigger: row.trigger,
    market: (row.market ?? undefined) as SpotOrderAutomationExecution["market"],
    workerId: row.worker_id ?? undefined,
    targetId: row.target_id ?? undefined,
    summary: row.summary ?? {},
    errorMessage: row.error_message ?? undefined,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: new Date(row.completed_at).toISOString(),
    durationMs: row.duration_ms
  };
}
