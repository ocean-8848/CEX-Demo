import type { Pool } from "pg";

import type { ReconciliationRunRecord, ReconciliationRunRepository } from "../application/reconciliation-job.js";

export class InMemoryReconciliationRunRepository implements ReconciliationRunRepository {
  private readonly runs: ReconciliationRunRecord[] = [];

  async save(run: ReconciliationRunRecord): Promise<void> {
    this.runs.unshift(JSON.parse(JSON.stringify(run)) as ReconciliationRunRecord);
    this.runs.splice(500);
  }

  async list(limit: number): Promise<ReconciliationRunRecord[]> {
    return this.runs.slice(0, limit).map((run) => JSON.parse(JSON.stringify(run)) as ReconciliationRunRecord);
  }
}

/** Table `ledger_reconciliation_runs` (sql/005_reconciliation_runs.sql). */
export class PostgresReconciliationRunRepository implements ReconciliationRunRepository {
  constructor(
    private readonly pool: Pool,
    /** Runs kept in the table; older ones are pruned after each insert. */
    private readonly historyLimit = 2000
  ) {}

  async save(run: ReconciliationRunRecord): Promise<void> {
    await this.pool.query(
      `insert into ledger_reconciliation_runs (
         run_id, trigger, status, started_at, completed_at, duration_ms,
         balance_mismatch_count, order_lock_mismatch_count, mismatched_assets, tripped_assets, report
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (run_id) do nothing`,
      [
        run.runId,
        run.trigger,
        run.status,
        run.startedAt,
        run.completedAt,
        run.durationMs,
        run.balance?.mismatchCount ?? 0,
        run.orderLock?.mismatchCount ?? 0,
        [...new Set([...(run.balance?.mismatchedAssets ?? []), ...(run.orderLock?.mismatchedAssets ?? [])])].sort(),
        run.breaker.trips.map((trip) => trip.assetCode),
        JSON.stringify(run)
      ]
    );
    await this.pool.query(
      `delete from ledger_reconciliation_runs
        where started_at < (
          select started_at from ledger_reconciliation_runs
           order by started_at desc offset $1 limit 1
        )`,
      [Math.max(this.historyLimit - 1, 0)]
    );
  }

  async list(limit: number): Promise<ReconciliationRunRecord[]> {
    const result = await this.pool.query<{ report: ReconciliationRunRecord }>(
      `select report from ledger_reconciliation_runs order by started_at desc limit $1`,
      [Math.min(Math.max(Math.trunc(limit), 1), 200)]
    );
    return result.rows.map((row) => row.report);
  }
}
