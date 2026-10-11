import test from "node:test";
import assert from "node:assert/strict";

import { LedgerApplicationService } from "../application/ledger-application-service.js";
import { LedgerOutboxPublisher } from "../application/ledger-outbox-publisher.js";
import { InMemoryLedgerRepository } from "../infrastructure/in-memory-ledger-repository.js";

function createService() {
  const repository = new InMemoryLedgerRepository();
  const service = new LedgerApplicationService(repository, {
    now: () => new Date("2026-03-07T00:00:00.000Z"),
    createId: (() => {
      let counter = 0;
      return () => `id_${++counter}`;
    })()
  });

  return { repository, service };
}

async function bootstrapAccounts() {
  const context = createService();
  const { repository, service } = context;

  await service.createAccount({
    accountId: "user-spot",
    accountType: "spot"
  });

  await service.createAccount({
    accountId: "platform-hot-wallet",
    accountType: "hot_wallet"
  });

  await service.createAccount({
    accountId: "treasury",
    accountType: "funding"
  });

  await repository.saveBalance({
    accountId: "treasury",
    assetCode: "USDT",
    available: "100000",
    locked: "0",
    version: 1,
    updatedAt: "2026-03-07T00:00:00.000Z"
  });

  return context;
}

test("postJournal credits and debits balances with idempotency", async () => {
  const { service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-1",
    idempotencyKey: "seed-1",
    traceId: "trace-seed-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "1000",
        referenceType: "seed",
        referenceId: "seed-1"
      },
      {
        accountId: "platform-hot-wallet",
        assetCode: "USDT",
        direction: "credit",
        amount: "1000",
        referenceType: "seed",
        referenceId: "seed-1"
      }
    ]
  });

  const firstJournal = await service.postJournal({
    businessType: "airdrop",
    businessId: "airdrop-1",
    idempotencyKey: "airdrop-1",
    traceId: "trace-airdrop-1",
    entries: [
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "100",
        referenceType: "airdrop",
        referenceId: "airdrop-1"
      },
      {
        accountId: "platform-hot-wallet",
        assetCode: "USDT",
        direction: "debit",
        amount: "100",
        referenceType: "airdrop",
        referenceId: "airdrop-1"
      }
    ]
  });

  const secondJournal = await service.postJournal({
    businessType: "airdrop",
    businessId: "airdrop-1",
    idempotencyKey: "airdrop-1",
    traceId: "trace-airdrop-1",
    entries: [
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "100",
        referenceType: "airdrop",
        referenceId: "airdrop-1"
      },
      {
        accountId: "platform-hot-wallet",
        assetCode: "USDT",
        direction: "debit",
        amount: "100",
        referenceType: "airdrop",
        referenceId: "airdrop-1"
      }
    ]
  });

  assert.equal(firstJournal.journalId, secondJournal.journalId);

  const userBalance = await service.getBalance("user-spot", "USDT");
  const platformBalance = await service.getBalance("platform-hot-wallet", "USDT");

  assert.equal(userBalance.available, "100");
  assert.equal(platformBalance.available, "900");
});

test("freezeBalance and releaseBalance move amounts between available and locked", async () => {
  const { service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-1",
    idempotencyKey: "seed-1",
    traceId: "trace-seed-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "200",
        referenceType: "seed",
        referenceId: "seed-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "200",
        referenceType: "seed",
        referenceId: "seed-1"
      }
    ]
  });

  const lock = await service.freezeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    amount: "25",
    referenceType: "order",
    referenceId: "ord-1"
  });

  assert.equal(lock.status, "locked");

  const lockedBalance = await service.getBalance("user-spot", "USDT");
  assert.equal(lockedBalance.available, "175");
  assert.equal(lockedBalance.locked, "25");

  const released = await service.releaseBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    referenceType: "order",
    referenceId: "ord-1"
  });

  assert.equal(released.status, "released");

  const finalBalance = await service.getBalance("user-spot", "USDT");
  assert.equal(finalBalance.available, "200");
  assert.equal(finalBalance.locked, "0");
});

