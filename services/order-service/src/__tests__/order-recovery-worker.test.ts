import assert from "node:assert/strict";
import test from "node:test";

import { OrderRecoveryWorker } from "../application/order-recovery-worker.js";
import { OrderApplicationService } from "../application/order-application-service.js";
import type { SpotOrderRecoveryJob } from "../domain/types.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

function createService(
  repository: InMemoryOrderRepository,
  now = () => new Date("2026-03-09T10:00:00.000Z")
) {
  return new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        throw new Error("unused");
      }
    },
    {
      async freezeBalance() {
        return {};
      },
      async releaseBalance() {
        return {};
      }
    },
    {
      async settleTrade() {
        return {
          settlementId: "unused"
        };
      }
    },
    {
      async submitOrder() {
        throw new Error("unused");
      },
      async seedOrder() {
        return { outcome: "seeded", orderId: "unused" };
      },
      async cancelOrder() {
        return { outcome: "cancelled", orderId: "unused" };
      },
      async resetBook(command) {
        return { outcome: "reset", market: command.market };
      },
      async getBookSnapshot(command) {
        return { market: command.market, bids: [], asks: [] };
      }
    },
    {
      now,
      createId: (() => {
        let counter = 0;
        return () => `worker-test-${++counter}`;
      })()
    }
  );
}

test("recovery worker builds governance report with active and expired leases", async () => {
  const repository = new InMemoryOrderRepository();
  await seedRecoveryJob(repository, {
    jobId: "job-active",
    orderId: "order-active",
    market: "BTC-USDT",
    status: "processing",
    leaseOwner: "worker-a",
    leaseHeartbeatAt: "2026-03-09T09:59:55.000Z",
    leaseExpiresAt: "2026-03-09T10:00:20.000Z"
  });
  await seedRecoveryJob(repository, {
    jobId: "job-expired",
    orderId: "order-expired",
    market: "ETH-USDT",
    status: "processing",
    leaseOwner: "worker-b",
    leaseHeartbeatAt: "2026-03-09T09:58:00.000Z",
    leaseExpiresAt: "2026-03-09T09:59:00.000Z",
    lastError: "network timeout"
  });
  await seedRecoveryJob(repository, {
    jobId: "job-dead",
    orderId: "order-dead",
    market: "BTC-USDT",
    status: "failed",
    deadLetteredAt: "2026-03-09T09:57:00.000Z",
    lastError: "settlement unavailable"
  });

  const worker = new OrderRecoveryWorker(createService(repository), {
    now: () => new Date("2026-03-09T10:00:00.000Z")
  });
  const report = await worker.getGovernanceReport();

  assert.equal(report.activeWorkers.length, 2);
  assert.equal(report.expiredLeases.length, 1);
  assert.equal(report.expiredLeases[0]?.jobId, "job-expired");
  assert.equal(report.deadLetterBacklog.totalJobs, 1);
  assert.equal(report.deadLetterBacklog.byMarket[0]?.market, "BTC-USDT");
});

test("recovery worker builds dead-letter report and batch templates", async () => {
  const repository = new InMemoryOrderRepository();
  await seedRecoveryJob(repository, {
    jobId: "job-dead-1",
    orderId: "order-dead-1",
    market: "BTC-USDT",
    status: "failed",
    deadLetteredAt: "2026-03-09T09:57:00.000Z",
    lastError: "settlement unavailable"
  });
  await seedRecoveryJob(repository, {
    jobId: "job-dead-2",
    orderId: "order-dead-2",
    market: "BTC-USDT",
    status: "failed",
    deadLetteredAt: "2026-03-09T09:58:00.000Z",
    lastError: "settlement unavailable"
  });
  await seedRecoveryJob(repository, {
    jobId: "job-dead-3",
    orderId: "order-dead-3",
    market: "ETH-USDT",
    status: "failed",
    deadLetteredAt: "2026-03-09T09:59:00.000Z",
    lastError: "ledger unavailable"
  });

  const worker = new OrderRecoveryWorker(createService(repository));
  const report = await worker.getDeadLetterReport({
    limit: 10,
    templateLimit: 3
  });

  assert.equal(report.totalJobs, 3);
  assert.equal(report.entries[0]?.market, "BTC-USDT");
  assert.equal(report.entries[0]?.jobCount, 2);
  assert.equal(report.templates[0]?.endpoint, "/api/v1/orders/ops/dead-letter-jobs/requeue");
  assert.equal(report.templates.some((template) => template.payload.market === "BTC-USDT"), true);
});

async function seedRecoveryJob(
  repository: InMemoryOrderRepository,
  partial: Partial<SpotOrderRecoveryJob> &
    Pick<SpotOrderRecoveryJob, "jobId" | "orderId" | "market" | "status">
): Promise<void> {
  const now = "2026-03-09T09:55:00.000Z";
  await repository.saveRecoveryJob({
    jobId: partial.jobId,
    orderId: partial.orderId,
    market: partial.market,
    stage: partial.stage ?? "persist_matched_outcome",
    status: partial.status,
    payload: partial.payload ?? {},
    attemptCount: partial.attemptCount ?? 1,
    lastError: partial.lastError,
    nextAttemptAt: partial.nextAttemptAt ?? now,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    completedAt: partial.completedAt,
    leaseOwner: partial.leaseOwner,
    leaseExpiresAt: partial.leaseExpiresAt,
    lastClaimedAt: partial.lastClaimedAt,
    leaseHeartbeatAt: partial.leaseHeartbeatAt,
    deadLetteredAt: partial.deadLetteredAt,
    lastDurationMs: partial.lastDurationMs,
    lastResult: partial.lastResult
  });
}
