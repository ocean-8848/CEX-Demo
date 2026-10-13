import { KNOWN_NETWORKS, listAssetCodes, type AssetCode, type Network } from "@web3-cex/domain";

import type { WithdrawalValidationRules } from "../domain/types.js";
import {
  DEFAULT_KYC_TIER_LIMITS,
  parseTierLimitOverrides,
  type KycTierLimitTable
} from "../domain/withdrawal-policy.js";
import {
  DEFAULT_WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET,
  DEFAULT_WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS,
  DEMO_ADDRESS_RISK_LABELS,
  parseAddressRiskLabels,
  type WithdrawalRiskRules
} from "../domain/withdrawal-risk.js";

// Assets come from config/markets.json; networks are the code-level set.
const ASSET_CODES: AssetCode[] = listAssetCodes();
const NETWORKS: readonly Network[] = KNOWN_NETWORKS;

/** M5-2 defaults: amounts strictly above these need two different approvers. */
export const DEFAULT_DUAL_APPROVAL_THRESHOLD_BY_ASSET = "USDT=5000,USDC=5000,ETH=2,BTC=0.1,SOL=50";
/** M5-2 default: 24h lock after a security change. The demo stack overrides it to 0. */
export const DEFAULT_SECURITY_COOLDOWN_SECONDS = 24 * 60 * 60;

export function loadWithdrawalValidationRulesFromEnv(): WithdrawalValidationRules {
  return {
    requireTwoFactor: process.env.WITHDRAWAL_REQUIRE_2FA === "true",
    requireWhitelist: process.env.WITHDRAWAL_REQUIRE_WHITELIST === "true",
    minAmountByAsset: parseKeyValueMap<AssetCode>(
      process.env.WITHDRAWAL_MIN_AMOUNT_BY_ASSET,
      ASSET_CODES
    ),
    minFeeByNetwork: parseKeyValueMap<Network>(
      process.env.WITHDRAWAL_MIN_FEE_BY_NETWORK,
      NETWORKS
    ),
    singleLimitByAsset: parseKeyValueMap<AssetCode>(
      process.env.WITHDRAWAL_SINGLE_LIMIT_BY_ASSET,
      ASSET_CODES
    ),
    dailyLimitByAsset: parseKeyValueMap<AssetCode>(
      process.env.WITHDRAWAL_DAILY_LIMIT_BY_ASSET,
      ASSET_CODES
    ),
    kycTierLimits:
      process.env.WITHDRAWAL_KYC_LIMITS_ENABLED === "false" ? undefined : loadKycTierLimitsFromEnv(),
    dualApprovalThresholdByAsset: parseKeyValueMap<AssetCode>(
      process.env.WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_BY_ASSET ?? DEFAULT_DUAL_APPROVAL_THRESHOLD_BY_ASSET,
      ASSET_CODES
    ),
    securityCooldownSeconds: parseNonNegativeInteger(
      process.env.WITHDRAWAL_SECURITY_COOLDOWN_SECONDS,
      DEFAULT_SECURITY_COOLDOWN_SECONDS
    ),
    riskRules: loadWithdrawalRiskRulesFromEnv(),
    // Default 0 = off: a new-device login does not block withdrawals.
    newDeviceLockSeconds: parseNonNegativeInteger(process.env.WITHDRAWAL_NEW_DEVICE_LOCK_SECONDS, 0)
  };
}

/** Simplified KYT rules; labels from env are appended to the demo label set. */
export function loadWithdrawalRiskRulesFromEnv(env: NodeJS.ProcessEnv = process.env): WithdrawalRiskRules {
  return {
    enabled: env.WITHDRAWAL_RISK_ENABLED !== "false",
    largeAmountByAsset: parseKeyValueMap<AssetCode>(
      env.WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET ?? DEFAULT_WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET,
      ASSET_CODES
    ),
    newAddressWindowSeconds: parseNonNegativeInteger(
      env.WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS,
      DEFAULT_WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS
    ),
    labels: [...DEMO_ADDRESS_RISK_LABELS, ...parseAddressRiskLabels(env.WITHDRAWAL_RISK_ADDRESS_LABELS)]
  };
}

/** Defaults from DEFAULT_KYC_TIER_LIMITS, overridable per tier and asset. */
export function loadKycTierLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): KycTierLimitTable {
  return {
    unverified: {
      ...DEFAULT_KYC_TIER_LIMITS.unverified,
      ...parseTierLimitOverrides(env.WITHDRAWAL_KYC_LIMITS_UNVERIFIED, ASSET_CODES)
    },
    L1: {
      ...DEFAULT_KYC_TIER_LIMITS.L1,
      ...parseTierLimitOverrides(env.WITHDRAWAL_KYC_LIMITS_L1, ASSET_CODES)
    },
    L2: {
      ...DEFAULT_KYC_TIER_LIMITS.L2,
      ...parseTierLimitOverrides(env.WITHDRAWAL_KYC_LIMITS_L2, ASSET_CODES)
    }
  };
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseKeyValueMap<TKey extends string>(
  raw: string | undefined,
  allowedKeys: readonly TKey[]
): Partial<Record<TKey, string>> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }

  const allowed = new Set<string>(allowedKeys);
  const result: Partial<Record<TKey, string>> = {};

  for (const pair of raw.split(",")) {
    const [rawKey, rawValue] = pair.split("=");
    const key = rawKey?.trim();
    const value = rawValue?.trim();

    if (!key || !value || !allowed.has(key) || !/^\d+(\.\d+)?$/.test(value)) {
      continue;
    }

    result[key as TKey] = value;
  }

  return result;
}
