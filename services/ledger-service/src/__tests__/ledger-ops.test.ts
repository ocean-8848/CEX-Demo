import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAccountReplayReport,
  buildBalanceReconciliationReport,
  defaultLedgerAlertThresholds,
  evaluateLedgerAlertThresholds
} from "../application/ledger-ops.js";

test("buildBalanceReconciliationReport reports balance mismatches against entries and locks", () => {
  const report = buildBalanceReconciliationReport({
    generatedAt: "2026-03-08T10:00:00.000Z",
    balances: [
      {
        accountId: "acct-matched",
        assetCode: "USDT",
        accountType: "spot",
        available: "70",
        locked: "30"
      },
      {
        accountId: "acct-mismatched",
        assetCode: "USDT",
        accountType: "spot",
        available: "80",
        locked: "15"
      }
    ],
    entryNets: [
      {
        accountId: "acct-matched",
        assetCode: "USDT",
        netAmount: "100",
        entryCount: 2
      },
      {
        accountId: "acct-mismatched",
        assetCode: "USDT",
        netAmount: "100",
        entryCount: 2
      }
    ],
    activeLocks: [
      {
        accountId: "acct-matched",
        assetCode: "USDT",
        lockedAmount: "30",
        lockCount: 1
      },
      {
        accountId: "acct-mismatched",
        assetCode: "USDT",
        lockedAmount: "10",
        lockCount: 1
      }
    ]
  });

  assert.equal(report.generatedAt, "2026-03-08T10:00:00.000Z");
  assert.equal(report.scannedCount, 2);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.items.length, 1);

  assert.deepEqual(report.items[0], {
    accountId: "acct-mismatched",
    assetCode: "USDT",
    accountType: "spot",
    entryCount: 2,
    lockCount: 1,
    journalNet: "100",
    activeLocked: "10",
    expectedAvailable: "90",
    expectedLocked: "10",
    snapshotAvailable: "80",
    snapshotLocked: "15",
    snapshotTotal: "95",
    expectedTotal: "100",
    mismatchReasons: ["available_mismatch", "locked_mismatch", "total_mismatch"]
  });
});

test("buildAccountReplayReport reconstructs available and locked balances from entries and locks", () => {
  const report = buildAccountReplayReport({
    generatedAt: "2026-03-08T10:00:00.000Z",
    accountId: "acct-replay",
    assetCode: "USDT",
    snapshotAvailable: "75",
    snapshotLocked: "0",
    entries: [
      {
        entryId: "entry-1",
        journalId: "journal-1",
        direction: "credit",
        amount: "100",
        referenceType: "deposit",
        referenceId: "dep-1",
        createdAt: "2026-03-08T10:00:00.000Z",
        businessType: "deposit",
        businessId: "dep-1"
      },
      {
        entryId: "entry-2",
        journalId: "journal-2",
        direction: "debit",
        amount: "20",
        referenceType: "fee",
        referenceId: "fee-1",
        createdAt: "2026-03-08T10:01:00.000Z",
        businessType: "fee",
        businessId: "fee-1"
      }
    ],
    locks: [
      {
        lockId: "lock-1",
        amount: "10",
        referenceType: "order",
        referenceId: "ord-1",
        status: "released",
        createdAt: "2026-03-08T10:02:00.000Z",
        releasedAt: "2026-03-08T10:03:00.000Z"
      },
      {
        lockId: "lock-2",
        amount: "5",
        referenceType: "withdrawal",
        referenceId: "wd-1",
        status: "consumed",
        createdAt: "2026-03-08T10:04:00.000Z",
        consumedAt: "2026-03-08T10:05:00.000Z"
      }
    ]
  });

  assert.equal(report.mismatch, false);
  assert.equal(report.reconstructedAvailable, "75");
  assert.equal(report.reconstructedLocked, "0");
  assert.deepEqual(
    report.steps.map((step) => ({
      type: step.type,
      availableAfter: step.availableAfter,
      lockedAfter: step.lockedAfter
    })),
    [
      { type: "entry_credit", availableAfter: "100", lockedAfter: "0" },
      { type: "entry_debit", availableAfter: "80", lockedAfter: "0" },
      { type: "lock", availableAfter: "70", lockedAfter: "10" },
      { type: "release", availableAfter: "80", lockedAfter: "0" },
      { type: "lock", availableAfter: "75", lockedAfter: "5" },
      { type: "consume", availableAfter: "75", lockedAfter: "0" }
    ]
  );
});

