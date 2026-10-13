import assert from "node:assert/strict";
import test from "node:test";
import type { TradingEvent } from "@web3-cex/domain";

import { SettlementServiceError } from "../domain/errors.js";
import { SettlementApplicationService } from "../application/settlement-application-service.js";
import { InMemorySettlementRepository } from "../infrastructure/in-memory-settlement-repository.js";

const baseCommand = {
  tradeId: "trade-1",
  market: "BTC-USDT" as const,
  price: "65000",
  quantity: "0.01",
  buyerOrderId: "buy-1",
  sellerOrderId: "sell-1",
  buyerUserId: "buyer-1",
  sellerUserId: "seller-1",
  buyerAccountId: "acct-buyer",
  sellerAccountId: "acct-seller",
  sellerFeeRate: "0.001"
};

function createTradeExecutedEvent(
  tradeId: string,
  executionSequence: number
): TradingEvent {
  return {
    eventId: `exec-${executionSequence.toString()}`,
    eventType: "trade.executed",
    aggregateType: "spot_trade",
    aggregateId: tradeId,
    traceId: `execution:exec-${executionSequence.toString()}`,
    occurredAt: `2026-03-08T10:00:0${executionSequence.toString()}.000Z`,
    schemaId: "trade.executed",
    schemaVersion: 2,
    payload: {
      market: "BTC-USDT",
      userIds: ["buyer-1", "seller-1"],
      trade: {
        tradeId,
        market: "BTC-USDT",
        price: "65000",
        quantity: "0.01",
        makerOrderId: "sell-1",
        takerOrderId: "buy-1",
        buyerOrderId: "buy-1",
        sellerOrderId: "sell-1",
        buyerUserId: "buyer-1",
        sellerUserId: "seller-1",
        buyerAccountId: "acct-buyer",
        sellerAccountId: "acct-seller",
        sellerFeeRate: "0.001",
        executedAt: `2026-03-08T10:00:0${executionSequence.toString()}.000Z`,
        executionId: `exec-${executionSequence.toString()}`,
        executionBatchId: "BTC-USDT:batch-1",
        executionSequence,
        executionBatchSequence: executionSequence,
        replayCursor: `BTC-USDT:${executionSequence.toString()}`,
        protocolVersion: "v2"
      }
    }
  };
}

test("settleTrade consumes locks and stores settled record idempotently", async () => {
  const events: string[] = [];
  const service = new SettlementApplicationService(
    new InMemorySettlementRepository(),
    {
      async getAccount() {
        return null;
      },
      async createAccount(command) {
        return {
          accountId: command.accountId,
          userId: command.userId,
          accountType: command.accountType,
          status: "active"
        };
      },
      async consumeBalance(command) {
        events.push(`consume:${command.accountId}:${command.assetCode}:${command.referenceId}`);
        return {};
      },
      async postJournal(command) {
        events.push(`journal:${command.businessType}`);
        return {
          journalId: `${command.businessType}-journal`
        };
      }
    },
    {
      now: () => new Date("2026-03-08T10:00:00.000Z"),
      createId: () => "settlement-1"
    }
  );

  const first = await service.settleTrade(baseCommand);
  const second = await service.settleTrade(baseCommand);

  assert.equal(first.quoteAmount, "650");
  assert.equal(first.feeAmount, "0.65");
  assert.equal(first.status, "settled");
  assert.equal(first.attemptCount, 1);
  assert.equal(second.settlementId, "settlement-1");
  assert.equal(events.length, 4);
});

