import {
  defaultIndexerAlertThresholds,
  type IndexerAlertThresholds
} from "../application/indexer-ops.js";
import { EvmRpcClient } from "../infrastructure/evm-rpc-client.js";
import { loadEvmScanConfigFromEnv } from "../infrastructure/evm-scan-config.js";
import { IndexerOpsReporter } from "../infrastructure/indexer-ops-reporter.js";
import { createBlockchainIndexerPool } from "../infrastructure/postgres.js";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const pool = createBlockchainIndexerPool();
  const evmScanConfig = loadEvmScanConfigFromEnv();
  const defaults = defaultIndexerAlertThresholds();
  const reporter = new IndexerOpsReporter(
    pool,
    ({ rpcUrl }) => new EvmRpcClient(rpcUrl),
    evmScanConfig.rpcUrls
  );

  try {
    const thresholds: IndexerAlertThresholds = {
      maxPendingDeposits: parseNumber(
        process.env.INDEXER_ALERT_MAX_PENDING_DEPOSITS,
        defaults.maxPendingDeposits
      ),
      maxPendingWithdrawals: parseNumber(
        process.env.INDEXER_ALERT_MAX_PENDING_WITHDRAWALS,
        defaults.maxPendingWithdrawals
      ),
      maxOldestPendingDepositAgeSeconds: parseNumber(
        process.env.INDEXER_ALERT_MAX_OLDEST_PENDING_DEPOSIT_AGE_SECONDS,
        defaults.maxOldestPendingDepositAgeSeconds
      ),
      maxOldestPendingWithdrawalAgeSeconds: parseNumber(
        process.env.INDEXER_ALERT_MAX_OLDEST_PENDING_WITHDRAWAL_AGE_SECONDS,
        defaults.maxOldestPendingWithdrawalAgeSeconds
      ),
      maxScanLagBlocks: parseNumber(
        process.env.INDEXER_ALERT_MAX_SCAN_LAG_BLOCKS,
        defaults.maxScanLagBlocks
      ),
      maxStaleCursorAgeSeconds: parseNumber(
        process.env.INDEXER_ALERT_MAX_STALE_CURSOR_AGE_SECONDS,
        defaults.maxStaleCursorAgeSeconds
      ),
      maxReorgCursors: parseNumber(
        process.env.INDEXER_ALERT_MAX_REORG_CURSORS,
        defaults.maxReorgCursors
      )
    };

    const overview = await reporter.buildOpsOverview({
      generatedAt: new Date().toISOString(),
      thresholds
    });
    process.stdout.write(`${JSON.stringify(overview, null, 2)}\n`);

    if (overview.status === "alert") {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
