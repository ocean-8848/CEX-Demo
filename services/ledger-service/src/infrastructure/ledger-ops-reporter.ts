import type { AssetCode } from "@web3-cex/domain";

import type {
  LedgerAccountReplayReport,
  LedgerActiveLockAggregate,
  LedgerAlertThresholds,
  LedgerBalanceAggregate,
  LedgerBalanceReconciliationReport,
  LedgerEntryNetAggregate,
  LedgerOpsOverview,
  LedgerReplayEntryEvent,
  LedgerReplayLockAdjustment,
  LedgerReplayLockEvent
} from "../application/ledger-ops.js";
import {
  buildAccountReplayReport,
  buildBalanceReconciliationReport,
  defaultLedgerAlertThresholds,
  evaluateLedgerAlertThresholds
} from "../application/ledger-ops.js";
import { Pool } from "pg";

import type { SqlClient } from "./postgres.js";

interface BalanceAggregateRow {
  account_id: string;
  asset_code: AssetCode;
  account_type: string;
  available: string;
  locked: string;
  updated_at: Date;
}

interface EntryNetAggregateRow {
  account_id: string;
  asset_code: AssetCode;
  net_amount: string;
  entry_count: number;
  last_entry_at: Date | null;
}

interface ActiveLockAggregateRow {
  account_id: string;
  asset_code: AssetCode;
  locked_amount: string;
  lock_count: number;
  oldest_locked_at: Date | null;
}

interface ReplayEntryRow {
  entry_id: string;
  journal_id: string;
  direction: "debit" | "credit";
  amount: string;
  reference_type: string;
  reference_id: string;
  created_at: Date;
  business_type: string;
  business_id: string;
  description: string | null;
}

interface ReplayLockRow {
  lock_id: string;
  amount: string;
  reference_type: string;
  reference_id: string;
  status: "locked" | "released" | "consumed" | "settled";
  created_at: Date;
  released_at: Date | null;
  consumed_at: Date | null;
}

interface OutboxSummaryRow {
  pending_count: string;
  retrying_count: string;
  dead_lettered_count: string;
  oldest_pending_at: Date | null;
}

interface LockSummaryRow {
  active_count: string;
  stale_count: string;
  oldest_active_at: Date | null;
}

export class LedgerOpsReporter {
  private readonly db: SqlClient;
  private readonly pool?: Pool;

  constructor(db: SqlClient | Pool) {
    this.db = db as SqlClient;
    this.pool = db instanceof Pool ? db : undefined;
  }

