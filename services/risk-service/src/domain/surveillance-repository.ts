import type {
  SurveillanceActivity,
  SurveillanceAlertDraft,
  SurveillanceAlertStatus,
  SurveillanceAlertType,
  SurveillanceThresholds
} from "./surveillance.js";

export interface SurveillanceAlert extends SurveillanceAlertDraft {
  alertId: string;
  status: SurveillanceAlertStatus;
  firstDetectedAt: string;
  lastDetectedAt: string;
  statusNote?: string;
  statusUpdatedBy?: string;
  statusUpdatedAt?: string;
}

export type SurveillanceAlertEventAction = "detected" | "acknowledged" | "dismissed" | "reopened";

/** Append-only audit of every alert status change. */
export interface SurveillanceAlertEvent {
  eventId: string;
  alertId: string;
  action: SurveillanceAlertEventAction;
  fromStatus?: SurveillanceAlertStatus;
  toStatus: SurveillanceAlertStatus;
  note?: string;
  actor: string;
  createdAt: string;
}

export interface ListSurveillanceAlertsQuery {
  type?: SurveillanceAlertType;
  status?: SurveillanceAlertStatus;
  market?: string;
  userId?: string;
  includeMarketMakers?: boolean;
  limit: number;
  offset: number;
}

export interface SurveillanceRepository {
  findByKey(alertKey: string): Promise<SurveillanceAlert | null>;
  findById(alertId: string): Promise<SurveillanceAlert | null>;
  /** Alerts of one subject (type + market + user) detected since `since`, newest first. */
  listForSubject(subject: { type: SurveillanceAlertType; market: string; userId?: string; since: string }): Promise<SurveillanceAlert[]>;
  insert(alert: SurveillanceAlert): Promise<void>;
  /** Refreshes evidence / metrics / window / lastDetectedAt of an existing alert. */
  refresh(alertId: string, draft: SurveillanceAlertDraft, detectedAt: string): Promise<void>;
  updateStatus(
    alertId: string,
    update: { status: SurveillanceAlertStatus; note?: string; actor: string; at: string }
  ): Promise<void>;
  list(query: ListSurveillanceAlertsQuery): Promise<{ items: SurveillanceAlert[]; total: number }>;
  countByStatusAndType(): Promise<Array<{ status: SurveillanceAlertStatus; type: SurveillanceAlertType; count: number }>>;
  appendEvent(event: SurveillanceAlertEvent): Promise<void>;
  listEvents(alertId: string): Promise<SurveillanceAlertEvent[]>;
}

export interface SurveillanceActivityQuery {
  since: string;
  until: string;
  orderMinNotional: string;
  orderMaxLifetimeMs: number;
  orderExcludeUserIds: string[];
}

/** order-service `/api/v1/surveillance/activity`. */
export interface SurveillanceActivityClient {
  getActivity(query: SurveillanceActivityQuery): Promise<SurveillanceActivity>;
}

export interface SurveillanceScanResult {
  scannedAt: string;
  since: string;
  until: string;
  tradeCount: number;
  cancelledOrderCount: number;
  truncated: boolean;
  detected: number;
  created: number;
  refreshed: number;
  durationMs: number;
  trigger: "automatic" | "manual";
  error?: string;
}

export type { SurveillanceThresholds };
