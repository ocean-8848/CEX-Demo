import type { Pool } from "pg";
import {
  controlSwitchKey,
  type ControlSwitchEntry,
  type ControlSwitchScope,
  type ControlSwitchSource
} from "@web3-cex/domain";

import type { ControlSwitchEvent, ControlSwitchRepository } from "../domain/control-switches.js";

interface SwitchRow {
  scope: string;
  asset_code: string | null;
  reason: string | null;
  source: string;
  updated_by: string;
  updated_at: Date | string;
}

interface EventRow {
  event_id: string;
  switch_key: string;
  scope: string;
  asset_code: string | null;
  action: string;
  reason: string | null;
  source: string;
  operator: string;
  created_at: Date | string;
}

/** Tables `risk_control_switches` + `risk_control_switch_events` (sql/002_control_switches.sql). */
export class PostgresControlSwitchRepository implements ControlSwitchRepository {
  constructor(private readonly pool: Pool) {}

  async listActive(): Promise<ControlSwitchEntry[]> {
    const result = await this.pool.query<SwitchRow>(
      `select scope, asset_code, reason, source, updated_by, updated_at
         from risk_control_switches
        order by switch_key`
    );
    return result.rows.map(mapSwitchRow);
  }

  async enable(entry: ControlSwitchEntry): Promise<ControlSwitchEntry> {
    const key = controlSwitchKey(entry.scope, entry.assetCode);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<SwitchRow>(
        `insert into risk_control_switches (switch_key, scope, asset_code, reason, source, updated_by, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (switch_key) do update
           set reason = excluded.reason,
               source = excluded.source,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at
         returning scope, asset_code, reason, source, updated_by, updated_at`,
        [key, entry.scope, entry.assetCode ?? null, entry.reason, entry.source, entry.updatedBy, entry.updatedAt]
      );
      await client.query(
        `insert into risk_control_switch_events (switch_key, scope, asset_code, action, reason, source, operator, created_at)
         values ($1, $2, $3, 'enabled', $4, $5, $6, $7)`,
        [key, entry.scope, entry.assetCode ?? null, entry.reason, entry.source, entry.updatedBy, entry.updatedAt]
      );
      await client.query("commit");
      const row = result.rows[0];
      return row ? mapSwitchRow(row) : entry;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async disable(params: Parameters<ControlSwitchRepository["disable"]>[0]): Promise<ControlSwitchEntry | null> {
    const key = controlSwitchKey(params.scope, params.assetCode);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const removed = await client.query<SwitchRow>(
        `delete from risk_control_switches where switch_key = $1
         returning scope, asset_code, reason, source, updated_by, updated_at`,
        [key]
      );
      await client.query(
        `insert into risk_control_switch_events (switch_key, scope, asset_code, action, reason, source, operator, created_at)
         values ($1, $2, $3, 'disabled', $4, $5, $6, $7)`,
        [key, params.scope, params.assetCode ?? null, params.reason, params.source, params.operator, params.at]
      );
      await client.query("commit");
      const row = removed.rows[0];
      return row ? mapSwitchRow(row) : null;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(limit: number): Promise<ControlSwitchEvent[]> {
    const result = await this.pool.query<EventRow>(
      `select event_id::text, switch_key, scope, asset_code, action, reason, source, operator, created_at
         from risk_control_switch_events
        order by created_at desc, event_id desc
        limit $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      switchKey: row.switch_key,
      scope: row.scope as ControlSwitchScope,
      assetCode: row.asset_code ?? undefined,
      action: row.action === "disabled" ? "disabled" : "enabled",
      reason: row.reason,
      source: (row.source === "automatic" ? "automatic" : "manual") as ControlSwitchSource,
      operator: row.operator,
      createdAt: toIso(row.created_at)
    }));
  }
}

function mapSwitchRow(row: SwitchRow): ControlSwitchEntry {
  return {
    scope: row.scope as ControlSwitchScope,
    assetCode: row.asset_code ?? undefined,
    reason: row.reason,
    source: row.source === "automatic" ? "automatic" : "manual",
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
