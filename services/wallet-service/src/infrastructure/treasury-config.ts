import type { Network } from "@web3-cex/domain";

import { defaultTreasuryAddress } from "../application/treasury-service.js";
import {
  DEFAULT_HOT_WALLET_WATERMARKS,
  parseAssetAmountMap,
  parseHotWalletWatermarks
} from "../domain/treasury-policy.js";
import type { TreasuryConfig } from "../domain/treasury-types.js";

/**
 * TREASURY_HOT_WALLET_WATERMARKS   ASSET=low/high,... (empty string disables all watermarks)
 * TREASURY_SWEEP_MIN_AMOUNT_BY_ASSET ASSET=amount,... (default: sweep any credited amount)
 * TREASURY_TRANSFER_CONFIRMATION_THRESHOLD (default WITHDRAWAL_CONFIRMATION_THRESHOLD or 12)
 * TREASURY_SWEEP_BATCH_SIZE        deposits scanned per sweep run (default 200)
 * TREASURY_HOT_WALLET_ADDRESS / TREASURY_COLD_WALLET_ADDRESS  override the derived demo addresses
 */
export function loadTreasuryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TreasuryConfig {
  const hot = env.TREASURY_HOT_WALLET_ADDRESS?.trim();
  const cold = env.TREASURY_COLD_WALLET_ADDRESS?.trim();
  return {
    watermarks: parseHotWalletWatermarks(env.TREASURY_HOT_WALLET_WATERMARKS ?? DEFAULT_HOT_WALLET_WATERMARKS),
    sweepMinAmounts: parseAssetAmountMap(env.TREASURY_SWEEP_MIN_AMOUNT_BY_ASSET),
    confirmationThreshold: positiveInt(
      env.TREASURY_TRANSFER_CONFIRMATION_THRESHOLD ?? env.WITHDRAWAL_CONFIRMATION_THRESHOLD,
      12
    ),
    sweepBatchSize: positiveInt(env.TREASURY_SWEEP_BATCH_SIZE, 200),
    hotWalletAddress: (network: Network) => hot || defaultTreasuryAddress("hot", network),
    coldWalletAddress: (network: Network) => cold || defaultTreasuryAddress("cold", network)
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}
