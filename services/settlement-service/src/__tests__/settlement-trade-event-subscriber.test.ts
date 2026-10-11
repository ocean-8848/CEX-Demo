import assert from "node:assert/strict";
import test from "node:test";
import type { TradingEvent } from "@web3-cex/domain";

import { SettlementApplicationService } from "../application/settlement-application-service.js";
import { SettlementConsumerPauseControl } from "../application/settlement-consumer-pause.js";
import { SettlementTradeEventSubscriber } from "../application/settlement-trade-event-subscriber.js";
import { InMemorySettlementRepository } from "../infrastructure/in-memory-settlement-repository.js";

function createTradeExecutedEvent(
  tradeId: string,
  executionSequence: number
): TradingEvent {
  return {
    eventId: `exec-${executionSequence.toString()}`,
    eventType: "trade.executed",
    aggregateType: "spot_trade",
    aggregateId: tradeId,
    traceId: `execution:${tradeId}`,
    occurredAt: `2026-03-10T10:00:0${executionSequence.toString()}.000Z`,
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
        executedAt: `2026-03-10T10:00:0${executionSequence.toString()}.000Z`,
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

function createStreamEntry(
  tradeId: string,
  executionSequence: number
) {
  return {
    streamKey: "web3-cex:trade-events:btc-usdt",
    streamEntryId: `1741591200000-${executionSequence.toString()}`,
    publishedAt: `2026-03-10T10:00:0${executionSequence.toString()}.100Z`,
    market: "BTC-USDT" as const,
    executionSequence,
    replayCursor: `BTC-USDT:${executionSequence.toString()}`,
    protocolVersion: "v2",
    event: createTradeExecutedEvent(tradeId, executionSequence)
  };
}

function createService(repository: InMemorySettlementRepository) {
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
      now: () => new Date("2026-03-10T10:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `settlement-subscription-${++counter}`;
      })()
    }
  );
}

test("trade event subscriber settles and acknowledges fresh events", async () => {
  const repository = new InMemorySettlementRepository();
  const service = createService(repository);
  const acknowledgements: Array<{ tradeId: string; settlementId: string }> = [];
  const subscriber = new SettlementTradeEventSubscriber(
    service,
    {
      async listTradeEventStreamEntries() {
        return [createStreamEntry("trade-1", 1)];
      },
      async acknowledgeTradeSettlement(command) {
        acknowledgements.push(command);
        return command;
      }
    },
    {
      consumerId: "settlement-service",
      markets: ["BTC-USDT"],
      batchSize: 10,
      overlapCount: 1,
      now: () => new Date("2026-03-10T10:00:00.000Z")
    }
  );

  const summary = await subscriber.runOnce({
    trigger: "manual"
  });
  const checkpoints = await service.listTradeEventConsumerCheckpoints({
    consumerId: "settlement-service",
    market: "BTC-USDT",
    limit: 10,
    offset: 0
  });

  assert.equal(summary.appliedCount, 1);
  assert.equal(summary.duplicateCount, 0);
  assert.equal(summary.acknowledgedCount, 1);
  assert.equal(checkpoints[0]?.lastExecutionSequence, 1);
  assert.equal(checkpoints[0]?.lastStreamEntryId, "1741591200000-1");
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0]?.tradeId, "trade-1");
});

test("trade event subscriber retries settlement acknowledgement via overlap duplicates", async () => {
  const repository = new InMemorySettlementRepository();
  const service = createService(repository);
  const acknowledgements: Array<{ tradeId: string; settlementId: string }> = [];
  let firstAttempt = true;

  const subscriber = new SettlementTradeEventSubscriber(
    service,
    {
      async listTradeEventStreamEntries(query) {
        assert.equal(query.afterStreamEntryId, firstAttempt ? undefined : "1741591200000-1");
        assert.equal(query.executionSequenceFrom, firstAttempt ? undefined : 1);
        return [createStreamEntry("trade-1", 1)];
      },
      async acknowledgeTradeSettlement(command) {
        acknowledgements.push(command);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("order service unavailable");
        }
        return command;
      }
    },
    {
      consumerId: "settlement-service",
      markets: ["BTC-USDT"],
      batchSize: 10,
      overlapCount: 1,
      now: () => new Date("2026-03-10T10:00:00.000Z")
    }
  );

  const firstSummary = await subscriber.runOnce({
    trigger: "manual"
  });
  const secondSummary = await subscriber.runOnce({
    trigger: "manual"
  });

  assert.equal(firstSummary.appliedCount, 1);
  assert.equal(firstSummary.failedCount, 1);
  assert.equal(secondSummary.duplicateCount, 1);
  assert.equal(secondSummary.acknowledgedCount, 1);
  assert.equal(acknowledgements.length, 2);
  assert.equal(acknowledgements[1]?.tradeId, "trade-1");
});