test("consumeBalance refuses to drop locked funds without a settlement account", async () => {
  const { service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-2",
    idempotencyKey: "seed-2",
    traceId: "trace-seed-2",
    entries: [
      { accountId: "treasury", assetCode: "USDT", direction: "debit", amount: "150", referenceType: "seed", referenceId: "seed-2" },
      { accountId: "user-spot", assetCode: "USDT", direction: "credit", amount: "150", referenceType: "seed", referenceId: "seed-2" }
    ]
  });

  await service.freezeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    amount: "30",
    referenceType: "withdrawal",
    referenceId: "wd-1"
  });

  await assert.rejects(
    () =>
      service.consumeBalance({
        accountId: "user-spot",
        assetCode: "USDT",
        referenceType: "withdrawal",
        referenceId: "wd-1"
      }),
    /Settlement account is required/
  );

  const balance = await service.getBalance("user-spot", "USDT");
  assert.equal(balance.available, "120");
  assert.equal(balance.locked, "30");
});

test("consumeBalance settles withdrawals by journaling against the settlement account", async () => {
  const { service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-3",
    idempotencyKey: "seed-3",
    traceId: "trace-seed-3",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "150",
        referenceType: "seed",
        referenceId: "seed-3"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "150",
        referenceType: "seed",
        referenceId: "seed-3"
      }
    ]
  });

  await service.freezeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    amount: "30",
    referenceType: "withdrawal",
    referenceId: "wd-settle-1"
  });

  const settled = await service.consumeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    referenceType: "withdrawal",
    referenceId: "wd-settle-1",
    settlementAccountId: "treasury",
    traceId: "trace-wd-settle-1",
    businessId: "wd-settle-1"
  });

  assert.equal(settled.status, "settled");

  const userBalance = await service.getBalance("user-spot", "USDT");
  const treasuryBalance = await service.getBalance("treasury", "USDT");
  assert.equal(userBalance.available, "120");
  assert.equal(userBalance.locked, "0");
  assert.equal(treasuryBalance.available, "99880");

  const settlementJournals = await service.listJournals({
    businessType: "withdrawal_settled",
    businessId: "wd-settle-1"
  });
  assert.equal(settlementJournals.length, 1);

  const entries = await service.listEntries({
    accountId: "user-spot",
    referenceType: "withdrawal",
    referenceId: "wd-settle-1"
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.direction, "debit");
  assert.equal(entries[0]?.amount, "30");
});

test("consumeBalance keeps settlement idempotency scoped to each lock", async () => {
  const { repository, service } = await bootstrapAccounts();

  await repository.saveBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    available: "250",
    locked: "0",
    version: 1,
    updatedAt: "2026-03-07T00:00:00.000Z"
  });
  await repository.saveBalance({
    accountId: "platform-hot-wallet",
    assetCode: "ETH",
    available: "10",
    locked: "0",
    version: 1,
    updatedAt: "2026-03-07T00:00:00.000Z"
  });

  await service.freezeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    amount: "160",
    referenceType: "spot_order",
    referenceId: "buy-1"
  });
  await service.freezeBalance({
    accountId: "platform-hot-wallet",
    assetCode: "ETH",
    amount: "0.05",
    referenceType: "spot_order",
    referenceId: "sell-1"
  });

  const buyerLock = await service.consumeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    referenceType: "spot_order",
    referenceId: "buy-1",
    settlementAccountId: "treasury",
    businessId: "trade-1",
    traceId: "trace-trade-1-buyer"
  });
  const sellerLock = await service.consumeBalance({
    accountId: "platform-hot-wallet",
    assetCode: "ETH",
    referenceType: "spot_order",
    referenceId: "sell-1",
    settlementAccountId: "treasury",
    businessId: "trade-1",
    traceId: "trace-trade-1-seller"
  });

  assert.equal(buyerLock.status, "settled");
  assert.equal(sellerLock.status, "settled");

  const settlementJournals = await service.listJournals({
    businessType: "spot_order_lock_settled",
    businessId: "trade-1",
    limit: 10,
    offset: 0
  });
  assert.equal(settlementJournals.length, 2);

  const treasuryUsdtBalance = await service.getBalance("treasury", "USDT");
  const treasuryEthBalance = await service.getBalance("treasury", "ETH");
  assert.equal(treasuryUsdtBalance.available, "100160");
  assert.equal(treasuryEthBalance.available, "0.05");
});

test("postJournal rejects unbalanced journals", async () => {
  const { service } = createService();

  await service.createAccount({
    accountId: "user-spot",
    accountType: "spot"
  });

  await assert.rejects(
    () =>
      service.postJournal({
        businessType: "broken",
        businessId: "broken-1",
        idempotencyKey: "broken-1",
        traceId: "trace-broken-1",
        entries: [
          {
            accountId: "user-spot",
            assetCode: "USDT",
            direction: "credit",
            amount: "10",
            referenceType: "broken",
            referenceId: "broken-1"
          }
        ]
      }),
    /Journal is not balanced/
  );
});

