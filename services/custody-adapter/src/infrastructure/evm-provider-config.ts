import type { AssetCode } from "@web3-cex/domain";

export type EvmNetwork = "ethereum" | "bsc" | "base";

export interface EvmTokenContractConfig {
  assetCode: AssetCode;
  contractAddress: string;
  decimals: number;
}

export interface EvmHotWalletConfig {
  rpcUrls: Partial<Record<EvmNetwork, string>>;
  privateKeys: Partial<Record<EvmNetwork, `0x${string}`>>;
  mnemonic?: string;
  accountIndexes: Partial<Record<EvmNetwork, number>>;
  nativeAssetCodes: Partial<Record<EvmNetwork, AssetCode>>;
  tokenContracts: Partial<Record<EvmNetwork, EvmTokenContractConfig[]>>;
}

export function loadEvmHotWalletConfig(
  env: NodeJS.ProcessEnv = process.env
): EvmHotWalletConfig {
  return {
    rpcUrls: {
      ethereum: env.CUSTODY_EVM_RPC_URL_ETHEREUM,
      bsc: env.CUSTODY_EVM_RPC_URL_BSC,
      base: env.CUSTODY_EVM_RPC_URL_BASE
    },
    privateKeys: {
      ethereum: normalizePrivateKey(env.CUSTODY_EVM_PRIVATE_KEY_ETHEREUM),
      bsc: normalizePrivateKey(env.CUSTODY_EVM_PRIVATE_KEY_BSC),
      base: normalizePrivateKey(env.CUSTODY_EVM_PRIVATE_KEY_BASE)
    },
    mnemonic: env.CUSTODY_EVM_MNEMONIC,
    accountIndexes: {
      ethereum: parseAccountIndex(env.CUSTODY_EVM_ACCOUNT_INDEX_ETHEREUM),
      bsc: parseAccountIndex(env.CUSTODY_EVM_ACCOUNT_INDEX_BSC),
      base: parseAccountIndex(env.CUSTODY_EVM_ACCOUNT_INDEX_BASE)
    },
    nativeAssetCodes: parseNativeAssetCodes(env.CUSTODY_EVM_NATIVE_ASSET_CODES),
    tokenContracts: parseTokenContracts(env.CUSTODY_EVM_TOKEN_CONTRACTS)
  };
}

function parseAccountIndex(rawValue: string | undefined): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function normalizePrivateKey(value: string | undefined): `0x${string}` | undefined {
  if (!value) {
    return undefined;
  }

  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function parseNativeAssetCodes(
  rawValue: string | undefined
): Partial<Record<EvmNetwork, AssetCode>> {
  if (!rawValue) {
    return {
      ethereum: "ETH",
      base: "ETH"
    };
  }

  const nativeAssetCodes: Partial<Record<EvmNetwork, AssetCode>> = {};

  for (const entry of rawValue.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [network, assetCode] = entry.split("=").map((item) => item?.trim());

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

  for (const entry of rawValue.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [network, assetCode, contractAddress, decimalsRaw] = entry
      .split(":")
      .map((item) => item?.trim());

    if (!isEvmNetwork(network) || !assetCode || !contractAddress) {
      continue;
    }

    const decimals = Number(decimalsRaw ?? "18");
    tokenContracts[network] ??= [];
    tokenContracts[network].push({
      assetCode: assetCode as AssetCode,
      contractAddress: contractAddress.toLowerCase(),
      decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18
    });
  }

  return tokenContracts;
}

function isEvmNetwork(value: string | undefined): value is EvmNetwork {
  return value === "ethereum" || value === "bsc" || value === "base";
}
