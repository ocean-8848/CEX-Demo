import { randomUUID } from "node:crypto";

import { getMarketMaker, FEE_TIER_CONFIG } from "@web3-cex/domain";

import { RiskServiceError } from "../domain/errors.js";
import {
  DEFAULT_SURVEILLANCE_THRESHOLDS,
  SURVEILLANCE_ALERT_STATUSES,
  SURVEILLANCE_ALERT_TYPES,
  runSurveillanceDetectors,
  summarizeParticipation,
  type MarketMakerLookup,
  type MarketParticipation,
  type SurveillanceAlertDraft,
  type SurveillanceAlertStatus,
  type SurveillanceAlertType,
  type SurveillanceThresholds
} from "../domain/surveillance.js";
import type {
  ListSurveillanceAlertsQuery,
  SurveillanceActivityClient,
  SurveillanceAlert,
  SurveillanceAlertEventAction,
  SurveillanceRepository,
  SurveillanceScanResult
} from "../domain/surveillance-repository.js";

interface SurveillanceServiceOptions {
  thresholds?: Partial<SurveillanceThresholds>;
  now?: () => Date;
  createId?: () => string;
  marketMakers?: MarketMakerLookup;
  marketMakerUserIds?: string[];
}

const ALLOWED_TRANSITIONS: Record<SurveillanceAlertStatus, SurveillanceAlertStatus[]> = {
  open: ["acknowledged", "dismissed"],
  acknowledged: ["dismissed", "open"],
  dismissed: ["open"]
};

/**
 * A9 market surveillance: periodically reads the order-service activity
 * window, runs the detectors and keeps one alert per finding. Ops review the
 * alerts in ops-console 「市场监控」 (acknowledge / dismiss / reopen, each with
 * a note and an audit event).
 */
export class SurveillanceService {
  readonly thresholds: SurveillanceThresholds;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly marketMakers: MarketMakerLookup;
  private readonly marketMakerUserIds: string[];
  private running?: Promise<SurveillanceScanResult>;
  private lastScan?: SurveillanceScanResult;
  private lastParticipation: MarketParticipation[] = [];

  constructor(
    private readonly repository: SurveillanceRepository,
    private readonly activityClient: SurveillanceActivityClient,
    options: SurveillanceServiceOptions = {}
  ) {
    const merged = { ...DEFAULT_SURVEILLANCE_THRESHOLDS, ...options.thresholds };
    this.thresholds = {
      ...merged,
      lookbackMs: Math.max(
        merged.lookbackMs,
        merged.washWindowMs,
        merged.concentrationWindowMs,
        merged.spoofWindowMs,
        merged.priceMoveWindowMs
      )
    };
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    this.marketMakers = options.marketMakers ?? ((userId) => getMarketMaker(userId));
    this.marketMakerUserIds =
      options.marketMakerUserIds ?? FEE_TIER_CONFIG.marketMakers.map((member) => member.userId);
  }

