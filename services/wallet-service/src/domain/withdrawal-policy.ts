import type { AssetCode } from "@web3-cex/domain";

import { addAmounts, compareAmounts, fromAtomicUnits, toAtomicUnits } from "./money.js";

/**
 * Pure withdrawal policy rules (M4-4 KYC limits, M5-2 dual approval and
 * security cooldown). Everything here is deterministic and unit-tested; the
 * application service only feeds it data from repositories / identity.
 */

// ---------------------------------------------------------------------------
// KYC tier limits (M4-4)
// ---------------------------------------------------------------------------

export const KYC_TIERS = ["unverified", "L1", "L2"] as const;
export type KycTier = (typeof KYC_TIERS)[number];

export interface AssetWithdrawalLimit {
  /** Max amount of a single withdrawal (asset units, fee excluded). */
  single: string;
  /** Max sum of non-failed / non-rejected withdrawals in the current UTC day. */
  daily: string;
}

export type KycTierLimitTable = Record<KycTier, Partial<Record<AssetCode, AssetWithdrawalLimit>>>;

/**
 * Per-asset limit table. Kept per asset (not quote-equivalent) on purpose:
 * no price oracle is involved, so the rule is easy to read and to test.
 * Override per tier with WITHDRAWAL_KYC_LIMITS_<TIER>=USDT=1000/2000,ETH=0.5/1
 */
export const DEFAULT_KYC_TIER_LIMITS: KycTierLimitTable = {
  unverified: {
    USDT: { single: "1000", daily: "2000" },
    USDC: { single: "1000", daily: "2000" },
    ETH: { single: "0.5", daily: "1" },
    BTC: { single: "0.02", daily: "0.05" },
    SOL: { single: "10", daily: "20" }
  },
  L1: {
    USDT: { single: "10000", daily: "20000" },
    USDC: { single: "10000", daily: "20000" },
    ETH: { single: "5", daily: "10" },
    BTC: { single: "0.2", daily: "0.5" },
    SOL: { single: "100", daily: "200" }
  },
  L2: {
    USDT: { single: "100000", daily: "200000" },
    USDC: { single: "100000", daily: "200000" },
    ETH: { single: "50", daily: "100" },
    BTC: { single: "2", daily: "5" },
    SOL: { single: "1000", daily: "2000" }
  }
};

export function normalizeKycTier(value: unknown): KycTier {
  return (KYC_TIERS as readonly string[]).includes(String(value)) ? (value as KycTier) : "unverified";
}

/** Parses `USDT=1000/2000,ETH=0.5/1` into a per-asset limit map. Invalid pairs are skipped. */
export function parseTierLimitOverrides(
  raw: string | undefined,
  allowedAssets: readonly AssetCode[]
): Partial<Record<AssetCode, AssetWithdrawalLimit>> {
  const result: Partial<Record<AssetCode, AssetWithdrawalLimit>> = {};
  if (!raw?.trim()) {
    return result;
  }
  const allowed = new Set<string>(allowedAssets);
  for (const pair of raw.split(",")) {
    const [rawAsset, rawLimits] = pair.split("=");
    const asset = rawAsset?.trim();
    const [single, daily] = (rawLimits ?? "").split("/").map((value) => value.trim());
    if (
      !asset ||
      !allowed.has(asset) ||
      !single ||
      !daily ||
      !/^\d+(\.\d+)?$/.test(single) ||
      !/^\d+(\.\d+)?$/.test(daily)
    ) {
      continue;
    }
    result[asset as AssetCode] = { single, daily };
  }
  return result;
}

export function minAmount(...values: Array<string | undefined>): string | undefined {
  let result: string | undefined;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    if (result === undefined || compareAmounts(value, result) < 0) {
      result = value;
    }
  }
  return result;
}

/**
 * Effective limits are the stricter of the platform-wide env limits
 * (WITHDRAWAL_SINGLE/DAILY_LIMIT_BY_ASSET) and the user's KYC tier limits.
 */
export function resolveEffectiveLimits(params: {
  assetCode: AssetCode;
  tier: KycTier;
  tierLimits?: KycTierLimitTable;
  platformSingleLimit?: string;
  platformDailyLimit?: string;
}): { singleLimit?: string; dailyLimit?: string; tierLimit?: AssetWithdrawalLimit } {
  const tierLimit = params.tierLimits?.[params.tier]?.[params.assetCode];
  return {
    singleLimit: minAmount(params.platformSingleLimit, tierLimit?.single),
    dailyLimit: minAmount(params.platformDailyLimit, tierLimit?.daily),
    tierLimit
  };
}

export type LimitCheck =
  | { ok: true; remainingToday?: string }
  | { ok: false; code: "SINGLE_LIMIT_EXCEEDED" | "DAILY_LIMIT_EXCEEDED"; limit: string; remainingToday?: string };

export function checkWithdrawalLimits(params: {
  amount: string;
  usedToday: string;
  singleLimit?: string;
  dailyLimit?: string;
}): LimitCheck {
  const remainingToday = params.dailyLimit
    ? remainingAmount(params.dailyLimit, params.usedToday)
    : undefined;

  if (params.singleLimit && compareAmounts(params.amount, params.singleLimit) > 0) {
    return { ok: false, code: "SINGLE_LIMIT_EXCEEDED", limit: params.singleLimit, remainingToday };
  }
  if (
    params.dailyLimit &&
    compareAmounts(addAmounts(params.usedToday, params.amount), params.dailyLimit) > 0
  ) {
    return { ok: false, code: "DAILY_LIMIT_EXCEEDED", limit: params.dailyLimit, remainingToday };
  }
  return { ok: true, remainingToday };
}

