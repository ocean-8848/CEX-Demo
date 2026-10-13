import type { AssetCode } from "@web3-cex/domain";

const SCALE = 18n;
const BASE = 10n ** SCALE;

/**
 * Order ↔ lock reconciliation (A2a). For every account + asset it compares
 * what order-service says the orders still need frozen with what the ledger
 * actually holds in `spot_order` locks:
 *
 *   ledger side : remaining_amount of every active (`locked`) spot_order lock
 *   order side  : open quantity lock (order-service `/orders/ops/lock-expectations`)
 *                 + every fill of the order that the ledger has NOT consumed
 *                 yet in the same snapshot (consume journal idempotency key
 *                 `spot_order:<orderId>:<asset>:settlement:<tradeId>`)
 *
 * Deciding "consumed" from the ledger snapshot (not from settlement's
 * acknowledgement to order-service) keeps both sides on one point in time
 * and survives lost acknowledgements.
 *
 * The comparison runs per order, then rolls up per account + asset. The
 * ledger's total `locked` balance is reported next to it (order locks +
 * withdrawal locks); the balance reconciliation already proves that the
 * snapshot equals the sum of active locks.
 *
 * In-flight timing: the two services are read at different moments (ledger
 * snapshot first, order-service afterwards), and an order travels
 * risk → freeze → engine → persist → settlement. A differing order is only a
 * mismatch when nothing about it moved recently:
 *   - order-service flags it in flight (`pending_risk`, `recovery_pending`);
 *   - the order or its latest fill changed within `graceMs` before the
 *     ledger snapshot (or after it);
 *   - its lock was created within `graceMs` before the snapshot.
 * Everything else that differs is a mismatch; the breaker additionally needs
 * the same order to mismatch in consecutive runs (see reconciliation-breaker.ts).
 */

/** One active `spot_order` lock in the ledger. */
export interface LedgerOrderLock {
  orderId: string;
  accountId: string;
  assetCode: AssetCode;
  remainingAmount: string;
  createdAt: string;
}

/** Ledger locked balance per account + asset, split by lock type. */
export interface LedgerLockedBalance {
  accountId: string;
  assetCode: AssetCode;
  /** `balances.locked` snapshot. */
  locked: string;
  /** Sum of active non-order locks (withdrawals). */
  otherLocked: string;
}

/** Subset of order-service's OrderLockExpectation the ledger needs. */
export interface OrderLockExpectationInput {
  orderId: string;
  accountId: string;
  lockAssetCode: string;
  status: string;
  /** order-service's own estimate (open lock + fills settlement has not acknowledged). Fallback when `fills` is absent. */
  expectedLockAmount: string;
  /** Lock backing the still-open quantity. */
  openLockAmount?: string;
  /** Every fill with the lock amount it consumes. */
  fills?: Array<{ tradeId: string; amount: string }>;
  unsettledAmount?: string;
  inFlight: boolean;
  inFlightReason?: string;
  updatedAt: string;
  lastTradeAt?: string;
}

export type OrderLockMismatchReason =
  | "lock_amount_mismatch"
  | "missing_ledger_lock"
  | "orphan_ledger_lock";

export interface OrderLockDifference {
  orderId: string;
  accountId: string;
  assetCode: string;
  status?: string;
  ledgerLocked: string;
  expectedLocked: string;
  /** ledger − expected */
  difference: string;
  reason: OrderLockMismatchReason;
  /** Set when the difference is explained by timing and does not count. */
  inFlightReason?: string;
}

export interface OrderLockReconciliationItem {
  accountId: string;
  assetCode: string;
  ledgerLocked: string;
  ledgerOrderLocked: string;
  ledgerOtherLocked: string;
  orderExpectedLocked: string;
  /** ledgerOrderLocked − orderExpectedLocked, over all orders. */
  difference: string;
  /** Same difference, counting only orders that are not in flight. */
  settledDifference: string;
  orderCount: number;
  inFlightCount: number;
  mismatchCount: number;
  status: "matched" | "in_flight" | "mismatch";
}

export interface OrderLockReconciliationReport {
  generatedAt: string;
  ledgerSnapshotAt: string;
  graceMs: number;
  scannedAccountAssets: number;
  scannedOrders: number;
  matchedCount: number;
  inFlightCount: number;
  mismatchCount: number;
  /** Assets with at least one counted mismatch. */
  mismatchedAssets: string[];
  items: OrderLockReconciliationItem[];
  /** Counted mismatches (capped by `maxDifferences`). */
  mismatches: OrderLockDifference[];
  /** Differences explained by timing (capped by `maxDifferences`). */
  inFlight: OrderLockDifference[];
}

