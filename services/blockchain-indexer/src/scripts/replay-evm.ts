import { BlockchainIndexerApplicationService } from "../application/blockchain-indexer-application-service.js";
import { HttpWalletClient } from "../infrastructure/http-wallet-client.js";
import { EvmRpcClient } from "../infrastructure/evm-rpc-client.js";
import { loadEvmScanConfigFromEnv } from "../infrastructure/evm-scan-config.js";
import { createBlockchainIndexerPool } from "../infrastructure/postgres.js";
import { PostgresBlockchainIndexerRepository } from "../infrastructure/postgres-blockchain-indexer-repository.js";
import type { EvmNetwork } from "../domain/evm-client.js";
import type { ObservationType } from "../domain/types.js";

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const network = (process.env.INDEXER_REPLAY_NETWORK ?? "ethereum") as EvmNetwork;
  const observationType = (process.env.INDEXER_REPLAY_OBSERVATION_TYPE ??
    "both") as ObservationType | "both";
  const pool = createBlockchainIndexerPool();
  const repository = new PostgresBlockchainIndexerRepository(pool, pool);
  const evmScanConfig = loadEvmScanConfigFromEnv();
  const applicationService = new BlockchainIndexerApplicationService(
    repository,
    new HttpWalletClient(process.env.WALLET_SERVICE_BASE_URL ?? "http://127.0.0.1:3002"),
    {
      confirmationThreshold: Number(process.env.INDEXER_CONFIRMATION_THRESHOLD ?? "12"),
      maxScanBlockRange: evmScanConfig.maxScanBlockRange,
      walletPageSize: evmScanConfig.walletPageSize,
      evmRpcUrls: evmScanConfig.rpcUrls,
      evmNativeAssetCodes: evmScanConfig.nativeAssetCodes,
      evmTokenContracts: evmScanConfig.tokenContracts,
      evmClientFactory: ({ rpcUrl }) => new EvmRpcClient(rpcUrl)
    }
  );

  try {
    const result = await applicationService.runEvmReplay({
      network,
      observationType,
      fromBlock: parseNumber(process.env.INDEXER_REPLAY_FROM_BLOCK),
      toBlock: parseNumber(process.env.INDEXER_REPLAY_TO_BLOCK),
      rpcUrl: process.env.INDEXER_REPLAY_RPC_URL
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
