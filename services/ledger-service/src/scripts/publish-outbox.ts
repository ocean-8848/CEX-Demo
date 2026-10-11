import { LedgerOutboxPublisher } from "../application/ledger-outbox-publisher.js";
import { KafkaLedgerOutboxTransport } from "../infrastructure/kafka-ledger-outbox-transport.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const repository = new PostgresLedgerRepository(pool, pool);
  const transport = new KafkaLedgerOutboxTransport({
    brokers: (process.env.KAFKA_BROKERS ?? "127.0.0.1:9092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean),
    clientId: process.env.LEDGER_OUTBOX_CLIENT_ID ?? "ledger-outbox-publisher",
    topic: process.env.LEDGER_OUTBOX_TOPIC ?? "ledger.events",
    deadLetterTopic: process.env.LEDGER_OUTBOX_DEAD_LETTER_TOPIC ?? "dead-letter.events"
  });
  const publisher = new LedgerOutboxPublisher(repository, transport, {
    batchSize: Number(process.env.LEDGER_OUTBOX_BATCH_SIZE ?? "100"),
    maxAttempts: Number(process.env.LEDGER_OUTBOX_MAX_ATTEMPTS ?? "5"),
    retryDelayMs: Number(process.env.LEDGER_OUTBOX_RETRY_DELAY_MS ?? "5000")
  });
  const runForever = process.env.LEDGER_OUTBOX_RUN_FOREVER === "true";
  const pollIntervalMs = Number(process.env.LEDGER_OUTBOX_POLL_INTERVAL_MS ?? "1000");

  try {
    let totalPublished = 0;

    do {
      const result = await publisher.publishPending();
      totalPublished += result.publishedCount;

      if (!runForever) {
        process.stdout.write(
          `Published ${result.publishedCount} outbox event(s), failed ${result.failedCount}, dead-lettered ${result.deadLetteredCount}\n`
        );
        break;
      }

      if (result.publishedCount === 0) {
        await sleep(pollIntervalMs);
      }
    } while (runForever);

    if (runForever) {
      process.stdout.write(`Publisher stopped after sending ${totalPublished} event(s)\n`);
    }
  } finally {
    await transport.disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
