import assert from "node:assert/strict";
import test from "node:test";

import { SettlementApplicationService } from "../application/settlement-application-service.js";
import { SettlementRecoveryWorker } from "../application/settlement-recovery-worker.js";
import type { SettlementRecoveryJob, SettleTradeCommand } from "../domain/types.js";
import { InMemorySettlementRepository } from "../infrastructure/in-memory-settlement-repository.js";

function createService(
  repository: InMemorySettlementRepository,
  now = () => new Date("2026-03-09T10:00:00.000Z")
) {
  return new SettlementApplicationService(
    repository,
    {
      async getAccount(accountId) {
        return {
          accountId,
          userId: "platform",
          accountType: "spot",
          status: "active"
        };
      },
      async createAccount(command) {
        return {
          accountId: command.accountId,
          userId: command.userId,
          accountType: command.accountType,
          status: "active"
        };
      },
      async consumeBalance() {
        return {};
      },
      async postJournal(command) {
        return {
          journalId: `${command.businessType}:${command.businessId}`
        };
      }
    },
    {
      now,
      createId: (() => {
        let counter = 0;
        return () => `settlement-worker-test-${++counter}`;
      })()
    }
  );
}

test("settlement recovery worker builds governance report with active and expired leases", async () => {
  const repository = new InMemorySettlementRepository();
  await seedRecoveryJob(repository, {
    jobId: "job-active",
    tradeId: "trade-active",
    market: "BTC-USDT",
    status: "processing",
    leaseOwner: "worker-a",
    leaseHeartbeatAt: "2026-03-09T09:59:55.000Z",
    leaseExpiresAt: "2026-03-09T10:00:20.000Z"
  });
  await seedRecoveryJob(repository, {
    jobId: "job-expired",
    tradeId: "trade-expired",
    market: "ETH-USDT",
    status: "processing",
    leaseOwner: "worker-b",
    leaseHeartbeatAt: "2026-03-09T09:58:00.000Z",
    leaseExpiresAt: "2026-03-09T09:59:00.000Z",
    lastError: "ledger timeout"
  });

  const worker = new SettlementRecoveryWorker(createService(repository), {
    now: () => new Date("2026-03-09T10:00:00.000Z")
  });
  const report = await worker.getGovernanceReport();

  assert.equal(report.activeWorkers.length, 2);
  assert.equal(report.expiredLeases.length, 1);
  assert.equal(report.expiredLeases[0]?.tradeId, "trade-expired");
});

test("settlement recovery worker records cycle execution history", async () => {
  const repository = new InMemorySettlementRepository();
  await seedRecoveryJob(repository, {
    jobId: "job-pending",
    tradeId: "trade-pending",
    market: "BTC-USDT",
    status: "pending",
    payload: {
      command: createRecoveryCommand("trade-pending", "BTC-USDT")
    }
  });

  const service = createService(repository, () => new Date("2026-03-09T10:05:00.000Z"));
  const worker = new SettlementRecoveryWorker(service, {
    now: () => new Date("2026-03-09T10:05:00.000Z"),
    createWorkerId: () => "settlement-worker-1"
  });

  const summary = await worker.runOnce(10, "manual");
  const history = await service.listAutomationExecutions({
    executionType: "recovery_cycle",
    limit: 10,
    offset: 0
  });

  assert.equal(summary.completedCount, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.trigger, "manual");
});

function createRecoveryCommand(
  tradeId: string,
  market: SettleTradeCommand["market"]
): SettleTradeCommand {
  return {
    tradeId,
    market,
    price: "65000",
    quantity: "0.01",
    buyerOrderId: `${tradeId}:buy`,
    sellerOrderId: `${tradeId}:sell`,
    buyerUserId: "buyer-1",
    sellerUserId: "seller-1",
    buyerAccountId: "acct-buyer",
    sellerAccountId: "acct-seller",
    sellerFeeRate: "0.001",
    executionId: `${tradeId}:execution`,
    executionBatchId: `${market}:${tradeId}:batch`,
    executionSequence: 1,
    executionBatchSequence: 1,
    replayCursor: `${market}:1`,
    protocolVersion: "v2"
  };
}

async function seedRecoveryJob(
  repository: InMemorySettlementRepository,
  partial: Partial<SettlementRecoveryJob> &
    Pick<SettlementRecoveryJob, "jobId" | "tradeId" | "market" | "status">
): Promise<void> {
  const now = "2026-03-09T09:55:00.000Z";
  await repository.saveRecoveryJob({
    jobId: partial.jobId,
    tradeId: partial.tradeId,
    market: partial.market,
    stage: partial.stage ?? "settle_trade",
    status: partial.status,
    payload: partial.payload ?? {
      command: createRecoveryCommand(partial.tradeId, partial.market)
    },
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
    lastDurationMs: partial.lastDurationMs,
    lastResult: partial.lastResult
  });
}