test("settleTrade normalizes floating precision noise before consuming locks", async () => {
  const consumeCalls: Array<{ accountId: string; amount: string; assetCode: string }> = [];
  const service = new SettlementApplicationService(
    new InMemorySettlementRepository(),
    {
      async getAccount(accountId) {
        return {
          accountId,
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
      async consumeBalance(command) {
        consumeCalls.push({
          accountId: command.accountId,
          amount: command.amount,
          assetCode: command.assetCode
        });
        return {};
      },
      async postJournal(command) {
        return {
          journalId: `${command.businessType}:${command.businessId}`
        };
      }
    },
    {
      now: () => new Date("2026-03-08T10:00:00.000Z"),
      createId: () => "settlement-precision"
    }
  );

  const settlement = await service.settleTrade({
    ...baseCommand,
    market: "ETH-USDT",
    price: "3200.00",
    quantity: "0.050000000000000003"
  });

  assert.equal(settlement.quantity, "0.05");
  assert.equal(settlement.price, "3200");
  assert.equal(settlement.quoteAmount, "160");
  assert.deepEqual(consumeCalls, [
    {
      accountId: "acct-seller",
      amount: "0.05",
      assetCode: "ETH"
    },
    {
      accountId: "acct-buyer",
      amount: "160",
      assetCode: "USDT"
    }
  ]);
});

test("settleTrade queues recovery and manual recover settles later", async () => {
  const repository = new InMemorySettlementRepository();
  let shouldFail = true;

  const service = new SettlementApplicationService(
    repository,
    {
      async getAccount(command) {
        return {
          accountId: command,
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
        if (shouldFail) {
          throw new Error("ledger unavailable");
        }
        return {};
      },
      async postJournal(command) {
        return {
          journalId: `${command.businessType}:${command.businessId}`
        };
      }
    },
    {
      now: () => new Date("2026-03-08T10:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `settlement-${++counter}`;
      })(),
      recoveryDelayMs: 1_000,
      recoveryMaxAttempts: 3
    }
  );

  await assert.rejects(service.settleTrade(baseCommand), (error: unknown) => {
    assert.ok(error instanceof SettlementServiceError);
    assert.equal(error.code, "SETTLEMENT_RECOVERY_PENDING");
    return true;
  });

  const failedSettlement = (await service.listSettlements({}))[0];
  const recoveryJob = (await service.listRecoveryJobs({ status: "pending" }))[0];

  assert.equal(failedSettlement?.status, "pending_recovery");
  assert.equal(failedSettlement?.attemptCount, 1);
  assert.equal(recoveryJob?.attemptCount, 1);

  shouldFail = false;
  const recovered = await service.recoverTrade(baseCommand.tradeId);

  assert.equal(recovered.status, "settled");
  assert.equal(recovered.attemptCount, 2);

  const completedJob = (await service.listRecoveryJobs({ tradeId: baseCommand.tradeId }))[0];
  assert.equal(completedJob?.status, "completed");
});

test("processRecoveryJobs drives terminal failure after max attempts", async () => {
  const repository = new InMemorySettlementRepository();
  const service = new SettlementApplicationService(
    repository,
    {
      async getAccount(command) {
        return {
          accountId: command,
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
        throw new Error("persistent ledger outage");
      },
      async postJournal() {
        return {
          journalId: "unused"
        };
      }
    },
    {
      now: (() => {
        let offset = 0;
        return () => new Date(Date.parse("2026-03-08T10:00:00.000Z") + offset++ * 10_000);
      })(),
      createId: (() => {
        let counter = 0;
        return () => `settlement-${++counter}`;
      })(),
      recoveryDelayMs: 0,
      recoveryMaxAttempts: 2
    }
  );

  await assert.rejects(service.settleTrade(baseCommand), (error: unknown) => {
    assert.ok(error instanceof SettlementServiceError);
    assert.equal(error.code, "SETTLEMENT_RECOVERY_PENDING");
    return true;
  });
  const firstPass = await service.processRecoveryJobs(10);

  assert.equal(firstPass.processedCount, 1);
  assert.equal(firstPass.failedCount, 1);

  const settlement = (await service.listSettlements({}))[0];
  const job = (await service.listRecoveryJobs({ tradeId: baseCommand.tradeId }))[0];

  assert.equal(settlement?.status, "failed");
  assert.equal(settlement?.attemptCount, 2);
  assert.equal(job?.status, "failed");
  assert.equal(job?.attemptCount, 2);
});

test("trade event replay checkpoints advance monotonically and skip duplicates", async () => {
  const repository = new InMemorySettlementRepository();
  const service = new SettlementApplicationService(
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
      now: (() => {
        let offset = 0;
        return () => new Date(Date.parse("2026-03-08T10:10:00.000Z") + offset++ * 1000);
      })(),
      createId: (() => {
        let counter = 0;
        return () => `settlement-${++counter}`;
      })()
    }
  );

  const firstReplay = await service.replayTradeExecutionEvents({
    consumerId: "trade-settlement",
    events: [createTradeExecutedEvent("trade-2", 2), createTradeExecutedEvent("trade-1", 1)]
  });
  const duplicateReplay = await service.replayTradeExecutionEvents({
    consumerId: "trade-settlement",
    events: [createTradeExecutedEvent("trade-1", 1), createTradeExecutedEvent("trade-2", 2)]
  });
  const checkpoints = await service.listTradeEventConsumerCheckpoints({
    consumerId: "trade-settlement",
    market: "BTC-USDT"
  });

  assert.equal(firstReplay.appliedCount, 2);
  assert.equal(firstReplay.duplicateCount, 0);
  assert.equal(duplicateReplay.appliedCount, 0);
  assert.equal(duplicateReplay.duplicateCount, 2);
  assert.equal(checkpoints[0]?.lastExecutionSequence, 2);
  assert.equal(checkpoints[0]?.lastReplayCursor, "BTC-USDT:2");

  const streamApplied = await service.consumeTradeExecutionEvent({
    consumerId: "trade-settlement-stream",
    event: createTradeExecutedEvent("trade-1-stream", 1),
    streamEntryId: "1741506000000-1",
    streamPublishedAt: "2026-03-08T10:10:00.050Z"
  });
  const streamCheckpoint = (
    await service.listTradeEventConsumerCheckpoints({
      consumerId: "trade-settlement-stream",
      market: "BTC-USDT"
    })
  )[0];

  assert.equal(streamApplied.streamEntryId, "1741506000000-1");
  assert.equal(streamCheckpoint?.lastStreamEntryId, "1741506000000-1");
  assert.equal(streamCheckpoint?.lastStreamPublishedAt, "2026-03-08T10:10:00.050Z");
});

test("trade event replay rejects sequence gaps unless explicitly allowed", async () => {
  const repository = new InMemorySettlementRepository();
  const service = new SettlementApplicationService(
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
      now: () => new Date("2026-03-08T10:20:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `settlement-gap-${++counter}`;
      })()
    }
  );

  await service.consumeTradeExecutionEvent({
    consumerId: "trade-settlement",
    event: createTradeExecutedEvent("trade-gap-1", 1)
  });

  await assert.rejects(
    service.consumeTradeExecutionEvent({
      consumerId: "trade-settlement",
      event: createTradeExecutedEvent("trade-gap-3", 3)
    }),
    (error: unknown) => {
      assert.ok(error instanceof SettlementServiceError);
      assert.equal(error.code, "SETTLEMENT_EVENT_SEQUENCE_GAP");
      return true;
    }
  );
});

