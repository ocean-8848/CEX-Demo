import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const reporter = new LedgerOpsReporter(pool);
  const staleLockMinutes = parseNumber(process.env.LEDGER_ALERT_STALE_LOCK_MINUTES, 30);

  try {
    const overview = await reporter.buildOpsOverview({
      generatedAt: new Date().toISOString(),
      staleLockMinutes,
      thresholds: {
        maxPendingOutbox: parseNumber(process.env.LEDGER_ALERT_MAX_PENDING_OUTBOX, 100),
        maxRetryingOutbox: parseNumber(process.env.LEDGER_ALERT_MAX_RETRYING_OUTBOX, 20),
        maxDeadLetteredOutbox: parseNumber(
          process.env.LEDGER_ALERT_MAX_DEAD_LETTERED_OUTBOX,
          0
        ),
        maxOldestPendingOutboxAgeSeconds: parseNumber(
          process.env.LEDGER_ALERT_MAX_OLDEST_PENDING_OUTBOX_AGE_SECONDS,
          300
        ),
        maxStaleLocks: parseNumber(process.env.LEDGER_ALERT_MAX_STALE_LOCKS, 0),
        maxBalanceMismatches: parseNumber(
          process.env.LEDGER_ALERT_MAX_BALANCE_MISMATCHES,
          0
        ),
        maxNegativeAvailableBalances: parseNumber(
          process.env.LEDGER_ALERT_MAX_NEGATIVE_AVAILABLE_BALANCES,
          0
        ),
        maxNegativeLockedBalances: parseNumber(
          process.env.LEDGER_ALERT_MAX_NEGATIVE_LOCKED_BALANCES,
          0
        )
      }
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