/** Idempotency key of the ledger journal that consumes a fill from an order lock. */
export function orderFillSettlementKey(orderId: string, assetCode: string, tradeId: string): string {
  return ["spot_order", orderId, assetCode, "settlement", tradeId].join(":");
}

/** Keys the ledger has to look up to know which fills it already consumed. */
export function listOrderFillSettlementKeys(expectations: OrderLockExpectationInput[]): string[] {
  return expectations.flatMap((item) =>
    (item.fills ?? []).map((fill) => orderFillSettlementKey(item.orderId, item.lockAssetCode, fill.tradeId))
  );
}

/** What the ledger lock should hold: open lock + fills not consumed in the ledger snapshot. */
export function expectedLedgerLock(item: OrderLockExpectationInput, consumedFillKeys?: ReadonlySet<string>): string {
  if (!item.fills || item.openLockAmount === undefined || !consumedFillKeys) {
    return item.expectedLockAmount;
  }
  let expected = toUnits(item.openLockAmount);
  for (const fill of item.fills) {
    if (!consumedFillKeys.has(orderFillSettlementKey(item.orderId, item.lockAssetCode, fill.tradeId))) {
      expected += toUnits(fill.amount);
    }
  }
  return fromUnits(expected);
}

export function buildOrderLockReconciliationReport(params: {
  generatedAt: string;
  ledgerSnapshotAt: string;
  locks: LedgerOrderLock[];
  lockedBalances: LedgerLockedBalance[];
  expectations: OrderLockExpectationInput[];
  /** Fill settlement keys already consumed in the ledger snapshot (see orderFillSettlementKey). */
  consumedFillKeys?: ReadonlySet<string>;
  graceMs: number;
  includeMatched?: boolean;
  maxDifferences?: number;
}): OrderLockReconciliationReport {
  const snapshotMs = Date.parse(params.ledgerSnapshotAt);
  const recentSince = snapshotMs - params.graceMs;
  const isRecent = (iso: string | undefined) => {
    if (!iso) {
      return false;
    }
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms >= recentSince;
  };
  const maxDifferences = params.maxDifferences ?? 200;

  const locksByOrder = new Map<string, LedgerOrderLock>();
  for (const lock of params.locks) {
    // (reference_type, reference_id, account, asset) is unique; one order has one lock.
    locksByOrder.set(lock.orderId, lock);
  }
  const expectationsByOrder = new Map(params.expectations.map((item) => [item.orderId, item]));
  const orderIds = new Set<string>([...locksByOrder.keys(), ...expectationsByOrder.keys()]);

  interface Rollup {
    accountId: string;
    assetCode: string;
    ledgerOrderLocked: bigint;
    orderExpectedLocked: bigint;
    settledLedger: bigint;
    settledExpected: bigint;
    orderCount: number;
    inFlightCount: number;
    mismatchCount: number;
  }
  const rollups = new Map<string, Rollup>();
  const rollupFor = (accountId: string, assetCode: string) => {
    const key = `${accountId}:${assetCode}`;
    let rollup = rollups.get(key);
    if (!rollup) {
      rollup = {
        accountId,
        assetCode,
        ledgerOrderLocked: 0n,
        orderExpectedLocked: 0n,
        settledLedger: 0n,
        settledExpected: 0n,
        orderCount: 0,
        inFlightCount: 0,
        mismatchCount: 0
      };
      rollups.set(key, rollup);
    }
    return rollup;
  };

  const mismatches: OrderLockDifference[] = [];
  const inFlight: OrderLockDifference[] = [];
  let matchedCount = 0;
  let inFlightCount = 0;
  let mismatchCount = 0;
  const mismatchedAssets = new Set<string>();

  for (const orderId of orderIds) {
    const lock = locksByOrder.get(orderId);
    const expectation = expectationsByOrder.get(orderId);
    const accountId = lock?.accountId ?? expectation?.accountId ?? "";
    const assetCode = lock?.assetCode ?? expectation?.lockAssetCode ?? "";
    const ledgerLocked = toUnits(lock?.remainingAmount ?? "0");
    const expectedLocked = toUnits(expectation ? expectedLedgerLock(expectation, params.consumedFillKeys) : "0");
    const rollup = rollupFor(accountId, assetCode);
    rollup.orderCount += 1;
    rollup.ledgerOrderLocked += ledgerLocked;
    rollup.orderExpectedLocked += expectedLocked;

    if (ledgerLocked === expectedLocked) {
      matchedCount += 1;
      rollup.settledLedger += ledgerLocked;
      rollup.settledExpected += expectedLocked;
      continue;
    }

    const reason: OrderLockMismatchReason = !lock
      ? "missing_ledger_lock"
      : !expectation
        ? "orphan_ledger_lock"
        : "lock_amount_mismatch";
    const inFlightReason = expectation?.inFlight
      ? (expectation.inFlightReason ?? "order_in_flight")
      : isRecent(expectation?.updatedAt)
        ? "order_recently_updated"
        : isRecent(expectation?.lastTradeAt)
          ? "recent_fill"
          : isRecent(lock?.createdAt)
            ? "lock_recently_created"
            : undefined;
    const difference: OrderLockDifference = {
      orderId,
      accountId,
      assetCode,
      status: expectation?.status,
      ledgerLocked: fromUnits(ledgerLocked),
      expectedLocked: fromUnits(expectedLocked),
      difference: fromUnits(ledgerLocked - expectedLocked),
      reason,
      inFlightReason
    };

    if (inFlightReason) {
      inFlightCount += 1;
      rollup.inFlightCount += 1;
      if (inFlight.length < maxDifferences) {
        inFlight.push(difference);
      }
      continue;
    }

    mismatchCount += 1;
    rollup.mismatchCount += 1;
    rollup.settledLedger += ledgerLocked;
    rollup.settledExpected += expectedLocked;
    mismatchedAssets.add(assetCode);
    if (mismatches.length < maxDifferences) {
      mismatches.push(difference);
    }
  }

  const lockedByKey = new Map(
    params.lockedBalances.map((balance) => [`${balance.accountId}:${balance.assetCode}`, balance])
  );
  for (const balance of params.lockedBalances) {
    if (toUnits(balance.locked) !== 0n || toUnits(balance.otherLocked) !== 0n) {
      rollupFor(balance.accountId, balance.assetCode);
    }
  }

  const items: OrderLockReconciliationItem[] = [];
  for (const [key, rollup] of rollups) {
    const balance = lockedByKey.get(key);
    const status: OrderLockReconciliationItem["status"] =
      rollup.mismatchCount > 0 ? "mismatch" : rollup.inFlightCount > 0 ? "in_flight" : "matched";
    if (!params.includeMatched && status === "matched") {
      continue;
    }
    items.push({
      accountId: rollup.accountId,
      assetCode: rollup.assetCode,
      ledgerLocked: balance?.locked ?? "0",
      ledgerOrderLocked: fromUnits(rollup.ledgerOrderLocked),
      ledgerOtherLocked: balance?.otherLocked ?? "0",
      orderExpectedLocked: fromUnits(rollup.orderExpectedLocked),
      difference: fromUnits(rollup.ledgerOrderLocked - rollup.orderExpectedLocked),
      settledDifference: fromUnits(rollup.settledLedger - rollup.settledExpected),
      orderCount: rollup.orderCount,
      inFlightCount: rollup.inFlightCount,
      mismatchCount: rollup.mismatchCount,
      status
    });
  }
  items.sort(
    (left, right) =>
      statusWeight(left.status) - statusWeight(right.status) ||
      left.assetCode.localeCompare(right.assetCode) ||
      left.accountId.localeCompare(right.accountId)
  );

  return {
    generatedAt: params.generatedAt,
    ledgerSnapshotAt: params.ledgerSnapshotAt,
    graceMs: params.graceMs,
    scannedAccountAssets: rollups.size,
    scannedOrders: orderIds.size,
    matchedCount,
    inFlightCount,
    mismatchCount,
    mismatchedAssets: [...mismatchedAssets].sort(),
    items,
    mismatches,
    inFlight
  };
}

function statusWeight(status: OrderLockReconciliationItem["status"]): number {
  return status === "mismatch" ? 0 : status === "in_flight" ? 1 : 2;
}

function toUnits(amount: string): bigint {
  const normalized = String(amount).trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > Number(SCALE) && /[1-9]/.test(fraction.slice(Number(SCALE)))) {
    throw new Error("Amount exceeds supported scale of 18 decimals");
  }
  const value = BigInt(whole) * BASE + BigInt(fraction.slice(0, Number(SCALE)).padEnd(Number(SCALE), "0"));
  return negative ? -value : value;
}

function fromUnits(value: bigint): string {
  if (value === 0n) {
    return "0";
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / BASE;
  const fraction = absolute % BASE;
  const rendered =
    fraction === 0n
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(Number(SCALE), "0").replace(/0+$/, "")}`;
  return negative ? `-${rendered}` : rendered;
}
