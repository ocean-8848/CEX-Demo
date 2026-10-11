import { LedgerAlertRemediator } from "../application/ledger-alert-remediator.js";
import { KafkaLedgerOutboxTransport } from "../infrastructure/kafka-ledger-outbox-transport.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
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
  const remediator = new LedgerAlertRemediator(repository, transport, {
    batchSize: parseNumber(process.env.LEDGER_OUTBOX_BATCH_SIZE, 100),
    maxAttempts: parseNumber(process.env.LEDGER_OUTBOX_MAX_ATTEMPTS, 5),
    retryDelayMs: parseNumber(process.env.LEDGER_OUTBOX_RETRY_DELAY_MS, 5000)
  });
  const requeueDeadLetter = process.env.LEDGER_OUTBOX_REQUEUE_DEAD_LETTER !== "false";
  const maxCycles = parseNumber(process.env.LEDGER_OUTBOX_DRAIN_MAX_CYCLES, 10);

  try {
    const result = await remediator.drainOutboxAlerts({
      requeueDeadLetter,
      maxCycles
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await transport.disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
