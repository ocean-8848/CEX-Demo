import type { SurveillanceAlertDraft, SurveillanceAlertStatus, SurveillanceAlertType } from "../domain/surveillance.js";
import type {
  ListSurveillanceAlertsQuery,
  SurveillanceAlert,
  SurveillanceAlertEvent,
  SurveillanceRepository
} from "../domain/surveillance-repository.js";

/** RISK_SURVEILLANCE_STORE=memory / tests. */
export class InMemorySurveillanceRepository implements SurveillanceRepository {
  private readonly alerts = new Map<string, SurveillanceAlert>();
  private readonly events: SurveillanceAlertEvent[] = [];

  async findByKey(alertKey: string): Promise<SurveillanceAlert | null> {
    return [...this.alerts.values()].find((alert) => alert.alertKey === alertKey) ?? null;
  }

  async findById(alertId: string): Promise<SurveillanceAlert | null> {
    return this.alerts.get(alertId) ?? null;
  }

  async listForSubject(subject: { type: SurveillanceAlertType; market: string; userId?: string; since: string }) {
    return [...this.alerts.values()].filter(
      (alert) =>
        alert.type === subject.type &&
        alert.market === subject.market &&
        alert.userId === subject.userId &&
        alert.lastDetectedAt >= subject.since
    );
  }

  async insert(alert: SurveillanceAlert): Promise<void> {
    if (!(await this.findByKey(alert.alertKey))) {
      this.alerts.set(alert.alertId, { ...alert });
    }
  }

  async refresh(alertId: string, draft: SurveillanceAlertDraft, detectedAt: string): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (alert && alert.status === "open") {
      this.alerts.set(alertId, {
        ...alert,
        severity: draft.severity,
        summary: draft.summary,
        metrics: draft.metrics,
        evidence: draft.evidence,
        windowStart: alert.windowStart < draft.windowStart ? alert.windowStart : draft.windowStart,
        windowEnd: draft.windowEnd,
        lastDetectedAt: detectedAt
      });
    }
  }

  async updateStatus(
    alertId: string,
    update: { status: SurveillanceAlertStatus; note?: string; actor: string; at: string }
  ): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (alert) {
      this.alerts.set(alertId, {
        ...alert,
        status: update.status,
        statusNote: update.note,
        statusUpdatedBy: update.actor,
        statusUpdatedAt: update.at
      });
    }
  }

  async list(query: ListSurveillanceAlertsQuery) {
    const items = [...this.alerts.values()]
      .filter(
        (alert) =>
          (!query.type || alert.type === query.type) &&
          (!query.status || alert.status === query.status) &&
          (!query.market || alert.market === query.market) &&
          (!query.userId || alert.userId === query.userId) &&
          (query.includeMarketMakers || !alert.marketMaker)
      )
      .sort((left, right) => right.lastDetectedAt.localeCompare(left.lastDetectedAt));
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
  }

  async countByStatusAndType() {
    const counts = new Map<string, { status: SurveillanceAlertStatus; type: SurveillanceAlertType; count: number }>();
    for (const alert of this.alerts.values()) {
      if (alert.marketMaker) {
        continue;
      }
      const key = `${alert.status}:${alert.type}`;
      const entry = counts.get(key) ?? { status: alert.status, type: alert.type, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()];
  }

  async appendEvent(event: SurveillanceAlertEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(alertId: string): Promise<SurveillanceAlertEvent[]> {
    return this.events.filter((event) => event.alertId === alertId);
  }
}
