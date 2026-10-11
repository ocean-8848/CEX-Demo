import {
  defaultCustodyAlertThresholds,
  type CustodyAlertThresholds
} from "../application/custody-ops.js";
import { createCustodyProviderStack } from "../infrastructure/custody-runtime-factory.js";
import { CustodyOpsReporter } from "../infrastructure/custody-ops-reporter.js";
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
  const { runtimeRegistry } = createCustodyProviderStack(process.env);
  const reporter = new CustodyOpsReporter(pool, runtimeRegistry);
  const defaults = defaultCustodyAlertThresholds();

  try {
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
    const report = await reporter.buildOpsReport({
      generatedAt: new Date().toISOString(),
      thresholds,
      schedules: [
        {
          workerName: "provider_healthcheck",
          enabled: process.env.CUSTODY_PROVIDER_HEALTHCHECK_ENABLED !== "false",
          intervalMs: parseNumber(process.env.CUSTODY_PROVIDER_HEALTHCHECK_INTERVAL_MS, 30_000),
          running: false
        },
        {
          workerName: "transfer_sync",
          enabled: process.env.CUSTODY_AUTO_SYNC_ENABLED !== "false",
          intervalMs: parseNumber(process.env.CUSTODY_SYNC_POLL_INTERVAL_MS, 5_000),
          running: false
        }
      ],
      windowHours: parseNumber(process.env.CUSTODY_REPORT_WINDOW_HOURS, 24)
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if (report.overview.status === "alert") {
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
