import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerBalanceReconciliationReport } from "../application/ledger-ops.js";
import {
  buildOrderLockReconciliationReport,
  type LedgerOrderLock,
  type OrderLockExpectationInput
} from "../application/order-lock-reconciliation.js";
import { evaluateReconciliationBreaker } from "../application/reconciliation-breaker.js";
import { ReconciliationJob } from "../application/reconciliation-job.js";
import { InMemoryReconciliationRunRepository } from "../infrastructure/reconciliation-run-repositories.js";

const SNAPSHOT = "2026-01-01T00:10:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function lock(orderId: string, remainingAmount: string, partial: Partial<LedgerOrderLock> = {}): LedgerOrderLock {
  return { orderId, accountId: "acct-1", assetCode: "USDT", remainingAmount, createdAt: OLD, ...partial };
}

function expectation(orderId: string, expectedLockAmount: string, partial: Partial<OrderLockExpectationInput> = {}): OrderLockExpectationInput {
  return {
    orderId,
    accountId: "acct-1",
    lockAssetCode: "USDT",
    status: "accepted",
    expectedLockAmount,
    inFlight: false,
    updatedAt: OLD,
    ...partial
  };
}

function report(locks: LedgerOrderLock[], expectations: OrderLockExpectationInput[]) {
  return buildOrderLockReconciliationReport({
    generatedAt: SNAPSHOT,
    ledgerSnapshotAt: SNAPSHOT,
    locks,
    lockedBalances: [{ accountId: "acct-1", assetCode: "USDT", locked: "350", otherLocked: "50" }],
    expectations,
    graceMs: 15_000,
    includeMatched: true
  });
}

test("order-vs-lock: matching locks roll up per account + asset", () => {
  const result = report([lock("o1", "100"), lock("o2", "200")], [expectation("o1", "100"), expectation("o2", "200")]);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.matchedCount, 2);
  const [item] = result.items;
  assert.equal(item?.status, "matched");
  assert.equal(item?.ledgerOrderLocked, "300");
  assert.equal(item?.orderExpectedLocked, "300");
  assert.equal(item?.ledgerLocked, "350", "ledger locked = order locks + withdrawal locks");
  assert.equal(item?.ledgerOtherLocked, "50");
});

test("order-vs-lock: amount differences, missing and orphan locks are mismatches", () => {
  const result = report(
    [lock("o1", "100.5"), lock("orphan", "10")],
    [expectation("o1", "100"), expectation("missing", "20")]
  );
  assert.equal(result.mismatchCount, 3);
  assert.deepEqual(result.mismatchedAssets, ["USDT"]);
  const byOrder = new Map(result.mismatches.map((item) => [item.orderId, item]));
  assert.equal(byOrder.get("o1")?.reason, "lock_amount_mismatch");
  assert.equal(byOrder.get("o1")?.difference, "0.5");
  assert.equal(byOrder.get("orphan")?.reason, "orphan_ledger_lock");
  assert.equal(byOrder.get("missing")?.reason, "missing_ledger_lock");
  assert.equal(byOrder.get("missing")?.difference, "-20");
  assert.equal(result.items[0]?.status, "mismatch");
  assert.equal(result.items[0]?.settledDifference, "-9.5");
});

test("order-vs-lock: differences explained by timing are in flight, not mismatches", () => {
  const recent = "2026-01-01T00:09:55.000Z"; // 5s before the ledger snapshot
  const after = "2026-01-01T00:10:01.000Z"; // order-service changed it after the snapshot
  const result = report(
    [lock("pending", "100"), lock("touched", "100"), lock("filled", "100"), lock("fresh", "100", { createdAt: recent }), lock("late", "100")],
    [
      expectation("pending", "0", { inFlight: true, inFlightReason: "recovery_pending" }),
      expectation("touched", "60", { updatedAt: recent }),
      expectation("filled", "40", { lastTradeAt: after }),
      expectation("late", "50", { updatedAt: after })
      // "fresh": the lock exists but the order is not visible yet
    ]
  );
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.inFlightCount, 5);
  assert.deepEqual(
    Object.fromEntries(result.inFlight.map((item) => [item.orderId, item.inFlightReason])),
    {
      pending: "recovery_pending",
      touched: "order_recently_updated",
      filled: "recent_fill",
      fresh: "lock_recently_created",
      late: "order_recently_updated"
    }
  );
  assert.equal(result.items[0]?.status, "in_flight");
});

