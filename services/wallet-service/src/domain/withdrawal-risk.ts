import type { AssetCode, Network } from "@web3-cex/domain";

import { compareAmounts } from "./money.js";

/**
 * Simplified KYT (know-your-transaction) for withdrawals: a pure, rule-based
 * scorer. The application service gathers the facts (blacklist hit, demo
 * address label, address book entry, earlier withdrawals) and this module turns
 * them into a score, a level and a readable reason list. No external KYT
 * provider is involved; the label set is demo data.
 */

export const WITHDRAWAL_RISK_LEVELS = ["low", "medium", "high", "blocked"] as const;
export type WithdrawalRiskLevel = (typeof WITHDRAWAL_RISK_LEVELS)[number];

export type WithdrawalRiskRuleCode =
  | "BLACKLISTED_ADDRESS"
  | "LABELLED_HIGH_RISK_ADDRESS"
  | "WHITELISTED_ADDRESS"
  | "KNOWN_ADDRESS"
  | "FIRST_TIME_ADDRESS"
  | "FIRST_TIME_LARGE_AMOUNT"
  | "NEW_ADDRESS_COOLDOWN";

export interface WithdrawalRiskReason {
  code: WithdrawalRiskRuleCode;
  /** Points this rule added (0 for informational rules). */
  score: number;
  /** Short Chinese explanation shown to ops / the user. */
  message: string;
  detail?: Record<string, unknown>;
}

export interface WithdrawalRiskAssessment {
  score: number;
  level: WithdrawalRiskLevel;
  reasons: WithdrawalRiskReason[];
  /** high: manual review with two different approvers regardless of amount. */
  requiresDualApproval: boolean;
  assessedAt: string;
}

export const ADDRESS_BLACKLIST_CATEGORIES = ["sanctioned", "mixer", "scam", "hack", "other"] as const;
export type AddressBlacklistCategory = (typeof ADDRESS_BLACKLIST_CATEGORIES)[number];
export type AddressBlacklistStatus = "active" | "removed";

export interface AddressBlacklistEntry {
  entryId: string;
  network: Network;
  address: string;
  category: AddressBlacklistCategory;
  reason: string;
  /** `seed` = shipped demo data, `ops` = added in ops-console. */
  source: "seed" | "ops";
  status: AddressBlacklistStatus;
  createdBy?: string;
  createdAt: string;
  removedBy?: string;
  removedAt?: string;
  removalReason?: string;
}

export type AddressRiskLabelKind = "mixer" | "high_risk" | "gambling" | "darknet";

export interface AddressRiskLabel {
  address: string;
  label: AddressRiskLabelKind;
  description: string;
}

/**
 * Demo label set (stand-in for a KYT provider's address intelligence). These
 * addresses are fabricated; they do not belong to any real service.
 * Extend with WITHDRAWAL_RISK_ADDRESS_LABELS=0xabc...=mixer,0xdef...=high_risk
 */
export const DEMO_ADDRESS_RISK_LABELS: AddressRiskLabel[] = [
  {
    address: "0xdeadbeef00000000000000000000000000000001",
    label: "mixer",
    description: "演示：混币服务入金地址"
  },
  {
    address: "0xdeadbeef00000000000000000000000000000002",
    label: "high_risk",
    description: "演示：无牌照高风险交易所"
  },
  {
    address: "0xdeadbeef00000000000000000000000000000003",
    label: "gambling",
    description: "演示：链上博彩合约"
  }
];

export interface WithdrawalRiskRules {
  /** false disables scoring (every withdrawal is low, nothing is blocked). */
  enabled: boolean;
  /** First-time address + amount strictly above this adds FIRST_TIME_LARGE_AMOUNT. */
  largeAmountByAsset: Partial<Record<AssetCode, string>>;
  /** An address book entry younger than this adds NEW_ADDRESS_COOLDOWN. */
  newAddressWindowSeconds: number;
  /** Address (lower-case for EVM) -> label. */
  labels: AddressRiskLabel[];
}

export const DEFAULT_WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET = "USDT=1000,USDC=1000,ETH=0.5,BTC=0.02,SOL=10";
export const DEFAULT_WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS = 24 * 60 * 60;

export const DEFAULT_WITHDRAWAL_RISK_RULES: WithdrawalRiskRules = {
  enabled: true,
  largeAmountByAsset: { USDT: "1000", USDC: "1000", ETH: "0.5", BTC: "0.02", SOL: "10" },
  newAddressWindowSeconds: DEFAULT_WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS,
  labels: DEMO_ADDRESS_RISK_LABELS
};

export const RISK_SCORES = {
  blacklisted: 100,
  labelled: 70,
  firstTime: 10,
  firstTimeLarge: 40,
  newAddress: 30
} as const;

/** score >= 60 high, >= 30 medium, otherwise low; blacklist is always blocked. */
export function riskLevelForScore(score: number): Exclude<WithdrawalRiskLevel, "blocked"> {
  if (score >= 60) {
    return "high";
  }
  if (score >= 30) {
    return "medium";
  }
  return "low";
}

export interface WithdrawalRiskFacts {
  assetCode: AssetCode;
  amount: string;
  /** Active blacklist entry for (network, address), if any. */
  blacklistEntry?: AddressBlacklistEntry | null;
  label?: AddressRiskLabel | null;
  whitelisted: boolean;
  /** Earlier approved / broadcasted / confirmed withdrawals of this user to this address. */
  priorSuccessfulWithdrawals: number;
  /** created_at of the user's address book entry for this address. */
  addressBookCreatedAt?: string;
  now: Date;
}

