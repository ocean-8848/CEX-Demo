// Types for fee tiers and market surveillance BFF responses.

export interface FeeTierDefinition {
  tier: string;
  name: string;
  minVolume: string;
  makerFeeRate: string;
  takerFeeRate: string;
}

export interface FeeTierAuditEntry {
  auditId: string;
  userId: string;
  action: "set" | "clear";
  previousTier?: string;
  tier?: string;
  note: string;
  actor: string;
  createdAt: string;
}

export interface UserFeeTierProfile {
  userId: string;
  tier: string;
  name: string;
  source: "volume" | "programme" | "override";
  makerFeeRate: string;
  takerFeeRate: string;
  volume: string;
  volumeAsset: string;
  volumeWindowDays: number;
  nextTier: FeeTierDefinition | null;
  remainingVolume: string;
  progressRatio: number;
  override: { tier: string; note: string; assignedBy: string; updatedAt: string } | null;
  marketMaker: { label: string; feeTier?: string } | null;
  markets: Array<{ market: string; makerFeeRate: string; takerFeeRate: string }>;
  tiers: FeeTierDefinition[];
  audit: FeeTierAuditEntry[];
}

export type SurveillanceAlertType = "wash_trade" | "concentrated_volume" | "spoofing" | "price_move";
export type SurveillanceAlertStatus = "open" | "acknowledged" | "dismissed";

export interface SurveillanceAlert {
  alertId: string;
  alertKey: string;
  type: SurveillanceAlertType;
  market: string;
  userId?: string;
  userLabel?: string;
  severity: "low" | "medium" | "high";
  status: SurveillanceAlertStatus;
  summary: string;
  metrics: Record<string, string | number>;
  evidence: {
    tradeIds: string[];
    orderIds: string[];
    trades: Array<{ tradeId: string; price: string; quantity: string; buyerUserId: string; sellerUserId: string; executedAt: string }>;
    orders: Array<{ orderId: string; side: "buy" | "sell"; price: string; quantity: string; createdAt: string; cancelledAt: string; lifetimeMs: number }>;
  };
  marketMaker: boolean;
  windowStart: string;
  windowEnd: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  statusNote?: string;
  statusUpdatedBy?: string;
  statusUpdatedAt?: string;
}

export interface SurveillanceAlertDetail extends SurveillanceAlert {
  events: Array<{
    eventId: string;
    action: "detected" | "acknowledged" | "dismissed" | "reopened";
    fromStatus?: SurveillanceAlertStatus;
    toStatus: SurveillanceAlertStatus;
    note?: string;
    actor: string;
    createdAt: string;
  }>;
}

export interface SurveillanceOverview {
  lastScan: {
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
  } | null;
  thresholds: Record<string, number | boolean>;
  openByType: Record<SurveillanceAlertType, number>;
  byStatus: Record<SurveillanceAlertStatus, number>;
  marketMakers: Array<{ userId: string; label: string }>;
  participation: Array<{
    market: string;
    tradeCount: number;
    volume: string;
    topAccounts: Array<{ userId: string; label?: string; marketMaker: boolean; volume: string; share: number }>;
  }>;
}
