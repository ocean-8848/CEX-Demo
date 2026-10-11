import type { AssetCode } from "@web3-cex/domain";

const SCALE = 18n;
const BASE = 10n ** SCALE;

export interface LedgerBalanceAggregate {
  accountId: string;
  assetCode: AssetCode;
  accountType?: string;
  available: string;
  locked: string;
  updatedAt?: string;
}

export interface LedgerEntryNetAggregate {
  accountId: string;
  assetCode: AssetCode;
  netAmount: string;
  entryCount: number;
  lastEntryAt?: string;
}

export interface LedgerActiveLockAggregate {
  accountId: string;
  assetCode: AssetCode;
  lockedAmount: string;
  lockCount: number;
  oldestLockedAt?: string;
}

export interface LedgerBalanceReconciliationItem {
  accountId: string;
  assetCode: AssetCode;
  accountType?: string;
  entryCount: number;
  lockCount: number;
  journalNet: string;
  activeLocked: string;
  expectedAvailable: string;
  expectedLocked: string;
  snapshotAvailable: string;
  snapshotLocked: string;
  snapshotTotal: string;
  expectedTotal: string;
  mismatchReasons: string[];
}

export interface LedgerBalanceReconciliationReport {
  generatedAt: string;
  scannedCount: number;
  matchedCount: number;
  mismatchCount: number;
  items: LedgerBalanceReconciliationItem[];
}

export interface LedgerReplayEntryEvent {
  entryId: string;
  journalId: string;
  direction: "debit" | "credit";
  amount: string;
  referenceType: string;
  referenceId: string;
  createdAt: string;
  businessType?: string;
  businessId?: string;
  description?: string;
}

export interface LedgerReplayLockEvent {
  lockId: string;
  amount: string;
  referenceType: string;
  referenceId: string;
  status: "locked" | "released" | "consumed" | "settled";
  createdAt: string;
  releasedAt?: string;
  consumedAt?: string;
}

