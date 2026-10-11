import { CustodyApplicationService } from "../application/custody-application-service.js";
import { CustodyTransferSyncWorker } from "../application/custody-transfer-sync-worker.js";
import { createCustodyProviderStack } from "../infrastructure/custody-runtime-factory.js";
import { createCustodyPool } from "../infrastructure/postgres.js";
import { PostgresCustodyRepository } from "../infrastructure/postgres-custody-repository.js";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const pool = createCustodyPool();
  const repository = new PostgresCustodyRepository(pool, pool);
  const { providerResolver, runtimeRegistry } = createCustodyProviderStack(process.env);
  const applicationService = new CustodyApplicationService(repository, providerResolver, {
    maxBroadcastAttempts: parseNumber(process.env.CUSTODY_MAX_BROADCAST_ATTEMPTS, 3),
    retryDelayMs: parseNumber(process.env.CUSTODY_RETRY_DELAY_MS, 60_000),
    runtimeRegistry
  });
  const worker = new CustodyTransferSyncWorker(repository, applicationService, {
    batchSize: parseNumber(process.env.CUSTODY_SYNC_BATCH_SIZE, 100),
    syncIntervalMs: parseNumber(process.env.CUSTODY_SYNC_INTERVAL_MS, 30_000)
  });
  const runForever = process.env.CUSTODY_SYNC_RUN_FOREVER === "true";
  const pollIntervalMs = parseNumber(process.env.CUSTODY_SYNC_POLL_INTERVAL_MS, 1000);

  try {
    do {
      const result = await worker.runOnce();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

      if (!runForever) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } while (true);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
