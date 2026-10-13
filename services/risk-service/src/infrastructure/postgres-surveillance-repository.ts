import type { Pool } from "pg";

import type {
  SurveillanceAlertDraft,
  SurveillanceAlertStatus,
  SurveillanceAlertType,
  SurveillanceEvidence,
  SurveillanceSeverity
} from "../domain/surveillance.js";
import type {
  ListSurveillanceAlertsQuery,
  SurveillanceAlert,
  SurveillanceAlertEvent,
  SurveillanceRepository
} from "../domain/surveillance-repository.js";

interface AlertRow {
  alert_id: string;
  alert_key: string;
  type: SurveillanceAlertType;
  market: string;
  user_id: string | null;
  severity: SurveillanceSeverity;
  status: SurveillanceAlertStatus;
  summary: string;
  metrics: Record<string, string | number>;
  evidence: SurveillanceEvidence;
  market_maker: boolean;
  window_start: Date | string;
  window_end: Date | string;
  first_detected_at: Date | string;
  last_detected_at: Date | string;
  status_note: string | null;
  status_updated_by: string | null;
  status_updated_at: Date | string | null;
}

interface EventRow {
  event_id: string;
  alert_id: string;
  action: SurveillanceAlertEvent["action"];
  from_status: SurveillanceAlertStatus | null;
  to_status: SurveillanceAlertStatus;
  note: string | null;
  actor: string;
  created_at: Date | string;
}

/** Tables `risk_surveillance_alerts` / `risk_surveillance_alert_events` (sql/002). */
export class PostgresSurveillanceRepository implements SurveillanceRepository {
  constructor(private readonly pool: Pool) {}

  async findByKey(alertKey: string): Promise<SurveillanceAlert | null> {
    const result = await this.pool.query<AlertRow>(`select * from risk_surveillance_alerts where alert_key = $1`, [alertKey]);
    return result.rows[0] ? mapAlert(result.rows[0]) : null;
  }

  async findById(alertId: string): Promise<SurveillanceAlert | null> {
    if (!/^[0-9a-f-]{36}$/i.test(alertId)) {
      return null;
    }
    const result = await this.pool.query<AlertRow>(`select * from risk_surveillance_alerts where alert_id = $1`, [alertId]);
    return result.rows[0] ? mapAlert(result.rows[0]) : null;
  }

  async listForSubject(subject: {
    type: SurveillanceAlertType;
    market: string;
    userId?: string;
    since: string;
  }): Promise<SurveillanceAlert[]> {
    const result = await this.pool.query<AlertRow>(
      `select * from risk_surveillance_alerts
        where type = $1 and market = $2 and user_id is not distinct from $3 and last_detected_at >= $4
        order by last_detected_at desc
        limit 50`,
      [subject.type, subject.market, subject.userId ?? null, subject.since]
    );
    return result.rows.map(mapAlert);
  }

  async insert(alert: SurveillanceAlert): Promise<void> {
    await this.pool.query(
      `insert into risk_surveillance_alerts (
         alert_id, alert_key, type, market, user_id, severity, status, summary, metrics, evidence,
         market_maker, window_start, window_end, first_detected_at, last_detected_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
       on conflict (alert_key) do nothing`,
      [
        alert.alertId,
        alert.alertKey,
        alert.type,
        alert.market,
        alert.userId ?? null,
        alert.severity,
        alert.status,
        alert.summary,
        JSON.stringify(alert.metrics),
        JSON.stringify(alert.evidence),
        alert.marketMaker,
        alert.windowStart,
        alert.windowEnd,
        alert.firstDetectedAt,
        alert.lastDetectedAt
      ]
    );
  }

  async refresh(alertId: string, draft: SurveillanceAlertDraft, detectedAt: string): Promise<void> {
    await this.pool.query(
      `update risk_surveillance_alerts
          set severity = $2, summary = $3, metrics = $4::jsonb, evidence = $5::jsonb,
              window_start = least(window_start, $6::timestamptz), window_end = $7, last_detected_at = $8
        where alert_id = $1 and status = 'open'`,
      [
        alertId,
        draft.severity,
        draft.summary,
        JSON.stringify(draft.metrics),
        JSON.stringify(draft.evidence),
        draft.windowStart,
        draft.windowEnd,
        detectedAt
      ]
    );
  }

  async updateStatus(
    alertId: string,
    update: { status: SurveillanceAlertStatus; note?: string; actor: string; at: string }
  ): Promise<void> {
    await this.pool.query(
      `update risk_surveillance_alerts
          set status = $2, status_note = $3, status_updated_by = $4, status_updated_at = $5
        where alert_id = $1`,
      [alertId, update.status, update.note ?? null, update.actor, update.at]
    );
  }

  async list(query: ListSurveillanceAlertsQuery): Promise<{ items: SurveillanceAlert[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    };
    if (query.type) add("type = ?", query.type);
    if (query.status) add("status = ?", query.status);
    if (query.market) add("market = ?", query.market);
    if (query.userId) add("user_id = ?", query.userId);
    if (!query.includeMarketMakers) where.push("market_maker = false");
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const total = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from risk_surveillance_alerts ${clause}`,
      values
    );
    const rows = await this.pool.query<AlertRow>(
      `select * from risk_surveillance_alerts ${clause}
        order by last_detected_at desc
        limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, query.limit, query.offset]
    );
    return { items: rows.rows.map(mapAlert), total: Number(total.rows[0]?.count ?? 0) };
  }

  async countByStatusAndType() {
    const result = await this.pool.query<{ status: SurveillanceAlertStatus; type: SurveillanceAlertType; count: string }>(
      `select status, type, count(*)::text as count
         from risk_surveillance_alerts
        where market_maker = false
        group by status, type`
    );
    return result.rows.map((row) => ({ status: row.status, type: row.type, count: Number(row.count) }));
  }

  async appendEvent(event: SurveillanceAlertEvent): Promise<void> {
    await this.pool.query(
      `insert into risk_surveillance_alert_events
         (event_id, alert_id, action, from_status, to_status, note, actor, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.eventId,
        event.alertId,
        event.action,
        event.fromStatus ?? null,
        event.toStatus,
        event.note ?? null,
        event.actor,
        event.createdAt
      ]
    );
  }

  async listEvents(alertId: string): Promise<SurveillanceAlertEvent[]> {
    const result = await this.pool.query<EventRow>(
      `select * from risk_surveillance_alert_events where alert_id = $1 order by created_at`,
      [alertId]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      alertId: row.alert_id,
      action: row.action,
      ...(row.from_status ? { fromStatus: row.from_status } : {}),
      toStatus: row.to_status,
      ...(row.note ? { note: row.note } : {}),
      actor: row.actor,
      createdAt: iso(row.created_at)
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapAlert(row: AlertRow): SurveillanceAlert {
  return {
    alertId: row.alert_id,
    alertKey: row.alert_key,
    type: row.type,
    market: row.market,
    ...(row.user_id ? { userId: row.user_id } : {}),
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    metrics: row.metrics ?? {},
    evidence: row.evidence ?? { tradeIds: [], orderIds: [], trades: [], orders: [] },
    marketMaker: row.market_maker,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    firstDetectedAt: iso(row.first_detected_at),
    lastDetectedAt: iso(row.last_detected_at),
    ...(row.status_note ? { statusNote: row.status_note } : {}),
    ...(row.status_updated_by ? { statusUpdatedBy: row.status_updated_by } : {}),
    ...(row.status_updated_at ? { statusUpdatedAt: iso(row.status_updated_at) } : {})
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
