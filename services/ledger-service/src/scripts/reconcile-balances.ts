import type { AssetCode } from "@web3-cex/domain";

import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const reporter = new LedgerOpsReporter(pool);
  const generatedAt = new Date().toISOString();

  try {
    const report = await reporter.reconcileBalances({
      accountId: process.env.LEDGER_RECONCILE_ACCOUNT_ID,
      assetCode: process.env.LEDGER_RECONCILE_ASSET_CODE as AssetCode | undefined,
      includeMatched: process.env.LEDGER_RECONCILE_INCLUDE_MATCHED === "true",
      generatedAt
    });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if (
      (process.env.LEDGER_RECONCILE_FAIL_ON_MISMATCH ?? "true") === "true" &&
      report.mismatchCount > 0
    ) {
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