test("trade event consumer defers a failing trade to recovery and keeps consuming", async () => {
  const repository = new InMemorySettlementRepository();
  const failingTradeIds = new Set(["trade-poison-1"]);
  const service = new SettlementApplicationService(
    repository,
    {
      async getAccount(accountId) {
        return { accountId, userId: "platform", accountType: "spot", status: "active" };
      },
      async createAccount(command) {
        return {
          accountId: command.accountId,
          userId: command.userId,
          accountType: command.accountType,
          status: "active"
        };
      },
      async consumeBalance(command) {
        if ([...failingTradeIds].some((tradeId) => command.businessId?.includes(tradeId))) {
          throw new Error("Balance lock is released and cannot be settled");
        }
        return {};
      },
      async postJournal(command) {
        return { journalId: `${command.businessType}:${command.businessId}` };
      }
    },
    {
      now: () => new Date("2026-03-08T10:30:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `settlement-defer-${++counter}`;
      })()
    }
  );

  const deferred = await service.consumeTradeExecutionEvent({
    consumerId: "trade-settlement",
    event: createTradeExecutedEvent("trade-poison-1", 1)
  });
  const next = await service.consumeTradeExecutionEvent({
    consumerId: "trade-settlement",
    event: createTradeExecutedEvent("trade-healthy-2", 2)
  });

  assert.equal(deferred.action, "deferred");
  assert.match(deferred.error ?? "", /lock is released/);
  assert.equal(next.action, "applied");
  assert.equal(next.checkpoint.lastExecutionSequence, 2);

  const recoveryJob = (await service.listRecoveryJobs({ tradeId: "trade-poison-1" }))[0];
  assert.equal(recoveryJob?.status, "pending");
});

