import type { AssetCode } from "@web3-cex/domain";

import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const accountId = process.env.LEDGER_REPLAY_ACCOUNT_ID;
  const assetCode = process.env.LEDGER_REPLAY_ASSET_CODE as AssetCode | undefined;

  if (!accountId || !assetCode) {
    throw new Error(
      "LEDGER_REPLAY_ACCOUNT_ID and LEDGER_REPLAY_ASSET_CODE are required"
    );
  }

  const pool = createLedgerPool();
  const reporter = new LedgerOpsReporter(pool);

  try {
    const report = await reporter.replayAccount({
      accountId,
      assetCode,
      generatedAt: new Date().toISOString()
    });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if ((process.env.LEDGER_REPLAY_FAIL_ON_MISMATCH ?? "false") === "true" && report.mismatch) {
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