  /** Runs one scan; concurrent callers share the in-flight run. */
  async scan(trigger: "automatic" | "manual" = "manual"): Promise<SurveillanceScanResult> {
    if (!this.running) {
      this.running = this.runScan(trigger).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async runScan(trigger: "automatic" | "manual"): Promise<SurveillanceScanResult> {
    const startedAt = Date.now();
    const now = this.now();
    const until = now.toISOString();
    const since = new Date(now.getTime() - this.thresholds.lookbackMs).toISOString();
    const base = { scannedAt: until, since, until, trigger };
    try {
      const activity = await this.activityClient.getActivity({
        since,
        until,
        orderMinNotional: String(this.thresholds.spoofMinNotional),
        orderMaxLifetimeMs: this.thresholds.spoofMaxLifetimeMs,
        orderExcludeUserIds: this.thresholds.includeMarketMakers ? [] : this.marketMakerUserIds
      });
      const drafts = runSurveillanceDetectors(activity, this.thresholds, now, this.marketMakers);
      let created = 0;
      let refreshed = 0;
      for (const draft of drafts) {
        const outcome = await this.upsert(draft, until);
        created += outcome === "created" ? 1 : 0;
        refreshed += outcome === "refreshed" ? 1 : 0;
      }
      this.lastParticipation = summarizeParticipation(activity.trades, this.marketMakers);
      this.lastScan = {
        ...base,
        tradeCount: activity.trades.length,
        cancelledOrderCount: activity.cancelledOrders.length,
        truncated: activity.truncated,
        detected: drafts.length,
        created,
        refreshed,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      this.lastScan = {
        ...base,
        tradeCount: 0,
        cancelledOrderCount: 0,
        truncated: false,
        detected: 0,
        created: 0,
        refreshed: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    return this.lastScan;
  }

  private async upsert(draft: SurveillanceAlertDraft, detectedAt: string): Promise<"created" | "refreshed" | "skipped"> {
    const existing = await this.repository.findByKey(draft.alertKey);
    if (existing?.status === "open") {
      await this.repository.refresh(existing.alertId, draft, detectedAt);
      return "refreshed";
    }
    let alertKey = draft.alertKey;
    if (draft.type === "wash_trade" || draft.type === "spoofing") {
      // Evidence-based findings: the cluster anchor moves as items leave the
      // lookback window, and a reviewed alert keeps the reviewer's decision.
      // Only genuinely new evidence (ids no earlier alert covers) opens a new
      // alert; while one is open it absorbs the cluster.
      const ids = [...draft.evidence.tradeIds, ...draft.evidence.orderIds];
      const earlier = await this.repository.listForSubject({
        type: draft.type,
        market: draft.market,
        userId: draft.userId,
        since: new Date(Date.parse(detectedAt) - this.thresholds.lookbackMs * 2).toISOString()
      });
      const evidenceOf = (alert: SurveillanceAlert) => new Set([...alert.evidence.tradeIds, ...alert.evidence.orderIds]);
      const openOverlap = earlier.find(
        (alert) => alert.status === "open" && ids.some((id) => evidenceOf(alert).has(id))
      );
      if (openOverlap) {
        await this.repository.refresh(openOverlap.alertId, draft, detectedAt);
        return "refreshed";
      }
      const known = new Set(earlier.flatMap((alert) => [...evidenceOf(alert)]));
      if (ids.length === 0 || ids.every((id) => known.has(id))) {
        return "skipped";
      }
      if (existing) {
        alertKey = `${draft.alertKey}#${Date.parse(detectedAt)}`;
      }
    } else if (existing) {
      // Window-bucket findings (concentration / price move): one per bucket.
      return "skipped";
    }
    const alert: SurveillanceAlert = {
      ...draft,
      alertKey,
      alertId: this.createId(),
      status: "open",
      firstDetectedAt: detectedAt,
      lastDetectedAt: detectedAt
    };
    await this.repository.insert(alert);
    await this.repository.appendEvent({
      eventId: this.createId(),
      alertId: alert.alertId,
      action: "detected",
      toStatus: "open",
      actor: "risk-service",
      createdAt: detectedAt
    });
    return "created";
  }

  async listAlerts(query: Partial<ListSurveillanceAlertsQuery>) {
    if (query.type && !SURVEILLANCE_ALERT_TYPES.includes(query.type)) {
      throw new RiskServiceError("SURVEILLANCE_INVALID_TYPE", 400, `Unknown alert type ${query.type}`);
    }
    if (query.status && !SURVEILLANCE_ALERT_STATUSES.includes(query.status)) {
      throw new RiskServiceError("SURVEILLANCE_INVALID_STATUS", 400, `Unknown alert status ${query.status}`);
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const result = await this.repository.list({ ...query, limit, offset });
    return { ...result, limit, offset, items: result.items.map((alert) => this.decorate(alert)) };
  }

  async getAlert(alertId: string) {
    const alert = await this.repository.findById(alertId);
    if (!alert) {
      throw new RiskServiceError("SURVEILLANCE_ALERT_NOT_FOUND", 404, `Alert ${alertId} not found`);
    }
    return { ...this.decorate(alert), events: await this.repository.listEvents(alertId) };
  }

  async updateStatus(command: { alertId: string; status?: string; note?: string; actor?: string }) {
    const status = command.status as SurveillanceAlertStatus;
    if (!SURVEILLANCE_ALERT_STATUSES.includes(status)) {
      throw new RiskServiceError("SURVEILLANCE_INVALID_STATUS", 400, `status must be one of ${SURVEILLANCE_ALERT_STATUSES.join(", ")}`);
    }
    const note = command.note?.trim();
    if (!note) {
      throw new RiskServiceError("SURVEILLANCE_NOTE_REQUIRED", 400, "A note is required for every status change");
    }
    const actor = command.actor?.trim();
    if (!actor) {
      throw new RiskServiceError("SURVEILLANCE_ACTOR_REQUIRED", 400, "actor is required");
    }
    const alert = await this.repository.findById(command.alertId);
    if (!alert) {
      throw new RiskServiceError("SURVEILLANCE_ALERT_NOT_FOUND", 404, `Alert ${command.alertId} not found`);
    }
    if (!ALLOWED_TRANSITIONS[alert.status].includes(status)) {
      throw new RiskServiceError(
        "SURVEILLANCE_INVALID_TRANSITION",
        409,
        `Alert ${alert.alertId} is ${alert.status} and cannot become ${status}`
      );
    }
    const at = this.now().toISOString();
    await this.repository.updateStatus(alert.alertId, { status, note, actor, at });
    const action: SurveillanceAlertEventAction = status === "open" ? "reopened" : status;
    await this.repository.appendEvent({
      eventId: this.createId(),
      alertId: alert.alertId,
      action,
      fromStatus: alert.status,
      toStatus: status,
      note,
      actor,
      createdAt: at
    });
    return this.getAlert(alert.alertId);
  }

  async getOverview() {
    const counts = await this.repository.countByStatusAndType();
    const byType = Object.fromEntries(SURVEILLANCE_ALERT_TYPES.map((type) => [type, 0])) as Record<SurveillanceAlertType, number>;
    const byStatus = Object.fromEntries(SURVEILLANCE_ALERT_STATUSES.map((status) => [status, 0])) as Record<SurveillanceAlertStatus, number>;
    for (const row of counts) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
      if (row.status === "open") {
        byType[row.type] = (byType[row.type] ?? 0) + row.count;
      }
    }
    return {
      lastScan: this.lastScan ?? null,
      thresholds: this.thresholds,
      openByType: byType,
      byStatus,
      marketMakers: this.marketMakerUserIds.map((userId) => ({ userId, label: this.marketMakers(userId)?.label ?? userId })),
      participation: this.lastParticipation
    };
  }

  private decorate(alert: SurveillanceAlert) {
    const label = alert.userId ? this.marketMakers(alert.userId)?.label : undefined;
    return { ...alert, ...(label ? { userLabel: label } : {}) };
  }
}

/** Reads thresholds from RISK_SURVEILLANCE_* env vars (unset / invalid = default). */
export function readSurveillanceThresholdsFromEnv(env: Record<string, string | undefined> = process.env): Partial<SurveillanceThresholds> {
  const number = (key: string): number | undefined => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const entries: Array<[keyof SurveillanceThresholds, number | boolean | undefined]> = [
    ["lookbackMs", number("RISK_SURVEILLANCE_LOOKBACK_MS")],
    ["washMinTrades", number("RISK_SURVEILLANCE_WASH_MIN_TRADES")],
    ["washWindowMs", number("RISK_SURVEILLANCE_WASH_WINDOW_MS")],
    ["concentrationRatio", number("RISK_SURVEILLANCE_CONCENTRATION_RATIO")],
    ["concentrationWindowMs", number("RISK_SURVEILLANCE_CONCENTRATION_WINDOW_MS")],
    ["concentrationMinVolume", number("RISK_SURVEILLANCE_CONCENTRATION_MIN_VOLUME")],
    ["concentrationMinTrades", number("RISK_SURVEILLANCE_CONCENTRATION_MIN_TRADES")],
    ["spoofMinNotional", number("RISK_SURVEILLANCE_SPOOF_MIN_NOTIONAL")],
    ["spoofMaxLifetimeMs", number("RISK_SURVEILLANCE_SPOOF_MAX_LIFETIME_MS")],
    ["spoofMinOrders", number("RISK_SURVEILLANCE_SPOOF_MIN_ORDERS")],
    ["spoofWindowMs", number("RISK_SURVEILLANCE_SPOOF_WINDOW_MS")],
    ["priceMoveRatio", number("RISK_SURVEILLANCE_PRICE_MOVE_RATIO")],
    ["priceMoveWindowMs", number("RISK_SURVEILLANCE_PRICE_MOVE_WINDOW_MS")],
    [
      "includeMarketMakers",
      env.RISK_SURVEILLANCE_INCLUDE_MARKET_MAKERS === undefined
        ? undefined
        : env.RISK_SURVEILLANCE_INCLUDE_MARKET_MAKERS === "true"
    ]
  ];
  // Windows must be positive (they are used as bucket sizes).
  return Object.fromEntries(
    entries.filter(([key, value]) => value !== undefined && !(key.endsWith("Ms") && value === 0))
  ) as Partial<SurveillanceThresholds>;
}