/** One lock adjustment with its real amount (from the ledger's balance events). */
export interface LedgerReplayLockAdjustment {
  at: string;
  type: "lock" | "release" | "consume" | "settle";
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface LedgerReplayStep {
  at: string;
  type: "entry_credit" | "entry_debit" | "lock" | "release" | "consume" | "settle";
  amount: string;
  referenceType: string;
  referenceId: string;
  journalId?: string;
  entryId?: string;
  businessType?: string;
  businessId?: string;
  description?: string;
  availableAfter: string;
  lockedAfter: string;
}

export interface LedgerAccountReplayReport {
  generatedAt: string;
  accountId: string;
  assetCode: AssetCode;
  snapshotAvailable: string;
  snapshotLocked: string;
  reconstructedAvailable: string;
  reconstructedLocked: string;
  mismatch: boolean;
  steps: LedgerReplayStep[];
}

type LedgerReplayComputationStep = Omit<
  LedgerReplayStep,
  "availableAfter" | "lockedAfter"
>;

export interface LedgerOpsOutboxSummary {
  pendingCount: number;
  retryingCount: number;
  deadLetteredCount: number;
  oldestPendingAgeSeconds?: number;
}

export interface LedgerOpsLockSummary {
  activeCount: number;
  staleCount: number;
  oldestActiveAgeSeconds?: number;
  staleThresholdMinutes: number;
}

export interface LedgerOpsReconciliationSummary {
  scannedCount: number;
  mismatchCount: number;
  negativeAvailableCount: number;
  negativeLockedCount: number;
}

export interface LedgerOpsOverview {
  generatedAt: string;
  outbox: LedgerOpsOutboxSummary;
  locks: LedgerOpsLockSummary;
  reconciliation: LedgerOpsReconciliationSummary;
  status: "ok" | "alert";
  alerts: string[];
}

export interface LedgerAlertThresholds {
  maxPendingOutbox: number;
  maxRetryingOutbox: number;
  maxDeadLetteredOutbox: number;
  maxOldestPendingOutboxAgeSeconds: number;
  staleLockMinutes: number;
  maxStaleLocks: number;
  maxBalanceMismatches: number;
  maxNegativeAvailableBalances: number;
  maxNegativeLockedBalances: number;
}

export function buildBalanceReconciliationReport(params: {
  generatedAt: string;
  balances: LedgerBalanceAggregate[];
  entryNets: LedgerEntryNetAggregate[];
  activeLocks: LedgerActiveLockAggregate[];
  includeMatched?: boolean;
}): LedgerBalanceReconciliationReport {
  const keys = new Set<string>();
  const balancesByKey = new Map<string, LedgerBalanceAggregate>();
  const entryNetsByKey = new Map<string, LedgerEntryNetAggregate>();
  const locksByKey = new Map<string, LedgerActiveLockAggregate>();

  for (const balance of params.balances) {
    const key = toKey(balance.accountId, balance.assetCode);
    keys.add(key);
    balancesByKey.set(key, balance);
  }

  for (const entryNet of params.entryNets) {
    const key = toKey(entryNet.accountId, entryNet.assetCode);
    keys.add(key);
    entryNetsByKey.set(key, entryNet);
  }

  for (const lock of params.activeLocks) {
    const key = toKey(lock.accountId, lock.assetCode);
    keys.add(key);
    locksByKey.set(key, lock);
  }

  const items: LedgerBalanceReconciliationItem[] = [];

  for (const key of keys) {
    const balance = balancesByKey.get(key);
    const entryNet = entryNetsByKey.get(key);
    const lock = locksByKey.get(key);

    const snapshotAvailable = balance?.available ?? "0";
    const snapshotLocked = balance?.locked ?? "0";
    const journalNet = entryNet?.netAmount ?? "0";
    const activeLocked = lock?.lockedAmount ?? "0";
    const expectedAvailable = fromSignedAtomicUnits(
      toSignedAtomicUnits(journalNet) - toSignedAtomicUnits(activeLocked)
    );
    const expectedLocked = activeLocked;
    const snapshotTotal = fromSignedAtomicUnits(
      toSignedAtomicUnits(snapshotAvailable) + toSignedAtomicUnits(snapshotLocked)
    );
    const expectedTotal = journalNet;
    const mismatchReasons: string[] = [];

    if (compareSignedAmounts(snapshotAvailable, expectedAvailable) !== 0) {
      mismatchReasons.push("available_mismatch");
    }

    if (compareSignedAmounts(snapshotLocked, expectedLocked) !== 0) {
      mismatchReasons.push("locked_mismatch");
    }

    if (compareSignedAmounts(snapshotTotal, expectedTotal) !== 0) {
      mismatchReasons.push("total_mismatch");
    }

    const item: LedgerBalanceReconciliationItem = {
      accountId: balance?.accountId ?? entryNet?.accountId ?? lock?.accountId ?? "",
      assetCode: balance?.assetCode ?? entryNet?.assetCode ?? lock?.assetCode ?? "USDT",
      accountType: balance?.accountType,
      entryCount: entryNet?.entryCount ?? 0,
      lockCount: lock?.lockCount ?? 0,
      journalNet,
      activeLocked,
      expectedAvailable,
      expectedLocked,
      snapshotAvailable,
      snapshotLocked,
      snapshotTotal,
      expectedTotal,
      mismatchReasons
    };

    if (params.includeMatched || mismatchReasons.length > 0) {
      items.push(item);
    }
  }

  const mismatchCount = items.filter((item) => item.mismatchReasons.length > 0).length;
  const scannedCount = keys.size;

  return {
    generatedAt: params.generatedAt,
    scannedCount,
    matchedCount: scannedCount - mismatchCount,
    mismatchCount,
    items
  };
}

export function buildAccountReplayReport(params: {
  generatedAt: string;
  accountId: string;
  assetCode: AssetCode;
  snapshotAvailable: string;
  snapshotLocked: string;
  entries: LedgerReplayEntryEvent[];
  locks: LedgerReplayLockEvent[];
  /**
   * Preferred source: every lock / partial release / consumption with its real
   * amount. Lock rows only keep the original amount and final timestamps, so
   * they cannot describe partial releases or settled consumptions.
   */
  lockAdjustments?: LedgerReplayLockAdjustment[];
}): LedgerAccountReplayReport {
  const entrySteps: LedgerReplayComputationStep[] = params.entries.map((entry) => ({
    at: entry.createdAt,
    type: entry.direction === "credit" ? "entry_credit" : "entry_debit",
    amount: entry.amount,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    journalId: entry.journalId,
    entryId: entry.entryId,
    businessType: entry.businessType,
    businessId: entry.businessId,
    description: entry.description
  }));
  const steps: LedgerReplayComputationStep[] = [
    ...entrySteps,
    ...(params.lockAdjustments ?? expandLockEvents(params.locks))
  ].sort(compareReplayEvents);

  let available = 0n;
  let locked = 0n;
  const replaySteps: LedgerReplayStep[] = [];

  for (const step of steps) {
    const amount = toSignedAtomicUnits(step.amount);

    switch (step.type) {
      case "entry_credit":
        available += amount;
        break;
      case "entry_debit":
        available -= amount;
        break;
      case "lock":
        available -= amount;
        locked += amount;
        break;
      case "release":
        available += amount;
        locked -= amount;
        break;
      case "consume":
        locked -= amount;
        break;
      case "settle":
        // Unlock; the matching settlement journal debit records the outflow.
        locked -= amount;
        available += amount;
        break;
      default:
        break;
    }

    replaySteps.push({
      ...step,
      availableAfter: fromSignedAtomicUnits(available),
      lockedAfter: fromSignedAtomicUnits(locked)
    });
  }

  const reconstructedAvailable = fromSignedAtomicUnits(available);
  const reconstructedLocked = fromSignedAtomicUnits(locked);

  return {
    generatedAt: params.generatedAt,
    accountId: params.accountId,
    assetCode: params.assetCode,
    snapshotAvailable: params.snapshotAvailable,
    snapshotLocked: params.snapshotLocked,
    reconstructedAvailable,
    reconstructedLocked,
    mismatch:
      compareSignedAmounts(reconstructedAvailable, params.snapshotAvailable) !== 0 ||
      compareSignedAmounts(reconstructedLocked, params.snapshotLocked) !== 0,
    steps: replaySteps
  };
}

export function evaluateLedgerAlertThresholds(
  overview: Omit<LedgerOpsOverview, "status" | "alerts">,
  thresholds: LedgerAlertThresholds
): LedgerOpsOverview {
  const alerts: string[] = [];

  if (overview.outbox.pendingCount > thresholds.maxPendingOutbox) {
    alerts.push(
      `pending_outbox_count=${overview.outbox.pendingCount} exceeds threshold ${thresholds.maxPendingOutbox}`
    );
  }

  if (overview.outbox.retryingCount > thresholds.maxRetryingOutbox) {
    alerts.push(
      `retrying_outbox_count=${overview.outbox.retryingCount} exceeds threshold ${thresholds.maxRetryingOutbox}`
    );
  }

  if (overview.outbox.deadLetteredCount > thresholds.maxDeadLetteredOutbox) {
    alerts.push(
      `dead_lettered_outbox_count=${overview.outbox.deadLetteredCount} exceeds threshold ${thresholds.maxDeadLetteredOutbox}`
    );
  }

  if (
    overview.outbox.oldestPendingAgeSeconds !== undefined &&
    overview.outbox.oldestPendingAgeSeconds > thresholds.maxOldestPendingOutboxAgeSeconds
  ) {
    alerts.push(
      `oldest_pending_outbox_age_seconds=${overview.outbox.oldestPendingAgeSeconds} exceeds threshold ${thresholds.maxOldestPendingOutboxAgeSeconds}`
    );
  }

  if (overview.locks.staleCount > thresholds.maxStaleLocks) {
    alerts.push(
      `stale_locked_balance_count=${overview.locks.staleCount} exceeds threshold ${thresholds.maxStaleLocks}`
    );
  }

  if (overview.reconciliation.mismatchCount > thresholds.maxBalanceMismatches) {
    alerts.push(
      `balance_mismatch_count=${overview.reconciliation.mismatchCount} exceeds threshold ${thresholds.maxBalanceMismatches}`
    );
  }

  if (
    overview.reconciliation.negativeAvailableCount > thresholds.maxNegativeAvailableBalances
  ) {
    alerts.push(
      `negative_available_balance_count=${overview.reconciliation.negativeAvailableCount} exceeds threshold ${thresholds.maxNegativeAvailableBalances}`
    );
  }

  if (overview.reconciliation.negativeLockedCount > thresholds.maxNegativeLockedBalances) {
    alerts.push(
      `negative_locked_balance_count=${overview.reconciliation.negativeLockedCount} exceeds threshold ${thresholds.maxNegativeLockedBalances}`
    );
  }

  return {
    ...overview,
    status: alerts.length > 0 ? "alert" : "ok",
    alerts
  };
}

export function defaultLedgerAlertThresholds(
  staleLockMinutes = 30
): LedgerAlertThresholds {
  return {
    maxPendingOutbox: 100,
    maxRetryingOutbox: 20,
    maxDeadLetteredOutbox: 0,
    maxOldestPendingOutboxAgeSeconds: 300,
    staleLockMinutes,
    maxStaleLocks: 0,
    maxBalanceMismatches: 0,
    maxNegativeAvailableBalances: 0,
    maxNegativeLockedBalances: 0
  };
}

function toKey(accountId: string, assetCode: AssetCode): string {
  return `${accountId}:${assetCode}`;
}

function compareReplayEvents(
  left: Pick<LedgerReplayComputationStep, "at" | "type">,
  right: Pick<LedgerReplayComputationStep, "at" | "type">
): number {
  if (left.at !== right.at) {
    return left.at.localeCompare(right.at);
  }

  return replayTypeWeight(left.type) - replayTypeWeight(right.type);
}

function replayTypeWeight(type: LedgerReplayStep["type"]): number {
  switch (type) {
    case "entry_credit":
    case "entry_debit":
      return 10;
    case "lock":
      return 20;
    case "release":
      return 30;
    case "consume":
    case "settle":
      return 40;
    default:
      return 99;
  }
}

function expandLockEvents(locks: LedgerReplayLockEvent[]): LedgerReplayComputationStep[] {
  const events: LedgerReplayComputationStep[] = [];

  for (const lock of locks) {
    events.push({
      at: lock.createdAt,
      type: "lock",
      amount: lock.amount,
      referenceType: lock.referenceType,
      referenceId: lock.referenceId
    });

    if (lock.releasedAt) {
      events.push({
        at: lock.releasedAt,
        type: "release",
        amount: lock.amount,
        referenceType: lock.referenceType,
        referenceId: lock.referenceId
      });
    }

    if (lock.consumedAt) {
      events.push({
        at: lock.consumedAt,
        type: "consume",
        amount: lock.amount,
        referenceType: lock.referenceType,
        referenceId: lock.referenceId
      });
    }
  }

  return events;
}

function normalizeFraction(fraction: string): string {
  if (fraction.length > Number(SCALE)) {
    throw new Error("Amount exceeds supported scale of 18 decimals");
  }

  return fraction.padEnd(Number(SCALE), "0");
}

function toSignedAtomicUnits(amount: string): bigint {
  const normalized = amount.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid signed decimal amount: ${amount}`);
  }

  const [whole = "0", fraction = ""] = unsigned.split(".");
  const value = BigInt(whole) * BASE + BigInt(normalizeFraction(fraction));
  return negative ? -value : value;
}

function fromSignedAtomicUnits(value: bigint): string {
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
      : `${whole.toString()}.${fraction
          .toString()
          .padStart(Number(SCALE), "0")
          .replace(/0+$/, "")}`;

  return negative ? `-${rendered}` : rendered;
}

function compareSignedAmounts(left: string, right: string): number {
  const diff = toSignedAtomicUnits(left) - toSignedAtomicUnits(right);
  if (diff === 0n) {
    return 0;
  }

  return diff > 0n ? 1 : -1;
}
