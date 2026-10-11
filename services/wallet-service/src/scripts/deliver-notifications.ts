import { WalletNotificationDispatcher } from "../application/wallet-notification-dispatcher.js";
import { ConsoleWalletNotificationTransport } from "../infrastructure/console-wallet-notification-transport.js";
import { createWalletPool } from "../infrastructure/postgres.js";
import { PostgresWalletRepository } from "../infrastructure/postgres-wallet-repository.js";

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
  const dispatcher = new WalletNotificationDispatcher(
    repository,
    new ConsoleWalletNotificationTransport(),
    {
      batchSize: parseNumber(process.env.WALLET_NOTIFICATION_BATCH_SIZE, 100),
      maxAttempts: parseNumber(process.env.WALLET_NOTIFICATION_MAX_ATTEMPTS, 5),
      retryDelayMs: parseNumber(process.env.WALLET_NOTIFICATION_RETRY_DELAY_MS, 5000)
    }
  );
  const runForever = process.env.WALLET_NOTIFICATION_RUN_FOREVER === "true";
  const pollIntervalMs = parseNumber(process.env.WALLET_NOTIFICATION_POLL_INTERVAL_MS, 1000);

  try {
    do {
      const result = await dispatcher.deliverPending();
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
