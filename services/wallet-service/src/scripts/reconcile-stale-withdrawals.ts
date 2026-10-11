import { WalletApplicationService } from "../application/wallet-application-service.js";
import { WalletOpsService } from "../application/wallet-ops-service.js";
import { WalletNotificationDispatcher } from "../application/wallet-notification-dispatcher.js";
import { ConsoleWalletNotificationTransport } from "../infrastructure/console-wallet-notification-transport.js";
import { HttpCustodyClient } from "../infrastructure/http-custody-client.js";
import { HttpIdentityClient } from "../infrastructure/http-identity-client.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { createWalletPool } from "../infrastructure/postgres.js";
import { PostgresWalletRepository } from "../infrastructure/postgres-wallet-repository.js";
import { loadWithdrawalValidationRulesFromEnv } from "../infrastructure/withdrawal-validation-rules.js";

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const pool = createWalletPool();
  const repository = new PostgresWalletRepository(pool, pool);
  const walletService = new WalletApplicationService(
    repository,
    new HttpLedgerClient(
      process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001",
      process.env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
        "00000000-0000-0000-0000-000000000098",
      process.env.LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID ??
        process.env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
        "00000000-0000-0000-0000-000000000098"
    ),
    new HttpCustodyClient(process.env.CUSTODY_ADAPTER_BASE_URL ?? "http://127.0.0.1:3004"),
    {
      depositConfirmationThreshold: parseNumber(
        process.env.DEPOSIT_CONFIRMATION_THRESHOLD,
        12
      ),
      withdrawalConfirmationThreshold: parseNumber(
        process.env.WITHDRAWAL_CONFIRMATION_THRESHOLD,
        12
      ),
      withdrawalValidationRules: loadWithdrawalValidationRulesFromEnv()
    },
    new HttpIdentityClient(process.env.IDENTITY_SERVICE_BASE_URL ?? "http://127.0.0.1:3005")
  );
  const opsService = new WalletOpsService(
    walletService,
    new WalletNotificationDispatcher(
      repository,
      new ConsoleWalletNotificationTransport(),
      {
        batchSize: parseNumber(process.env.WALLET_NOTIFICATION_BATCH_SIZE, 100),
        maxAttempts: parseNumber(process.env.WALLET_NOTIFICATION_MAX_ATTEMPTS, 5),
        retryDelayMs: parseNumber(process.env.WALLET_NOTIFICATION_RETRY_DELAY_MS, 5000)
      }
    )
  );

  try {
    const result = await opsService.reconcileStaleWithdrawals({
      staleMinutes: parseNumber(process.env.WALLET_STALE_WITHDRAWAL_MINUTES, 30),
      rebroadcastAutoConfirm: process.env.WALLET_STALE_REBROADCAST_AUTO_CONFIRM === "true",
      forceConfirmations: parseNumber(
        process.env.WALLET_STALE_BROADCAST_CONFIRMATIONS,
        0
      ),
      forceBlockNumber: parseNumber(process.env.WALLET_STALE_BROADCAST_BLOCK_NUMBER, 0),
      pageSize: parseNumber(process.env.WALLET_STALE_WITHDRAWAL_BATCH_SIZE, 100),
      operatorId: process.env.WALLET_STALE_WITHDRAWAL_OPERATOR_ID ?? "system:stale-cleanup"
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