test("evaluateLedgerAlertThresholds returns alert when operational thresholds are breached", () => {
  const overview = evaluateLedgerAlertThresholds(
    {
      generatedAt: "2026-03-08T10:00:00.000Z",
      outbox: {
        pendingCount: 5,
        retryingCount: 2,
        deadLetteredCount: 1,
        oldestPendingAgeSeconds: 900
      },
      locks: {
        activeCount: 3,
        staleCount: 2,
        oldestActiveAgeSeconds: 1200,
        staleThresholdMinutes: 30
      },
      reconciliation: {
        scannedCount: 8,
        mismatchCount: 1,
        negativeAvailableCount: 1,
        negativeLockedCount: 0
      }
    },
    {
      ...defaultLedgerAlertThresholds(30),
      maxPendingOutbox: 1,
      maxRetryingOutbox: 0,
      maxDeadLetteredOutbox: 0,
      maxOldestPendingOutboxAgeSeconds: 60,
      maxStaleLocks: 0,
      maxBalanceMismatches: 0,
      maxNegativeAvailableBalances: 0,
      maxNegativeLockedBalances: 0
    }
  );

  assert.equal(overview.status, "alert");
  assert.deepEqual(overview.alerts, [
    "pending_outbox_count=5 exceeds threshold 1",
    "retrying_outbox_count=2 exceeds threshold 0",
    "dead_lettered_outbox_count=1 exceeds threshold 0",
    "oldest_pending_outbox_age_seconds=900 exceeds threshold 60",
    "stale_locked_balance_count=2 exceeds threshold 0",
    "balance_mismatch_count=1 exceeds threshold 0",
    "negative_available_balance_count=1 exceeds threshold 0"
  ]);
});

test("evaluateLedgerAlertThresholds ignores negative opening balance snapshots", () => {
  const overview = evaluateLedgerAlertThresholds(
    {
      generatedAt: "2026-03-08T10:00:00.000Z",
      outbox: {
        pendingCount: 0,
        retryingCount: 0,
        deadLetteredCount: 0
      },
      locks: {
        activeCount: 0,
        staleCount: 0,
        staleThresholdMinutes: 30
      },
      reconciliation: {
        scannedCount: 1,
        mismatchCount: 0,
        negativeAvailableCount: 0,
        negativeLockedCount: 0
      }
    },
    defaultLedgerAlertThresholds(30)
  );

  assert.equal(overview.status, "ok");
  assert.deepEqual(overview.alerts, []);
});

test("buildAccountReplayReport uses real lock adjustments for partial releases and settlements", () => {
  // Buy order locks 100 USDT, 40 is settled (journal debit 40), the rest is released on cancel.
  const report = buildAccountReplayReport({
    generatedAt: "2026-03-08T10:00:00.000Z",
    accountId: "acct-replay",
    assetCode: "USDT",
    snapshotAvailable: "460",
    snapshotLocked: "0",
    entries: [
      { entryId: "e-1", journalId: "j-1", direction: "credit", amount: "500", referenceType: "deposit", referenceId: "dep-1", createdAt: "2026-03-08T10:00:00.000Z", businessType: "deposit", businessId: "dep-1" },
      { entryId: "e-2", journalId: "j-2", direction: "debit", amount: "40", referenceType: "spot_order", referenceId: "ord-1", createdAt: "2026-03-08T10:02:00.000Z", businessType: "trade_settlement", businessId: "trade-1" }
    ],
    // The lock row alone would claim a full release *and* a full consumption.
    locks: [
      { lockId: "lock-1", amount: "100", referenceType: "spot_order", referenceId: "ord-1", status: "settled", createdAt: "2026-03-08T10:01:00.000Z", releasedAt: "2026-03-08T10:03:00.000Z", consumedAt: "2026-03-08T10:03:00.000Z" }
    ],
    lockAdjustments: [
      { at: "2026-03-08T10:01:00.000Z", type: "lock", amount: "100", referenceType: "spot_order", referenceId: "ord-1" },
      { at: "2026-03-08T10:02:00.000Z", type: "settle", amount: "40", referenceType: "spot_order", referenceId: "ord-1" },
      { at: "2026-03-08T10:03:00.000Z", type: "release", amount: "60", referenceType: "spot_order", referenceId: "ord-1" }
    ]
  });

  assert.equal(report.reconstructedAvailable, "460");
  assert.equal(report.reconstructedLocked, "0");
  assert.equal(report.mismatch, false);
});