test("getJournal and listEntries expose posted funds flow", async () => {
  const { service } = await bootstrapAccounts();

  const journal = await service.postJournal({
    businessType: "seed",
    businessId: "seed-entries-1",
    idempotencyKey: "seed-entries-1",
    traceId: "trace-seed-entries-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "80",
        referenceType: "seed",
        referenceId: "seed-entries-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "80",
        referenceType: "seed",
        referenceId: "seed-entries-1"
      }
    ]
  });

  const fetchedJournal = await service.getJournal(journal.journalId);
  assert.equal(fetchedJournal?.journalId, journal.journalId);
  assert.equal(fetchedJournal?.entries.length, 2);

  const journals = await service.listJournals({
    businessType: "seed"
  });
  assert.equal(journals[0]?.journalId, journal.journalId);

  const entries = await service.listEntries({
    accountId: "user-spot",
    assetCode: "USDT"
  });
  assert.equal(entries[0]?.journalId, journal.journalId);
  assert.equal(entries[0]?.direction, "credit");
  assert.equal(entries[0]?.amount, "80");
});

test("ledger outbox publisher publishes pending events and marks them published", async () => {
  const { repository, service } = await bootstrapAccounts();
  const publishedEventIds: string[] = [];

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-outbox-1",
    idempotencyKey: "seed-outbox-1",
    traceId: "trace-seed-outbox-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "50",
        referenceType: "seed",
        referenceId: "seed-outbox-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "50",
        referenceType: "seed",
        referenceId: "seed-outbox-1"
      }
    ]
  });

  const publisher = new LedgerOutboxPublisher(
    repository,
    {
      async publish(events) {
        publishedEventIds.push(...events.map((event) => event.eventId));
      }
    },
    {
      now: () => new Date("2026-03-07T01:00:00.000Z")
    }
  );

  const result = await publisher.publishPending();

  assert.equal(result.publishedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.deadLetteredCount, 0);
  assert.equal(publishedEventIds.length, 1);

  const pending = await repository.listPendingOutboxEvents(10, "2026-03-07T01:00:00.000Z");
  assert.equal(pending.length, 0);
});

test("ledger outbox publisher marks failed events for retry", async () => {
  const { repository, service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-outbox-fail-1",
    idempotencyKey: "seed-outbox-fail-1",
    traceId: "trace-seed-outbox-fail-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "12",
        referenceType: "seed",
        referenceId: "seed-outbox-fail-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "12",
        referenceType: "seed",
        referenceId: "seed-outbox-fail-1"
      }
    ]
  });

  const [pendingEvent] = await repository.listPendingOutboxEvents(10, "2026-03-07T01:00:00.000Z");
  assert.ok(pendingEvent);

  const publisher = new LedgerOutboxPublisher(
    repository,
    {
      async publish() {
        throw new Error("simulated transport failure");
      }
    },
    {
      now: () => new Date("2026-03-07T01:00:00.000Z"),
      retryDelayMs: 1000,
      maxAttempts: 3
    }
  );

  const result = await publisher.publishPending();

  assert.equal(result.publishedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.deadLetteredCount, 0);

  const updated = repository.getOutboxEvent(pendingEvent.eventId);
  assert.equal(updated?.publishAttempts, 1);
  assert.equal(updated?.lastError, "simulated transport failure");
  assert.equal(updated?.lastAttemptedAt, "2026-03-07T01:00:00.000Z");
  assert.equal(updated?.nextAttemptAt, "2026-03-07T01:00:01.000Z");
  assert.equal(updated?.deadLetteredAt, undefined);
});