  /**
   * Every report reads several tables. Against a pool those reads would run on
   * different connections at different moments, so a trade committing in
   * between shows up as a false mismatch. A REPEATABLE READ READ ONLY
   * transaction pins all reads to one snapshot without blocking writers.
   */
  private async inSnapshot<T>(work: (reader: LedgerOpsReporter) => Promise<T>): Promise<T> {
    if (!this.pool) {
      return work(this);
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const result = await work(new LedgerOpsReporter(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileBalances(params: {
    accountId?: string;
    assetCode?: AssetCode;
    includeMatched?: boolean;
    generatedAt?: string;
  } = {}): Promise<LedgerBalanceReconciliationReport> {
    return this.inSnapshot((reader) => reader.collectReconciliation(params));
  }

  private async collectReconciliation(params: {
    accountId?: string;
    assetCode?: AssetCode;
    includeMatched?: boolean;
    generatedAt?: string;
  }): Promise<LedgerBalanceReconciliationReport> {
    const [balances, entryNets, activeLocks] = await Promise.all([
      this.listBalanceAggregates(params.accountId, params.assetCode),
      this.listEntryNetAggregates(params.accountId, params.assetCode),
      this.listActiveLockAggregates(params.accountId, params.assetCode)
    ]);

    return buildBalanceReconciliationReport({
      generatedAt: params.generatedAt ?? new Date().toISOString(),
      balances,
      entryNets,
      activeLocks,
      includeMatched: params.includeMatched
    });
  }

  async replayAccount(params: {
    accountId: string;
    assetCode: AssetCode;
    generatedAt?: string;
  }): Promise<LedgerAccountReplayReport> {
    return this.inSnapshot((reader) => reader.collectReplay(params));
  }

  private async collectReplay(params: {
    accountId: string;
    assetCode: AssetCode;
    generatedAt?: string;
  }): Promise<LedgerAccountReplayReport> {
    const [balance, entries, locks, lockAdjustments] = await Promise.all([
      this.findBalanceAggregate(params.accountId, params.assetCode),
      this.listReplayEntries(params.accountId, params.assetCode),
      this.listReplayLocks(params.accountId, params.assetCode),
      this.listReplayLockAdjustments(params.accountId, params.assetCode)
    ]);

    return buildAccountReplayReport({
      generatedAt: params.generatedAt ?? new Date().toISOString(),
      accountId: params.accountId,
      assetCode: params.assetCode,
      snapshotAvailable: balance?.available ?? "0",
      snapshotLocked: balance?.locked ?? "0",
      entries,
      locks,
      lockAdjustments: lockAdjustments.length > 0 ? lockAdjustments : undefined
    });
  }

  async buildOpsOverview(params: {
    generatedAt?: string;
    staleLockMinutes?: number;
    thresholds?: Partial<LedgerAlertThresholds>;
  } = {}): Promise<LedgerOpsOverview> {
    return this.inSnapshot((reader) => reader.collectOpsOverview(params));
  }

  private async collectOpsOverview(params: {
    generatedAt?: string;
    staleLockMinutes?: number;
    thresholds?: Partial<LedgerAlertThresholds>;
  }): Promise<LedgerOpsOverview> {
    const generatedAt = params.generatedAt ?? new Date().toISOString();
    const staleLockMinutes = params.staleLockMinutes ?? 30;
    const [outbox, locks, reconciliation] = await Promise.all([
      this.getOutboxSummary(generatedAt),
      this.getLockSummary(generatedAt, staleLockMinutes),
      this.collectReconciliation({
        generatedAt,
        includeMatched: true
      })
    ]);

    const thresholds: LedgerAlertThresholds = {
      ...defaultLedgerAlertThresholds(staleLockMinutes),
      ...params.thresholds,
      staleLockMinutes
    };

    return evaluateLedgerAlertThresholds(
      {
        generatedAt,
        outbox,
        locks,
        reconciliation: {
          scannedCount: reconciliation.scannedCount,
          mismatchCount: reconciliation.mismatchCount,
          negativeAvailableCount: reconciliation.items.filter(
            (item) =>
              item.snapshotAvailable.startsWith("-") &&
              item.accountType !== "opening_balance"
          ).length,
          negativeLockedCount: reconciliation.items.filter(
            (item) =>
              item.snapshotLocked.startsWith("-") &&
              item.accountType !== "opening_balance"
          ).length
        }
      },
      thresholds
    );
  }

  private async findBalanceAggregate(
    accountId: string,
    assetCode: AssetCode
  ): Promise<LedgerBalanceAggregate | null> {
    const rows = await this.listBalanceAggregates(accountId, assetCode);
    return rows[0] ?? null;
  }

  private async listBalanceAggregates(
    accountId?: string,
    assetCode?: AssetCode
  ): Promise<LedgerBalanceAggregate[]> {
    const result = await this.db.query<BalanceAggregateRow>(
      `select b.account_id,
              b.asset_code,
              a.account_type,
              b.available::text as available,
              b.locked::text as locked,
              b.updated_at
       from balances b
       join accounts a on a.account_id = b.account_id
       where ($1::uuid is null or b.account_id = $1)
         and ($2::text is null or asset_code = $2)`,
      [accountId ?? null, assetCode ?? null]
    );

    return result.rows.map((row) => ({
      accountId: row.account_id,
      assetCode: row.asset_code,
      accountType: row.account_type,
      available: row.available,
      locked: row.locked,
      updatedAt: row.updated_at.toISOString()
    }));
  }

  private async listEntryNetAggregates(
    accountId?: string,
    assetCode?: AssetCode
  ): Promise<LedgerEntryNetAggregate[]> {
    const result = await this.db.query<EntryNetAggregateRow>(
      `select account_id,
              asset_code,
              coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::text as net_amount,
              count(*)::int as entry_count,
              max(created_at) as last_entry_at
       from ledger_entries
       where ($1::uuid is null or account_id = $1)
         and ($2::text is null or asset_code = $2)
       group by account_id, asset_code`,
      [accountId ?? null, assetCode ?? null]
    );

    return result.rows.map((row) => ({
      accountId: row.account_id,
      assetCode: row.asset_code,
      netAmount: row.net_amount,
      entryCount: Number(row.entry_count),
      lastEntryAt: row.last_entry_at?.toISOString()
    }));
  }

  private async listActiveLockAggregates(
    accountId?: string,
    assetCode?: AssetCode
  ): Promise<LedgerActiveLockAggregate[]> {
    const result = await this.db.query<ActiveLockAggregateRow>(
      `select account_id,
              asset_code,
              -- remaining_amount, not amount: partially settled / released
              -- locks only hold their remainder.
              coalesce(sum(remaining_amount), 0)::text as locked_amount,
              count(*)::int as lock_count,
              min(created_at) as oldest_locked_at
       from balance_locks
       where status = 'locked'
         and ($1::uuid is null or account_id = $1)
         and ($2::text is null or asset_code = $2)
       group by account_id, asset_code`,
      [accountId ?? null, assetCode ?? null]
    );

    return result.rows.map((row) => ({
      accountId: row.account_id,
      assetCode: row.asset_code,
      lockedAmount: row.locked_amount,
      lockCount: Number(row.lock_count),
      oldestLockedAt: row.oldest_locked_at?.toISOString()
    }));
  }

  private async listReplayEntries(
    accountId: string,
    assetCode: AssetCode
  ): Promise<LedgerReplayEntryEvent[]> {
    const result = await this.db.query<ReplayEntryRow>(
      `select le.entry_id,
              le.journal_id,
              le.direction,
              le.amount::text as amount,
              le.reference_type,
              le.reference_id,
              le.created_at,
              lj.business_type,
              lj.business_id,
              lj.description
       from ledger_entries le
       join ledger_journals lj on lj.journal_id = le.journal_id
       where le.account_id = $1
         and le.asset_code = $2
       order by le.created_at asc, le.entry_id asc`,
      [accountId, assetCode]
    );

    return result.rows.map((row) => ({
      entryId: row.entry_id,
      journalId: row.journal_id,
      direction: row.direction,
      amount: row.amount,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      createdAt: row.created_at.toISOString(),
      businessType: row.business_type,
      businessId: row.business_id,
      description: row.description ?? undefined
    }));
  }

  private async listReplayLockAdjustments(
    accountId: string,
    assetCode: AssetCode
  ): Promise<LedgerReplayLockAdjustment[]> {
    type BalanceEventPayload = { amount?: string; referenceType?: string; referenceId?: string; settled?: boolean };
    const result = await this.db.query<{
      event_type: string;
      // The outbox stores `{ payload, trace_id, occurred_at }` envelopes.
      payload: { payload?: BalanceEventPayload } & BalanceEventPayload;
      created_at: Date;
    }>(
      `select event_type, payload, created_at
       from outbox_events
       where aggregate_type = 'balance'
         and aggregate_id = $1
         and event_type in ('balance.locked', 'balance.released', 'balance.consumed')
       order by created_at asc, event_id asc`,
      [`${accountId}:${assetCode}`]
    );

    return result.rows.map((row) => {
      const payload = row.payload.payload ?? row.payload;
      return {
        at: row.created_at.toISOString(),
        type:
          row.event_type === "balance.locked"
            ? "lock"
            : row.event_type === "balance.released"
              ? "release"
              : payload.settled
                ? "settle"
                : "consume",
        amount: String(payload.amount ?? "0"),
        referenceType: String(payload.referenceType ?? ""),
        referenceId: String(payload.referenceId ?? "")
      };
    });
  }

  private async listReplayLocks(
    accountId: string,
    assetCode: AssetCode
  ): Promise<LedgerReplayLockEvent[]> {
    const result = await this.db.query<ReplayLockRow>(
      `select lock_id,
              amount::text as amount,
              reference_type,
              reference_id,
              status,
              created_at,
              released_at,
              consumed_at
       from balance_locks
       where account_id = $1
         and asset_code = $2
       order by created_at asc, lock_id asc`,
      [accountId, assetCode]
    );

    return result.rows.map((row) => ({
      lockId: row.lock_id,
      amount: row.amount,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      releasedAt: row.released_at?.toISOString(),
      consumedAt: row.consumed_at?.toISOString()
    }));
  }

  private async getOutboxSummary(now: string) {
    const result = await this.db.query<OutboxSummaryRow>(
      `select count(*) filter (
                where published_at is null
                  and dead_lettered_at is null
             )::text as pending_count,
              count(*) filter (
                where published_at is null
                  and dead_lettered_at is null
                  and publish_attempts > 0
             )::text as retrying_count,
              count(*) filter (where dead_lettered_at is not null)::text as dead_lettered_count,
              min(created_at) filter (
                where published_at is null
                  and dead_lettered_at is null
             ) as oldest_pending_at
       from outbox_events`,
      []
    );

    const row = result.rows[0];
    const nowAt = new Date(now);

    return {
      pendingCount: Number(row?.pending_count ?? "0"),
      retryingCount: Number(row?.retrying_count ?? "0"),
      deadLetteredCount: Number(row?.dead_lettered_count ?? "0"),
      oldestPendingAgeSeconds: row?.oldest_pending_at
        ? Math.max(
            0,
            Math.trunc((nowAt.getTime() - row.oldest_pending_at.getTime()) / 1000)
          )
        : undefined
    };
  }

  private async getLockSummary(now: string, staleLockMinutes: number) {
    const result = await this.db.query<LockSummaryRow>(
      `select count(*) filter (where status = 'locked')::text as active_count,
              count(*) filter (
                where status = 'locked'
                  and created_at <= ($1::timestamptz - ($2::int * interval '1 minute'))
              )::text as stale_count,
              min(created_at) filter (where status = 'locked') as oldest_active_at
       from balance_locks`,
      [now, staleLockMinutes]
    );

    const row = result.rows[0];
    const nowAt = new Date(now);

    return {
      activeCount: Number(row?.active_count ?? "0"),
      staleCount: Number(row?.stale_count ?? "0"),
      oldestActiveAgeSeconds: row?.oldest_active_at
        ? Math.max(0, Math.trunc((nowAt.getTime() - row.oldest_active_at.getTime()) / 1000))
        : undefined,
      staleThresholdMinutes: staleLockMinutes
    };
  }
}