test("paused consumer skips cycles without touching the checkpoint, then catches up on resume", async () => {
  let now = new Date("2026-03-10T10:00:00.000Z");
  const repository = new InMemorySettlementRepository();
  const service = createService(repository);
  const pause = new SettlementConsumerPauseControl({ now: () => now });
  let fetchCount = 0;
  const subscriber = new SettlementTradeEventSubscriber(
    service,
    {
      async listTradeEventStreamEntries() {
        fetchCount += 1;
        return [createStreamEntry("trade-1", 1)];
      },
      async acknowledgeTradeSettlement(command) {
        return command;
      }
    },
    {
      consumerId: "settlement-service",
      markets: ["BTC-USDT"],
      batchSize: 10,
      overlapCount: 1,
      now: () => now,
      pauseControl: pause
    }
  );

  pause.pause({ durationMs: 60_000, reason: "lab", requestedBy: "ops-admin" });
  const skipped = await subscriber.runOnce({ trigger: "automatic" });
  assert.equal((skipped as { skipped?: boolean }).skipped, true);
  assert.equal(skipped.appliedCount, 0);
  assert.equal(fetchCount, 0);
  assert.equal(pause.getState().skippedCycleCount, 1);
  const report = await subscriber.getReport();
  assert.equal(report.pause?.paused, true);
  assert.equal(report.pause?.requestedBy, "ops-admin");
  assert.equal(report.latestCycle, undefined);
  assert.equal(
    (
      await service.listTradeEventConsumerCheckpoints({
        consumerId: "settlement-service",
        market: "BTC-USDT",
        limit: 1,
        offset: 0
      })
    ).length,
    0
  );

  pause.resume();
  const resumed = await subscriber.runOnce({ trigger: "automatic" });
  assert.equal(resumed.appliedCount, 1);
  assert.equal(pause.getState().lastResumeTrigger, "manual");

  // Expiry heals a forgotten pause without anyone calling resume.
  pause.pause({ durationMs: 10_000 });
  now = new Date(now.getTime() + 10_001);
  assert.equal(pause.isPaused(), false);
  assert.equal(pause.getState().lastResumeTrigger, "expired");
  const afterExpiry = await subscriber.runOnce({ trigger: "automatic" });
  assert.equal((afterExpiry as { skipped?: boolean }).skipped, undefined);
});

test("a pause requested mid-cycle stops before the next stream entry", async () => {
  const now = new Date("2026-03-10T10:00:00.000Z");
  const repository = new InMemorySettlementRepository();
  const service = createService(repository);
  const pause = new SettlementConsumerPauseControl({ now: () => now });
  let pausedOnce = false;
  const subscriber = new SettlementTradeEventSubscriber(
    service,
    {
      async listTradeEventStreamEntries() {
        return [createStreamEntry("trade-1", 1), createStreamEntry("trade-2", 2)];
      },
      async acknowledgeTradeSettlement(command) {
        // The fault lab pauses (once) while the first trade is being settled.
        if (!pausedOnce) {
          pausedOnce = true;
          pause.pause({ durationMs: 60_000, reason: "lab" });
        }
        return command;
      }
    },
    {
      consumerId: "settlement-service",
      markets: ["BTC-USDT"],
      batchSize: 10,
      overlapCount: 1,
      now: () => now,
      pauseControl: pause
    }
  );

  const cycle = await subscriber.runOnce({ trigger: "automatic" });
  assert.equal(cycle.appliedCount, 1, "only the in-flight entry is applied");
  assert.equal((cycle.marketSummaries[0] as { interruptedByPause?: boolean }).interruptedByPause, true);

  pause.resume();
  const resumed = await subscriber.runOnce({ trigger: "automatic" });
  assert.equal(resumed.appliedCount, 1, "the remaining entry is applied after resume");
});

test("consumer pause clamps the duration and can be disabled", () => {
  const now = new Date("2026-03-10T10:00:00.000Z");
  const pause = new SettlementConsumerPauseControl({ now: () => now, maxDurationMs: 60_000 });
  const state = pause.pause({ durationMs: 24 * 60 * 60_000 });
  assert.equal(state.expiresAt, "2026-03-10T10:01:00.000Z");
  const short = pause.pause({ durationMs: 1 });
  assert.equal(short.expiresAt, "2026-03-10T10:00:05.000Z");
  assert.equal(short.pausedAt, "2026-03-10T10:00:00.000Z");

  const disabled = new SettlementConsumerPauseControl({ enabled: false });
  assert.throws(() => disabled.pause(), /SETTLEMENT_FAULT_LAB_ENABLED/);
  assert.equal(disabled.getState().paused, false);
});
