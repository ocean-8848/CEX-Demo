import type { Pool } from "pg";
import type { SpotMarket } from "@web3-cex/domain";

import type {
  MarketStatusOverride,
  MarketStatusOverrideValue,
  MarketStatusRepository
} from "../domain/market-status.js";

interface MarketStatusRow {
  market: string;
  status: string;
  reason: string | null;
  updated_by: string;
  updated_at: Date | string;
}

/** Table `risk_market_status_overrides` (see sql/001_market_status_overrides.sql). */
export class PostgresMarketStatusRepository implements MarketStatusRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<MarketStatusOverride[]> {
    const result = await this.pool.query<MarketStatusRow>(
      `select market, status, reason, updated_by, updated_at
         from risk_market_status_overrides
        order by market`
    );
    return result.rows.map(mapRow);
  }

  async upsert(override: MarketStatusOverride): Promise<MarketStatusOverride> {
    const result = await this.pool.query<MarketStatusRow>(
      `insert into risk_market_status_overrides (market, status, reason, updated_by, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (market) do update
         set status = excluded.status,
             reason = excluded.reason,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at
       returning market, status, reason, updated_by, updated_at`,
      [override.market, override.status, override.reason, override.updatedBy, override.updatedAt]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : override;
  }

  async remove(market: SpotMarket): Promise<void> {
    await this.pool.query(`delete from risk_market_status_overrides where market = $1`, [market]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapRow(row: MarketStatusRow): MarketStatusOverride {
  return {
    market: row.market,
    status: row.status as MarketStatusOverrideValue,
    reason: row.reason,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString()
  };
}
