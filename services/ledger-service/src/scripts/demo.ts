import { LedgerApplicationService } from "../application/ledger-application-service.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const repository = new PostgresLedgerRepository(pool, pool);
  const service = new LedgerApplicationService(repository);

  const accountId = process.env.DEMO_ACCOUNT_ID ?? "00000000-0000-0000-0000-000000000001";
  const platformAccountId =
    process.env.DEMO_PLATFORM_ACCOUNT_ID ?? "00000000-0000-0000-0000-000000000099";
  const treasuryAccountId =
    process.env.DEMO_TREASURY_ACCOUNT_ID ?? "00000000-0000-0000-0000-000000000098";

  try {
    await service.createAccount({
      accountId,
      accountType: "spot"
    });

    await service.createAccount({
      accountId: platformAccountId,
      accountType: "hot_wallet"
    });

    await service.createAccount({
      accountId: treasuryAccountId,
      accountType: "funding"
    });

    await repository.saveBalance({
      accountId: treasuryAccountId,
      assetCode: "USDT",
      available: "1000000",
      locked: "0",
      version: 1,
      updatedAt: new Date().toISOString()
    });

    await service.postJournal({
      businessType: "demo_seed",
      businessId: "seed_001",
      idempotencyKey: "seed_001",
      traceId: "trace_seed_001",
      entries: [
        {
          accountId: treasuryAccountId,
          assetCode: "USDT",
          direction: "debit",
          amount: "1000",
          referenceType: "demo_seed",
          referenceId: "seed_001"
        },
        {
          accountId,
          assetCode: "USDT",
          direction: "credit",
          amount: "1000",
          referenceType: "demo_seed",
          referenceId: "seed_001"
        }
      ]
    });

    const balance = await service.getBalance(accountId, "USDT");
    process.stdout.write(`${JSON.stringify(balance, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
