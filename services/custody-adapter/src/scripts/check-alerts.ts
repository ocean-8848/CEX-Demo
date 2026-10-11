import {
  defaultCustodyAlertThresholds,
  type CustodyAlertThresholds
} from "../application/custody-ops.js";
import { CustodyProviderHealthWorker } from "../application/custody-provider-health-worker.js";
import { CustodyOpsReporter } from "../infrastructure/custody-ops-reporter.js";
import { createCustodyProviderStack } from "../infrastructure/custody-runtime-factory.js";
import { createCustodyPool } from "../infrastructure/postgres.js";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const pool = createCustodyPool();
  const { providerResolver, runtimeRegistry } = createCustodyProviderStack(process.env);
  const healthWorker = new CustodyProviderHealthWorker(providerResolver, runtimeRegistry);
  const reporter = new CustodyOpsReporter(pool, runtimeRegistry);
  const defaults = defaultCustodyAlertThresholds();

  try {
    await healthWorker.runOnce();

    const thresholds: CustodyAlertThresholds = {
      maxPendingSyncCount: parseNumber(
        process.env.CUSTODY_ALERT_MAX_PENDING_SYNC_COUNT,
        defaults.maxPendingSyncCount
      ),
      maxRetryableCount: parseNumber(
        process.env.CUSTODY_ALERT_MAX_RETRYABLE_COUNT,
        defaults.maxRetryableCount
      ),
      maxFailedCount: parseNumber(
        process.env.CUSTODY_ALERT_MAX_FAILED_COUNT,
        defaults.maxFailedCount
      ),
      maxOldestPendingSyncAgeSeconds: parseNumber(
        process.env.CUSTODY_ALERT_MAX_OLDEST_PENDING_SYNC_AGE_SECONDS,
        defaults.maxOldestPendingSyncAgeSeconds
      ),
      maxOpenCircuitCount: parseNumber(
        process.env.CUSTODY_ALERT_MAX_OPEN_CIRCUIT_COUNT,
        defaults.maxOpenCircuitCount
      ),
      maxUnhealthyRouteCount: parseNumber(
        process.env.CUSTODY_ALERT_MAX_UNHEALTHY_ROUTE_COUNT,
        defaults.maxUnhealthyRouteCount
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
