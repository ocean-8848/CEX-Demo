import type { Pool } from "pg";

import type {
  FeeTierOverride,
  FeeTierOverrideAuditEntry,
  FeeTierRepository
} from "../domain/fee-tier-repository.js";

interface OverrideRow {
  user_id: string;
  tier: string;
  note: string;
  assigned_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AuditRow {
  audit_id: string;
  user_id: string;
  action: "set" | "clear";
  previous_tier: string | null;
  tier: string | null;
  note: string;
  actor: string;
  created_at: Date | string;
}

export class PostgresFeeTierRepository implements FeeTierRepository {
  constructor(private readonly pool: Pool) {}

  async sumUserVolume(userId: string, since: string, markets: string[]): Promise<string> {
    if (markets.length === 0) {
      return "0";
    }
    const result = await this.pool.query<{ volume: string | null }>(
      `select round(coalesce(sum(price * quantity), 0), 18)::text as volume
         from spot_trades
        where (buyer_user_id = $1 or seller_user_id = $1)
          and executed_at >= $2
          and market = any($3::text[])`,
      [userId, since, markets]
    );
    return normalizeDecimal(result.rows[0]?.volume ?? "0");
  }

  async findOverride(userId: string): Promise<FeeTierOverride | null> {
    const result = await this.pool.query<OverrideRow>(
      `select * from spot_fee_tier_overrides where user_id = $1`,
      [userId]
    );
    return result.rows[0] ? mapOverride(result.rows[0]) : null;
  }

  async listOverrides(): Promise<FeeTierOverride[]> {
    const result = await this.pool.query<OverrideRow>(
      `select * from spot_fee_tier_overrides order by updated_at desc limit 500`
    );
    return result.rows.map(mapOverride);
  }

  async saveOverride(override: FeeTierOverride): Promise<void> {
    await this.pool.query(
      `insert into spot_fee_tier_overrides (user_id, tier, note, assigned_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id) do update
         set tier = excluded.tier,
             note = excluded.note,
             assigned_by = excluded.assigned_by,
             updated_at = excluded.updated_at`,
      [
        override.userId,
        override.tier,
        override.note,
        override.assignedBy,
        override.createdAt,
        override.updatedAt
      ]
    );
  }

  async deleteOverride(userId: string): Promise<void> {
    await this.pool.query(`delete from spot_fee_tier_overrides where user_id = $1`, [userId]);
  }

  async appendAudit(entry: FeeTierOverrideAuditEntry): Promise<void> {
    await this.pool.query(
      `insert into spot_fee_tier_override_audit
         (audit_id, user_id, action, previous_tier, tier, note, actor, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.auditId,
        entry.userId,
        entry.action,
        entry.previousTier ?? null,
        entry.tier ?? null,
        entry.note,
        entry.actor,
        entry.createdAt
      ]
    );
  }

  async listAudit(query: { userId?: string; limit: number }): Promise<FeeTierOverrideAuditEntry[]> {
    const values: unknown[] = [];
    let where = "";
    if (query.userId) {
      values.push(query.userId);
      where = `where user_id = $1`;
    }
    values.push(query.limit);
    const result = await this.pool.query<AuditRow>(
      `select * from spot_fee_tier_override_audit ${where}
        order by created_at desc
        limit $${values.length}`,
      values
    );
    return result.rows.map((row) => ({
      auditId: row.audit_id,
      userId: row.user_id,
      action: row.action,
      previousTier: row.previous_tier ?? undefined,
      tier: row.tier ?? undefined,
      note: row.note,
      actor: row.actor,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
}

function mapOverride(row: OverrideRow): FeeTierOverride {
  return {
    userId: row.user_id,
    tier: row.tier,
    note: row.note,
    assignedBy: row.assigned_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function normalizeDecimal(value: string): string {
  if (!value.includes(".")) {
    return value;
  }
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
}
