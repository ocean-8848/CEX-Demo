import type { AssetCode } from "@web3-cex/domain";

import type { EvmNetwork } from "../domain/evm-client.js";
import type { EvmTokenContractConfig } from "../domain/types.js";

export interface EvmScanConfig {
  rpcUrls: Partial<Record<EvmNetwork, string>>;
  nativeAssetCodes: Partial<Record<EvmNetwork, AssetCode>>;
  tokenContracts: Partial<Record<EvmNetwork, EvmTokenContractConfig[]>>;
  maxScanBlockRange: number;
  walletPageSize: number;
}

export function loadEvmScanConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EvmScanConfig {
  return {
    rpcUrls: {
      ethereum: env.EVM_RPC_URL_ETHEREUM,
      bsc: env.EVM_RPC_URL_BSC,
      base: env.EVM_RPC_URL_BASE
    },
    nativeAssetCodes: parseNativeAssetCodes(env.EVM_NATIVE_ASSET_CODES),
    tokenContracts: parseTokenContracts(env.EVM_TOKEN_CONTRACTS),
    maxScanBlockRange: parsePositiveInteger(env.INDEXER_MAX_SCAN_BLOCK_RANGE, 200),
    walletPageSize: parsePositiveInteger(env.INDEXER_WALLET_PAGE_SIZE, 200)
  };
}

function parseNativeAssetCodes(
  rawValue: string | undefined
): Partial<Record<EvmNetwork, AssetCode>> {
  if (!rawValue) {
    return {};
  }

  const entries = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nativeAssetCodes: Partial<Record<EvmNetwork, AssetCode>> = {};

  for (const entry of entries) {
    const [network, assetCode] = entry.split("=").map((value) => value?.trim());

    if (!isEvmNetwork(network) || !assetCode) {
      continue;
    }

    nativeAssetCodes[network] = assetCode as AssetCode;
  }

  return nativeAssetCodes;
}

function parseTokenContracts(
  rawValue: string | undefined
): Partial<Record<EvmNetwork, EvmTokenContractConfig[]>> {
  if (!rawValue) {
    return {};
  }

  const tokenContracts: Partial<Record<EvmNetwork, EvmTokenContractConfig[]>> = {};
  const entries = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [network, assetCode, contractAddress, decimalsRaw] = entry
      .split(":")
      .map((value) => value?.trim());

    if (!isEvmNetwork(network) || !assetCode || !contractAddress) {
      continue;
    }

    const decimals = parsePositiveInteger(decimalsRaw, 18);
    tokenContracts[network] ??= [];
    tokenContracts[network].push({
      assetCode: assetCode as AssetCode,
      contractAddress: normalizeHexAddress(contractAddress),
      decimals
    });
  }

  return tokenContracts;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeHexAddress(address: string): string {
  return address.toLowerCase();
}

function isEvmNetwork(value: string | undefined): value is EvmNetwork {
  return value === "ethereum" || value === "bsc" || value === "base";
}