test("getSettlementReport aggregates status and totals", async () => {
  const repository = new InMemorySettlementRepository();
  const service = new SettlementApplicationService(
    repository,
    {
      async getAccount(command) {
        return {
          accountId: command,
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
      now: () => new Date("2026-03-08T10:00:00.000Z"),
      createId: () => "settlement-report"
    }
  );

  await repository.saveSettlement({
    settlementId: "settlement-settled",
    tradeId: "trade-report-1",
    market: "BTC-USDT",
    price: "65000",
    quantity: "0.01",
    quoteAmount: "650",
    feeAmount: "0.65",
    buyerFeeAmount: "0",
    buyerOrderId: "buy-1",
    sellerOrderId: "sell-1",
    buyerUserId: "buyer-1",
    sellerUserId: "seller-1",
    buyerAccountId: "acct-buyer-1",
    sellerAccountId: "acct-seller-1",
    buyerSettlementJournalId: "base-journal-1",
    sellerSettlementJournalId: "quote-journal-1",
    status: "settled",
    attemptCount: 1,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:01.000Z",
    lastAttemptAt: "2026-03-08T10:00:01.000Z",
    settledAt: "2026-03-08T10:00:01.000Z"
  });

  await repository.saveSettlement({
    settlementId: "settlement-pending",
    tradeId: "trade-report-2",
    market: "BTC-USDT",
    price: "65000",
    quantity: "0.02",
    quoteAmount: "1300",
    feeAmount: "1.3",
    buyerFeeAmount: "0",
    buyerOrderId: "buy-2",
    sellerOrderId: "sell-2",
    buyerUserId: "buyer-2",
    sellerUserId: "seller-2",
    buyerAccountId: "acct-buyer-2",
    sellerAccountId: "acct-seller-2",
    status: "pending_recovery",
    attemptCount: 1,
    lastError: "temporary outage",
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:01:00.000Z",
    lastAttemptAt: "2026-03-08T10:01:00.000Z"
  });

  const report = await service.getSettlementReport({
    market: "BTC-USDT",
    limit: 100,
    offset: 0
  });

  assert.equal(report.totals.settlementCount, 2);
  assert.equal(report.source, "materialized_summary");
  assert.equal(report.totals.settledCount, 1);
  assert.equal(report.totals.pendingRecoveryCount, 1);
  assert.equal(report.totals.failedCount, 0);
  assert.equal(report.totals.quoteAmount, "1950");
  assert.equal(report.markets[0]?.settlementCount, 2);
});

test("getSettlementReport uses materialized rollups for user and order scopes", async () => {
  const repository = new InMemorySettlementRepository();
  const service = new SettlementApplicationService(
    repository,
    {
      async getAccount(command) {
        return {
          accountId: command,
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
      now: () => new Date("2026-03-08T10:05:00.000Z"),
      createId: () => "settlement-rollup"
    }
  );

  await repository.saveSettlement({
    settlementId: "settlement-user-1",
    tradeId: "trade-user-1",
    market: "BTC-USDT",
    price: "65000",
    quantity: "0.01",
    quoteAmount: "650",
    feeAmount: "0.65",
    buyerFeeAmount: "0",
    buyerOrderId: "buy-user-1",
    sellerOrderId: "sell-user-1",
    buyerUserId: "shared-user",
    sellerUserId: "seller-a",
    buyerAccountId: "acct-shared-1",
    sellerAccountId: "acct-seller-a",
    status: "settled",
    attemptCount: 1,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:01.000Z",
    settledAt: "2026-03-08T10:00:01.000Z"
  });
  await repository.saveSettlement({
    settlementId: "settlement-user-2",
    tradeId: "trade-user-2",
    market: "ETH-USDT",
    price: "3200",
    quantity: "0.5",
    quoteAmount: "1600",
    feeAmount: "1.6",
    buyerFeeAmount: "0",
    buyerOrderId: "buy-user-2",
    sellerOrderId: "sell-user-2",
    buyerUserId: "buyer-b",
    sellerUserId: "shared-user",
    buyerAccountId: "acct-buyer-b",
    sellerAccountId: "acct-shared-2",
    status: "pending_recovery",
    attemptCount: 2,
    createdAt: "2026-03-08T10:01:00.000Z",
    updatedAt: "2026-03-08T10:01:30.000Z"
  });

  const userReport = await service.getSettlementReport({
    userId: "shared-user",
    limit: 100,
    offset: 0
  });
  const orderReport = await service.getSettlementReport({
    orderId: "buy-user-1",
    limit: 100,
    offset: 0
  });

  assert.equal(userReport.source, "materialized_summary");
  assert.equal(userReport.totals.settlementCount, 2);
  assert.equal(userReport.markets.length, 2);
  assert.equal(orderReport.source, "materialized_summary");
  assert.equal(orderReport.totals.settlementCount, 1);
  assert.equal(orderReport.markets[0]?.market, "BTC-USDT");
});

test("settleTrade charges each side in the asset it receives (dual maker / taker fees)", async () => {
  const journals: Array<{ businessType: string; entries: Array<{ accountId: string; assetCode: string; direction: string; amount: string }> }> = [];
  const service = new SettlementApplicationService(
    new InMemorySettlementRepository(),
    {
      async getAccount() {
        return null;
      },
      async createAccount(command) {
        return { accountId: command.accountId, userId: command.userId, accountType: command.accountType, status: "active" };
      },
      async consumeBalance() {
        return {};
      },
      async postJournal(command) {
        journals.push(command);
        return { journalId: `${command.businessType}-journal` };
      }
    },
    { now: () => new Date("2026-03-08T10:00:00.000Z"), createId: () => "settlement-dual" }
  );

  // Buyer is taker (0.1%), seller is maker (0.05%).
  const settlement = await service.settleTrade({ ...baseCommand, tradeId: "trade-dual", buyerFeeRate: "0.001", sellerFeeRate: "0.0005" });

  assert.equal(settlement.quoteAmount, "650");
  assert.equal(settlement.feeAmount, "0.325");
  assert.equal(settlement.buyerFeeAmount, "0.00001");

  const base = journals.find((journal) => journal.businessType === "spot_trade_settlement_base");
  const quote = journals.find((journal) => journal.businessType === "spot_trade_settlement_quote");
  assert.ok(base && quote);
  const credit = (journal: typeof base, accountId: string) =>
    journal.entries.find((entry) => entry.accountId === accountId && entry.direction === "credit")?.amount;
  assert.equal(credit(base, baseCommand.buyerAccountId), "0.00999");
  assert.equal(credit(quote, baseCommand.sellerAccountId), "649.675");
  // Both journals stay balanced and each carries a fee-account credit.
  for (const journal of [base, quote]) {
    const sum = (direction: string) =>
      journal.entries.filter((entry) => entry.direction === direction).reduce((total, entry) => total + Number(entry.amount), 0);
    assert.ok(Math.abs(sum("debit") - sum("credit")) < 1e-12);
    assert.equal(journal.entries.length, 3);
  }

  const report = await service.getSettlementReport({});
  assert.equal(report.markets[0]?.baseFeeAmount, "0.00001");
});

test("settleTrade charges the VIP tier rate resolved by order-service and records it (T-account balanced)", async () => {
  const journals: Array<{ businessType: string; description: string; entries: Array<{ accountId: string; direction: string; amount: string }> }> = [];
  const service = new SettlementApplicationService(
    new InMemorySettlementRepository(),
    {
      async getAccount() {
        return null;
      },
      async createAccount(command) {
        return { accountId: command.accountId, userId: command.userId, accountType: command.accountType, status: "active" };
      },
      async consumeBalance() {
        return {};
      },
      async postJournal(command) {
        journals.push(command);
        return { journalId: `${command.businessType}-journal` };
      }
    },
    { now: () => new Date("2026-03-08T10:00:00.000Z"), createId: () => "settlement-tier" }
  );

  // Buyer: VIP2 taker 0.08%; seller: VIP0 maker 0.05%.
  const settlement = await service.settleTrade({
    ...baseCommand,
    tradeId: "trade-tier",
    quantity: "2",
    buyerFeeRate: "0.0008",
    buyerFeeTier: "VIP2",
    sellerFeeRate: "0.0005",
    sellerFeeTier: "VIP0"
  });

  assert.equal(settlement.quoteAmount, "130000");
  assert.equal(settlement.buyerFeeAmount, "0.0016");
  assert.equal(settlement.feeAmount, "65");
  assert.equal(settlement.buyerFeeTier, "VIP2");
  assert.equal(settlement.buyerFeeRate, "0.0008");
  assert.equal(settlement.sellerFeeTier, "VIP0");
  const base = journals.find((journal) => journal.businessType === "spot_trade_settlement_base");
  assert.match(base?.description ?? "", /buyer fee VIP2 @ 0\.0008/);
  for (const journal of journals) {
    const sum = (direction: string) =>
      journal.entries.filter((entry) => entry.direction === direction).reduce((total, entry) => total + Number(entry.amount), 0);
    assert.ok(Math.abs(sum("debit") - sum("credit")) < 1e-9, `${journal.businessType} balances`);
  }
});
