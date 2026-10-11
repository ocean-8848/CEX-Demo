import { OrderApplicationService } from "../application/order-application-service.js";
import { OrderRecoveryOrchestrator } from "../application/order-recovery-orchestrator.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { HttpRiskClient } from "../infrastructure/http-risk-client.js";
import { HttpSettlementClient } from "../infrastructure/http-settlement-client.js";
import { createOrderPool } from "../infrastructure/postgres.js";
import { PostgresOrderRepository } from "../infrastructure/postgres-order-repository.js";
import { TcpMatchingEngineClient } from "../infrastructure/tcp-matching-engine-client.js";

async function main(): Promise<void> {
  const pool = createOrderPool();

  try {
    const repository = new PostgresOrderRepository(pool, pool);
    const applicationService = new OrderApplicationService(
      repository,
      new HttpRiskClient(process.env.RISK_SERVICE_BASE_URL ?? "http://127.0.0.1:3008"),
      new HttpLedgerClient(process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001"),
      new HttpSettlementClient(process.env.SETTLEMENT_SERVICE_BASE_URL ?? "http://127.0.0.1:3010"),
      new TcpMatchingEngineClient(
        process.env.MATCHING_ENGINE_HOST ?? "127.0.0.1",
        Number(process.env.MATCHING_ENGINE_PORT ?? "3011")
      )
    );

    const orchestrator = new OrderRecoveryOrchestrator(applicationService, {
      pollIntervalMs: Number(process.env.ORDER_RECOVERY_POLL_INTERVAL_MS ?? "5000"),
      batchSize: Number(process.env.ORDER_RECOVERY_BATCH_SIZE ?? "20"),
      leaseRenewIntervalMs: Number(
        process.env.ORDER_RECOVERY_LEASE_RENEW_INTERVAL_MS ?? "5000"
      ),
      createWorkerId: () =>
        process.env.ORDER_RECOVERY_WORKER_ID ??
        `order-recovery:${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now()}`
    });

    process.stdout.write("order recovery orchestrator started\n");
    await orchestrator.runForever((summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
