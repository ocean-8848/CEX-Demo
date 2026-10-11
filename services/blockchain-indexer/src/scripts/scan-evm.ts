import { BlockchainIndexerApplicationService } from "../application/blockchain-indexer-application-service.js";
import { scanConfiguredEvmNetworks } from "../application/indexer-ops.js";
import { HttpWalletClient } from "../infrastructure/http-wallet-client.js";
import { EvmRpcClient } from "../infrastructure/evm-rpc-client.js";
import { loadEvmScanConfigFromEnv } from "../infrastructure/evm-scan-config.js";
import { createBlockchainIndexerPool } from "../infrastructure/postgres.js";
import { PostgresBlockchainIndexerRepository } from "../infrastructure/postgres-blockchain-indexer-repository.js";
import type { EvmNetwork } from "../domain/evm-client.js";

function resolveNetworks(configured: EvmNetwork[]): EvmNetwork[] {
  const rawValue = process.env.INDEXER_ENABLED_EVM_NETWORKS;
  if (!rawValue) {
    return configured;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is EvmNetwork =>
      value === "ethereum" || value === "bsc" || value === "base"
    );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pool = createBlockchainIndexerPool();
  const repository = new PostgresBlockchainIndexerRepository(pool, pool);
  const evmScanConfig = loadEvmScanConfigFromEnv();
  const configuredNetworks = (["ethereum", "bsc", "base"] as EvmNetwork[]).filter(
    (network) => evmScanConfig.rpcUrls[network]
  );
  const networks = resolveNetworks(configuredNetworks);
  const runForever = process.env.INDEXER_RUN_FOREVER === "true";
  const intervalMs = parsePositiveInteger(process.env.INDEXER_SCAN_INTERVAL_MS, 30000);
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
    do {
      const report = await scanConfiguredEvmNetworks({
        networks,
        scanDeposits: (network) => applicationService.scanEvmDeposits({ network }),
        scanWithdrawals: (network) => applicationService.scanEvmWithdrawals({ network })
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

      if (!runForever) {
        if (report.failedCount > 0) {
          process.exitCode = 1;
        }
        return;
      }

      await sleep(intervalMs);
    } while (runForever);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