test("ledger outbox publisher dead-letters events after max attempts", async () => {
  const { repository, service } = await bootstrapAccounts();
  const deadLetteredEventIds: string[] = [];

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-outbox-dead-1",
    idempotencyKey: "seed-outbox-dead-1",
    traceId: "trace-seed-outbox-dead-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "13",
        referenceType: "seed",
        referenceId: "seed-outbox-dead-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "13",
        referenceType: "seed",
        referenceId: "seed-outbox-dead-1"
      }
    ]
  });

  const [pendingEvent] = await repository.listPendingOutboxEvents(10, "2026-03-07T01:00:00.000Z");
  assert.ok(pendingEvent);

  await repository.recordOutboxEventFailure({
    eventId: pendingEvent.eventId,
    attemptedAt: "2026-03-07T00:59:00.000Z",
    errorMessage: "previous failure",
    nextAttemptAt: "2026-03-07T00:59:00.000Z"
  });
  await repository.recordOutboxEventFailure({
    eventId: pendingEvent.eventId,
    attemptedAt: "2026-03-07T00:59:30.000Z",
    errorMessage: "previous failure",
    nextAttemptAt: "2026-03-07T00:59:30.000Z"
  });

  const publisher = new LedgerOutboxPublisher(
    repository,
    {
      async publish() {
        throw new Error("simulated terminal failure");
      },
      async publishDeadLetter({ event }) {
        deadLetteredEventIds.push(event.eventId);
      }
    },
    {
      now: () => new Date("2026-03-07T01:00:00.000Z"),
      retryDelayMs: 1000,
      maxAttempts: 3
    }
  );

  const result = await publisher.publishPending();

  assert.equal(result.publishedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.deadLetteredCount, 1);
  assert.deepEqual(deadLetteredEventIds, [pendingEvent.eventId]);

  const updated = repository.getOutboxEvent(pendingEvent.eventId);
  assert.equal(updated?.publishAttempts, 3);
  assert.equal(updated?.deadLetteredAt, "2026-03-07T01:00:00.000Z");
  assert.equal(updated?.nextAttemptAt, undefined);
});

test("ledger repository can requeue dead-lettered outbox events", async () => {
  const { repository, service } = await bootstrapAccounts();

  await service.postJournal({
    businessType: "seed",
    businessId: "seed-outbox-requeue-1",
    idempotencyKey: "seed-outbox-requeue-1",
    traceId: "trace-seed-outbox-requeue-1",
    entries: [
      {
        accountId: "treasury",
        assetCode: "USDT",
        direction: "debit",
        amount: "14",
        referenceType: "seed",
        referenceId: "seed-outbox-requeue-1"
      },
      {
        accountId: "user-spot",
        assetCode: "USDT",
        direction: "credit",
        amount: "14",
        referenceType: "seed",
        referenceId: "seed-outbox-requeue-1"
      }
    ]
  });

  const [pendingEvent] = await repository.listPendingOutboxEvents(10, "2026-03-07T01:00:00.000Z");
  assert.ok(pendingEvent);

  await repository.recordOutboxEventFailure({
    eventId: pendingEvent.eventId,
    attemptedAt: "2026-03-07T01:00:00.000Z",
    errorMessage: "terminal failure",
    deadLetteredAt: "2026-03-07T01:00:00.000Z"
  });

  const deadLettered = await repository.listDeadLetteredOutboxEvents(10);
  assert.equal(deadLettered.length, 1);

  await repository.requeueOutboxEvents([pendingEvent.eventId], "2026-03-07T01:01:00.000Z");

  const requeued = repository.getOutboxEvent(pendingEvent.eventId);
  assert.equal(requeued?.publishAttempts, 0);
  assert.equal(requeued?.deadLetteredAt, undefined);
  assert.equal(requeued?.lastError, undefined);
});

test("opening-balance equity accounts may go negative while customer accounts may not", async () => {
  const { service } = createService();
  await service.createAccount({ accountId: "opening", accountType: "opening_balance" });
  await service.createAccount({ accountId: "customer", accountType: "spot" });

  const seed = (debitAccountId: string, creditAccountId: string, key: string) =>
    service.postJournal({
      businessType: "seed",
      businessId: key,
      idempotencyKey: key,
      traceId: key,
      description: "seed",
      entries: [
        { accountId: debitAccountId, assetCode: "USDT", direction: "debit", amount: "100", referenceType: "seed", referenceId: `${key}:d` },
        { accountId: creditAccountId, assetCode: "USDT", direction: "credit", amount: "100", referenceType: "seed", referenceId: `${key}:c` }
      ]
    });

  await seed("opening", "customer", "seed-1");
  assert.equal((await service.getBalance("opening", "USDT"))?.available, "-100");
  assert.equal((await service.getBalance("customer", "USDT"))?.available, "100");

  await assert.rejects(seed("customer", "opening", "overdraw").then(() => seed("customer", "opening", "overdraw-2")), {
    code: "INSUFFICIENT_AVAILABLE_BALANCE"
  });
});
