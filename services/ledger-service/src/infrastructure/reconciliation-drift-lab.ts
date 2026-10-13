import type { Pool } from "pg";

/**
 * Fault lab: reconciliation drift. Writes a balance snapshot WITHOUT a journal
 * on a dedicated lab account, which is exactly what a corrupted ledger looks
 * like to the balance reconciliation: the next run reports `total_mismatch`
 * for that asset and the circuit breaker pauses its withdrawals.
 *
 * Only the lab account below is ever touched (no user or platform funds);
 * `clear` deletes its balance rows, which restores a clean reconciliation.
 * Never do this to a real account — in a real ledger every change is a journal.
 */
export const RECONCILIATION_LAB_ACCOUNT_ID = "00000000-0000-0000-0000-0000000000a1";
const LAB_ACCOUNT_TYPE = "fault_lab";

export interface ReconciliationDriftState {
  accountId: string;
  drifts: Array<{ assetCode: string; amount: string; updatedAt: string }>;
}

export class ReconciliationDriftLab {
  constructor(private readonly pool: Pool) {}

  async inject(command: { assetCode: string; amount: string }): Promise<ReconciliationDriftState> {
    if (!/^\d+(\.\d{1,18})?$/.test(command.amount) || Number(command.amount) <= 0) {
      throw new Error("amount must be a positive decimal");
    }
    await this.pool.query(
      `insert into accounts (account_id, user_id, account_type, status)
       values ($1, null, $2, 'active')
       on conflict (account_id) do nothing`,
      [RECONCILIATION_LAB_ACCOUNT_ID, LAB_ACCOUNT_TYPE]
    );
    await this.pool.query(
      `insert into balances (account_id, asset_code, available, locked)
       values ($1, $2, $3, 0)
       on conflict (account_id, asset_code) do update
         set available = balances.available + excluded.available,
             updated_at = now()`,
      [RECONCILIATION_LAB_ACCOUNT_ID, command.assetCode, command.amount]
    );
    return this.getState();
  }

  async clear(): Promise<ReconciliationDriftState & { clearedCount: number }> {
    const removed = await this.pool.query(`delete from balances where account_id = $1`, [RECONCILIATION_LAB_ACCOUNT_ID]);
    return { ...(await this.getState()), clearedCount: removed.rowCount ?? 0 };
  }

  async getState(): Promise<ReconciliationDriftState> {
    const result = await this.pool.query<{ asset_code: string; available: string; updated_at: Date }>(
      `select asset_code, available::text as available, updated_at
         from balances where account_id = $1 order by asset_code`,
      [RECONCILIATION_LAB_ACCOUNT_ID]
    );
    return {
      accountId: RECONCILIATION_LAB_ACCOUNT_ID,
      drifts: result.rows.map((row) => ({
        assetCode: row.asset_code,
        amount: row.available,
        updatedAt: row.updated_at.toISOString()
      }))
    };
  }
}