export function remainingAmount(limit: string, used: string): string {
  const remaining = toAtomicUnits(limit) - toAtomicUnits(used);
  return fromAtomicUnits(remaining > 0n ? remaining : 0n);
}

/** Daily quota uses the UTC calendar day of `now`. */
export function utcDayWindow(now: Date): { startAt: string; endAt: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Dual approval (M5-2)
// ---------------------------------------------------------------------------

export interface WithdrawalApproval {
  operatorId: string;
  approvedAt: string;
  note?: string;
}

export interface ApprovalPolicy {
  requiredApprovals: 1 | 2;
  /** Threshold that triggered dual approval, for display. */
  threshold?: string;
}

/** Amounts strictly above the per-asset threshold need two different approvers. */
export function resolveApprovalPolicy(
  amount: string,
  threshold: string | undefined
): ApprovalPolicy {
  if (threshold !== undefined && compareAmounts(amount, threshold) > 0) {
    return { requiredApprovals: 2, threshold };
  }
  return { requiredApprovals: 1, threshold };
}

export type ApprovalDecision =
  | { kind: "pending_second_approval"; approvals: WithdrawalApproval[] }
  | { kind: "approved"; approvals: WithdrawalApproval[] }
  | { kind: "error"; code: "APPROVER_REQUIRED" | "SAME_APPROVER"; message: string };

/**
 * Applies one approval to the list of approvals already recorded.
 * - single-approval withdrawals are approved immediately;
 * - dual-approval withdrawals need two distinct operator ids; the same
 *   operator can never approve twice.
 */
export function applyApproval(params: {
  policy: ApprovalPolicy;
  existing: WithdrawalApproval[];
  operatorId: string | undefined;
  approvedAt: string;
  note?: string;
}): ApprovalDecision {
  const operatorId = params.operatorId?.trim();
  if (params.policy.requiredApprovals === 2 && !operatorId) {
    return {
      kind: "error",
      code: "APPROVER_REQUIRED",
      message: "Dual-approval withdrawals need an identified reviewer (reviewedBy)"
    };
  }

  if (operatorId && params.existing.some((approval) => approval.operatorId === operatorId)) {
    return {
      kind: "error",
      code: "SAME_APPROVER",
      message: `Operator ${operatorId} already approved this withdrawal; a different operator must give the second approval`
    };
  }

  const approvals = [
    ...params.existing,
    { operatorId: operatorId ?? "unknown", approvedAt: params.approvedAt, note: params.note }
  ];
  return approvals.length >= params.policy.requiredApprovals
    ? { kind: "approved", approvals }
    : { kind: "pending_second_approval", approvals };
}

export function readApprovals(metadata: Record<string, unknown>): WithdrawalApproval[] {
  const raw = metadata.approvals;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .filter((item) => typeof item.operatorId === "string" && typeof item.approvedAt === "string")
    .map((item) => ({
      operatorId: String(item.operatorId),
      approvedAt: String(item.approvedAt),
      note: typeof item.note === "string" ? item.note : undefined
    }));
}

export function readApprovalPolicy(
  metadata: Record<string, unknown>,
  fallback: ApprovalPolicy
): ApprovalPolicy {
  const raw = metadata.approvalPolicy;
  if (typeof raw === "object" && raw !== null) {
    const required = (raw as Record<string, unknown>).requiredApprovals;
    const threshold = (raw as Record<string, unknown>).threshold;
    if (required === 1 || required === 2) {
      return {
        requiredApprovals: required,
        threshold: typeof threshold === "string" ? threshold : undefined
      };
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Security cooldown (M5-2)
// ---------------------------------------------------------------------------

export type SecurityChangeKind = "withdrawal_address_added" | "two_factor_changed" | "new_device_login";

export interface SecurityChange {
  kind: SecurityChangeKind;
  at: string;
}

export interface CooldownStatus {
  active: boolean;
  cooldownSeconds: number;
  remainingSeconds: number;
  reason?: SecurityChangeKind;
  changedAt?: string;
  until?: string;
}

/**
 * After a security change (new withdrawal address, 2FA enabled / disabled) all
 * withdrawals are blocked for `cooldownSeconds`. The most recent change wins.
 */
export function evaluateCooldown(params: {
  now: Date;
  cooldownSeconds: number;
  changes: SecurityChange[];
}): CooldownStatus {
  const cooldownSeconds = Math.max(0, Math.floor(params.cooldownSeconds));
  const latest = params.changes
    .filter((change) => Number.isFinite(Date.parse(change.at)))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];

  if (cooldownSeconds === 0 || !latest) {
    return { active: false, cooldownSeconds, remainingSeconds: 0 };
  }

  const untilMs = Date.parse(latest.at) + cooldownSeconds * 1000;
  const remainingMs = untilMs - params.now.getTime();
  const until = new Date(untilMs).toISOString();
  if (remainingMs <= 0) {
    return { active: false, cooldownSeconds, remainingSeconds: 0, reason: latest.kind, changedAt: latest.at, until };
  }
  return {
    active: true,
    cooldownSeconds,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    reason: latest.kind,
    changedAt: latest.at,
    until
  };
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${rest}s`;
  }
  return `${rest}s`;
}

export function describeCooldown(status: CooldownStatus): string {
  const reason =
    status.reason === "two_factor_changed"
      ? "a two-factor authentication change"
      : status.reason === "new_device_login"
        ? "a login from a new device"
        : "adding a new withdrawal address";
  return (
    `Withdrawals are locked for ${formatDuration(status.cooldownSeconds)} after ${reason}; ` +
    `${formatDuration(status.remainingSeconds)} remaining (remainingSeconds=${status.remainingSeconds}, until ${status.until})`
  );
}