export function scoreWithdrawalRisk(
  facts: WithdrawalRiskFacts,
  rules: WithdrawalRiskRules = DEFAULT_WITHDRAWAL_RISK_RULES
): WithdrawalRiskAssessment {
  const assessedAt = facts.now.toISOString();
  if (!rules.enabled) {
    return { score: 0, level: "low", reasons: [], requiresDualApproval: false, assessedAt };
  }

  if (facts.blacklistEntry) {
    return {
      score: RISK_SCORES.blacklisted,
      level: "blocked",
      reasons: [
        {
          code: "BLACKLISTED_ADDRESS",
          score: RISK_SCORES.blacklisted,
          message: `目标地址在平台黑名单中（${describeBlacklistCategory(facts.blacklistEntry.category)}）`,
          detail: {
            entryId: facts.blacklistEntry.entryId,
            category: facts.blacklistEntry.category,
            reason: facts.blacklistEntry.reason
          }
        }
      ],
      requiresDualApproval: false,
      assessedAt
    };
  }

  const reasons: WithdrawalRiskReason[] = [];
  if (facts.label) {
    reasons.push({
      code: "LABELLED_HIGH_RISK_ADDRESS",
      score: RISK_SCORES.labelled,
      message: `目标地址被标记为${describeLabel(facts.label.label)}：${facts.label.description}`,
      detail: { label: facts.label.label }
    });
  }

  if (facts.whitelisted) {
    reasons.push({ code: "WHITELISTED_ADDRESS", score: 0, message: "目标地址已在用户白名单中" });
  } else if (facts.priorSuccessfulWithdrawals > 0) {
    reasons.push({
      code: "KNOWN_ADDRESS",
      score: 0,
      message: `该用户曾成功提现到此地址 ${facts.priorSuccessfulWithdrawals} 次`,
      detail: { priorSuccessfulWithdrawals: facts.priorSuccessfulWithdrawals }
    });
  } else {
    reasons.push({ code: "FIRST_TIME_ADDRESS", score: RISK_SCORES.firstTime, message: "首次向该地址提现" });
    const largeAmount = rules.largeAmountByAsset[facts.assetCode];
    if (largeAmount !== undefined && compareAmounts(facts.amount, largeAmount) > 0) {
      reasons.push({
        code: "FIRST_TIME_LARGE_AMOUNT",
        score: RISK_SCORES.firstTimeLarge,
        message: `首次地址且金额超过 ${largeAmount} ${facts.assetCode}`,
        detail: { threshold: largeAmount }
      });
    }
    if (facts.addressBookCreatedAt && rules.newAddressWindowSeconds > 0) {
      const ageSeconds = (facts.now.getTime() - Date.parse(facts.addressBookCreatedAt)) / 1000;
      if (Number.isFinite(ageSeconds) && ageSeconds < rules.newAddressWindowSeconds) {
        reasons.push({
          code: "NEW_ADDRESS_COOLDOWN",
          score: RISK_SCORES.newAddress,
          message: `地址簿新增地址未满 ${Math.round(rules.newAddressWindowSeconds / 3600)} 小时`,
          detail: {
            addressBookCreatedAt: facts.addressBookCreatedAt,
            windowSeconds: rules.newAddressWindowSeconds
          }
        });
      }
    }
  }

  const score = Math.min(
    99,
    reasons.reduce((total, reason) => total + reason.score, 0)
  );
  const level = riskLevelForScore(score);
  return { score, level, reasons, requiresDualApproval: level === "high", assessedAt };
}

export function findAddressRiskLabel(
  labels: readonly AddressRiskLabel[],
  address: string
): AddressRiskLabel | null {
  const normalized = address.trim().toLowerCase();
  return labels.find((label) => label.address.toLowerCase() === normalized) ?? null;
}

/** Parses `0xabc=mixer,0xdef=high_risk` into labels; unknown kinds are skipped. */
export function parseAddressRiskLabels(raw: string | undefined): AddressRiskLabel[] {
  if (!raw?.trim()) {
    return [];
  }
  const kinds: AddressRiskLabelKind[] = ["mixer", "high_risk", "gambling", "darknet"];
  const result: AddressRiskLabel[] = [];
  for (const pair of raw.split(",")) {
    const [rawAddress, rawLabel] = pair.split("=");
    const address = rawAddress?.trim().toLowerCase();
    const label = rawLabel?.trim() as AddressRiskLabelKind | undefined;
    if (!address || !label || !kinds.includes(label)) {
      continue;
    }
    result.push({ address, label, description: `环境变量配置的${describeLabel(label)}地址` });
  }
  return result;
}

export function isAddressBlacklistCategory(value: unknown): value is AddressBlacklistCategory {
  return (ADDRESS_BLACKLIST_CATEGORIES as readonly string[]).includes(String(value));
}

export function isWithdrawalRiskLevel(value: unknown): value is WithdrawalRiskLevel {
  return (WITHDRAWAL_RISK_LEVELS as readonly string[]).includes(String(value));
}

export function describeBlacklistCategory(category: AddressBlacklistCategory): string {
  switch (category) {
    case "sanctioned":
      return "制裁名单";
    case "mixer":
      return "混币器";
    case "scam":
      return "诈骗";
    case "hack":
      return "被盗资金";
    default:
      return "其他";
  }
}

function describeLabel(label: AddressRiskLabelKind): string {
  switch (label) {
    case "mixer":
      return "混币器";
    case "high_risk":
      return "高风险实体";
    case "gambling":
      return "博彩";
    case "darknet":
      return "暗网市场";
    default:
      return "高风险";
  }
}

/** Customer-facing message for a blocked destination (no internal detail leaked). */
export function describeBlockedAddress(entry: AddressBlacklistEntry): string {
  return (
    `Destination address is blocked by platform risk control (${entry.category}); ` +
    "withdrawals to this address are not allowed"
  );
}