test("breaker: balance mismatches trip at once, order-lock mismatches need the same order in N runs", () => {
  const first = evaluateReconciliationBreaker({
    current: { balanceMismatchedAssets: ["ETH"], orderLockMismatches: { USDT: ["o1", "o2"] } },
    previous: [],
    confirmations: 2
  });
  assert.deepEqual(first.trips, [{ assetCode: "ETH", reason: "balance_mismatch" }]);
  assert.deepEqual(first.suspects, [{ assetCode: "USDT", orderIds: ["o1", "o2"], consecutiveRuns: 1 }]);

  const transient = evaluateReconciliationBreaker({
    current: { balanceMismatchedAssets: [], orderLockMismatches: { USDT: ["o3"] } },
    previous: [{ balanceMismatchedAssets: [], orderLockMismatches: { USDT: ["o1", "o2"] } }],
    confirmations: 2
  });
  assert.deepEqual(transient.trips, [], "different orders each run are timing noise, not a persistent mismatch");

  const confirmed = evaluateReconciliationBreaker({
    current: { balanceMismatchedAssets: [], orderLockMismatches: { USDT: ["o2", "o9"] } },
    previous: [{ balanceMismatchedAssets: [], orderLockMismatches: { USDT: ["o1", "o2"] } }],
    confirmations: 2
  });
  assert.deepEqual(confirmed.trips, [{ assetCode: "USDT", reason: "order_lock_mismatch", orderIds: ["o2"] }]);

  const single = evaluateReconciliationBreaker({
    current: { balanceMismatchedAssets: [], orderLockMismatches: { BTC: ["o1"] } },
    previous: [],
    confirmations: 1
  });
  assert.equal(single.trips[0]?.reason, "order_lock_mismatch");
});

function balanceReport(mismatchedAssets: string[]): LedgerBalanceReconciliationReport {
  return {
    generatedAt: SNAPSHOT,
    scannedCount: 10,
    matchedCount: 10 - mismatchedAssets.length,
    mismatchCount: mismatchedAssets.length,
    items: mismatchedAssets.map((assetCode) => ({
      accountId: "00000000-0000-0000-0000-0000000000a1",
      assetCode,
      entryCount: 0,
      lockCount: 0,
      journalNet: "0",
      activeLocked: "0",
      expectedAvailable: "0",
      expectedLocked: "0",
      snapshotAvailable: "1",
      snapshotLocked: "0",
      snapshotTotal: "1",
      expectedTotal: "0",
      mismatchReasons: ["available_mismatch", "total_mismatch"]
    }))
  };
}

test("job: a healthy run stores ok and pauses nothing; a drift pauses the asset once (automatic) with a P1 alert", async () => {
  let mismatched: string[] = [];
  const pauses: Array<{ assetCode: string; reason: string }> = [];
  const paused = new Set<string>();
  const runs = new InMemoryReconciliationRunRepository();
  const job = new ReconciliationJob({
    ledger: {
      async reconcileBalances() {
        return balanceReport(mismatched);
      },
      async collectOrderLockSnapshot() {
        return { snapshotAt: SNAPSHOT, locks: [lock("o1", "100")], lockedBalances: [] };
      }
    },
    orders: {
      async getLockExpectations(orderIds) {
        assert.deepEqual(orderIds, ["o1"]);
        return [expectation("o1", "100")];
      }
    },
    withdrawals: {
      async pauseAssetWithdrawals(command) {
        pauses.push(command);
        const changed = !paused.has(command.assetCode);
        paused.add(command.assetCode);
        return { changed };
      }
    },
    runs,
    config: { intervalSeconds: 30, graceMs: 15_000, breakerEnabled: true, confirmations: 2 },
    now: () => new Date(SNAPSHOT)
  });

  const healthy = await job.runOnce("scheduled");
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.orderLock?.mismatchCount, 0);
  assert.deepEqual(healthy.alerts, []);
  assert.deepEqual(pauses, []);

  mismatched = ["SOL"];
  const tripped = await job.runOnce("manual");
  assert.equal(tripped.status, "mismatch");
  assert.deepEqual(tripped.breaker.actions, [{ assetCode: "SOL", reason: "balance_mismatch", outcome: "paused" }]);
  assert.match((pauses as Array<{ reason: string }>)[0]?.reason ?? "", /对账熔断/);
  assert.ok(tripped.alerts.some((alert) => alert.level === "P1" && alert.code === "RECONCILIATION_BREAKER_TRIPPED"));

  const again = await job.runOnce("scheduled");
  assert.equal(again.breaker.actions[0]?.outcome, "already_paused");

  const history = await runs.list(10);
  assert.deepEqual(history.map((run) => run.status), ["mismatch", "mismatch", "ok"]);
  assert.equal(job.getStatus().lastStatus, "mismatch");
});

test("job: order-service down gives a partial run; breaker disabled only reports", async () => {
  const pauses: string[] = [];
  const job = new ReconciliationJob({
    ledger: {
      async reconcileBalances() {
        return balanceReport(["ETH"]);
      },
      async collectOrderLockSnapshot() {
        return { snapshotAt: SNAPSHOT, locks: [], lockedBalances: [] };
      }
    },
    orders: {
      async getLockExpectations() {
        throw new Error("connect ECONNREFUSED");
      }
    },
    withdrawals: {
      async pauseAssetWithdrawals(command) {
        pauses.push(command.assetCode);
        return { changed: true };
      }
    },
    runs: new InMemoryReconciliationRunRepository(),
    config: { intervalSeconds: 0, graceMs: 15_000, breakerEnabled: false, confirmations: 2 }
  });
  const run = await job.runOnce("manual");
  assert.equal(run.status, "mismatch");
  assert.match(run.orderLockError ?? "", /ECONNREFUSED/);
  assert.deepEqual(run.breaker.actions, [{ assetCode: "ETH", reason: "balance_mismatch", outcome: "disabled" }]);
  assert.deepEqual(pauses, []);
  assert.ok(run.alerts.some((alert) => alert.code === "BALANCE_RECONCILIATION_MISMATCH" && alert.level === "P1"));
});
