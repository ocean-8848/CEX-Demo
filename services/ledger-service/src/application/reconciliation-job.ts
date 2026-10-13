import type { AssetCode } from "@web3-cex/domain";

import type { LedgerBalanceReconciliationReport } from "./ledger-ops.js";
import {
  buildOrderLockReconciliationReport,
  type LedgerLockedBalance,
  type LedgerOrderLock,
  type OrderLockDifference,
  type OrderLockExpectationInput,
  type OrderLockReconciliationItem
} from "./order-lock-reconciliation.js";
import {
  evaluateReconciliationBreaker,
  type BreakerRunInput,
  type BreakerSuspect,
  type BreakerTrip
} from "./reconciliation-breaker.js";

/**
 * Scheduled reconciliation (A2b): every RECONCILIATION_INTERVAL_SECONDS the
 * ledger-service runs
 *   1. balance reconciliation (journal net vs balance snapshot vs active locks),
 *   2. order ↔ lock reconciliation against order-service,
 * stores the result in `ledger_reconciliation_runs`, and feeds the circuit
 * breaker, which pauses an asset's withdrawals through risk-service.
 */

export type ReconciliationTrigger = "scheduled" | "manual";
export type ReconciliationRunStatus = "ok" | "suspected" | "mismatch" | "partial" | "failed";
export type ReconciliationAlertLevel = "P1" | "P2" | "P3";

export interface ReconciliationBalanceSection {
  scannedCount: number;
  mismatchCount: number;
  mismatchedAssets: string[];
  mismatches: Array<{
    accountId: string;
    assetCode: string;
    accountType?: string;
    mismatchReasons: string[];
    snapshotTotal: string;
    expectedTotal: string;
    snapshotLocked: string;
    expectedLocked: string;
  }>;
}

export interface ReconciliationOrderLockSection {
  ledgerSnapshotAt: string;
  graceMs: number;
  scannedOrders: number;
  scannedAccountAssets: number;
  matchedCount: number;
  inFlightCount: number;
  mismatchCount: number;
  mismatchedAssets: string[];
  /** asset → order ids that counted as mismatches (input for the breaker's confirmation). */
  mismatchesByAsset: Record<string, string[]>;
  mismatches: OrderLockDifference[];
  inFlight: OrderLockDifference[];
  items: OrderLockReconciliationItem[];
}

export interface ReconciliationBreakerAction {
  assetCode: string;
  reason: BreakerTrip["reason"];
  outcome: "paused" | "already_paused" | "failed" | "disabled";
  error?: string;
}

export interface ReconciliationRunRecord {
  runId: string;
  trigger: ReconciliationTrigger;
  status: ReconciliationRunStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  balance: ReconciliationBalanceSection | null;
  orderLock: ReconciliationOrderLockSection | null;
  orderLockError?: string;
  breaker: {
    enabled: boolean;
    confirmations: number;
    trips: BreakerTrip[];
    suspects: BreakerSuspect[];
    actions: ReconciliationBreakerAction[];
  };
  alerts: Array<{ level: ReconciliationAlertLevel; code: string; message: string }>;
  error?: string;
}

export interface ReconciliationRunRepository {
  save(run: ReconciliationRunRecord): Promise<void>;
  /** Most recent first. */
  list(limit: number): Promise<ReconciliationRunRecord[]>;
}

export interface ReconciliationLedgerReader {
  reconcileBalances(params: { includeMatched?: boolean; generatedAt?: string }): Promise<LedgerBalanceReconciliationReport>;
  collectOrderLockSnapshot(): Promise<{
    snapshotAt: string;
    locks: LedgerOrderLock[];
    lockedBalances: LedgerLockedBalance[];
  }>;
}

export interface OrderLockExpectationClient {
  /** Open / in-flight orders plus the given ids. */
  getLockExpectations(orderIds: string[]): Promise<OrderLockExpectationInput[]>;
}

export interface WithdrawalPauseClient {
  pauseAssetWithdrawals(command: { assetCode: string; reason: string }): Promise<{ changed: boolean }>;
}

export interface ReconciliationJobConfig {
  /** 0 = no scheduled runs (manual runs still work). */
  intervalSeconds: number;
  graceMs: number;
  breakerEnabled: boolean;
  confirmations: number;
}

export interface ReconciliationJobStatus extends ReconciliationJobConfig {
  enabled: boolean;
  running: boolean;
  lastRunAt?: string;
  lastStatus?: ReconciliationRunStatus;
  nextRunAt?: string;
}

const MAX_STORED_DIFFERENCES = 50;

export class ReconciliationJob {
  private running: Promise<ReconciliationRunRecord> | null = null;
  private lastRun?: { at: string; status: ReconciliationRunStatus };
  private nextRunAt?: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly deps: {
      ledger: ReconciliationLedgerReader;
      orders?: OrderLockExpectationClient;
      withdrawals?: WithdrawalPauseClient;
      runs: ReconciliationRunRepository;
      config: ReconciliationJobConfig;
      now?: () => Date;
      createId?: () => string;
      log?: (level: "info" | "warn" | "error", message: string) => void;
    }
  ) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? (() => crypto.randomUUID());
  }

  get config(): ReconciliationJobConfig {
    return this.deps.config;
  }

  setNextRunAt(at: string | undefined): void {
    this.nextRunAt = at;
  }

  getStatus(): ReconciliationJobStatus {
    return {
      ...this.deps.config,
      enabled: this.deps.config.intervalSeconds > 0,
      running: this.running !== null,
      lastRunAt: this.lastRun?.at,
      lastStatus: this.lastRun?.status,
      nextRunAt: this.nextRunAt
    };
  }

  /** Runs once; a call while a run is in progress joins that run. */
  runOnce(trigger: ReconciliationTrigger): Promise<ReconciliationRunRecord> {
    if (!this.running) {
      this.running = this.execute(trigger).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async execute(trigger: ReconciliationTrigger): Promise<ReconciliationRunRecord> {
    const started = this.now();
    const run: ReconciliationRunRecord = {
      runId: this.createId(),
      trigger,
      status: "ok",
      startedAt: started.toISOString(),
      completedAt: started.toISOString(),
      durationMs: 0,
      balance: null,
      orderLock: null,
      breaker: {
        enabled: this.deps.config.breakerEnabled,
        confirmations: this.deps.config.confirmations,
        trips: [],
        suspects: [],
        actions: []
      },
      alerts: []
    };

    try {
      run.balance = summarizeBalance(
        await this.deps.ledger.reconcileBalances({ includeMatched: false, generatedAt: run.startedAt })
      );
    } catch (error) {
      run.status = "failed";
      run.error = readMessage(error);
      run.alerts.push({ level: "P2", code: "RECONCILIATION_FAILED", message: `balance reconciliation failed: ${run.error}` });
      return this.finish(run, started);
    }

    if (this.deps.orders) {
      try {
        const snapshot = await this.deps.ledger.collectOrderLockSnapshot();
        const expectations = await this.deps.orders.getLockExpectations(snapshot.locks.map((lock) => lock.orderId));
        run.orderLock = summarizeOrderLock(
          buildOrderLockReconciliationReport({
            generatedAt: this.now().toISOString(),
            ledgerSnapshotAt: snapshot.snapshotAt,
            locks: snapshot.locks,
            lockedBalances: snapshot.lockedBalances,
            expectations,
            graceMs: this.deps.config.graceMs,
            maxDifferences: MAX_STORED_DIFFERENCES
          })
        );
      } catch (error) {
        run.orderLockError = readMessage(error);
      }
    } else {
      run.orderLockError = "order-service client is not configured";
    }

    const previous = await this.deps.runs.list(Math.max(this.deps.config.confirmations, 1) + 2).catch(() => []);
    const decision = evaluateReconciliationBreaker({
      current: toBreakerInput(run),
      previous: previous.filter((item) => item.status !== "failed").map(toBreakerInput),
      confirmations: this.deps.config.confirmations
    });
    run.breaker.trips = decision.trips;
    run.breaker.suspects = decision.suspects;

    for (const trip of decision.trips) {
      run.breaker.actions.push(await this.applyTrip(run, trip));
    }

    const balanceMismatches = run.balance?.mismatchCount ?? 0;
    const orderMismatches = run.orderLock?.mismatchCount ?? 0;
    if (decision.trips.length > 0) {
      run.status = "mismatch";
    } else if (decision.suspects.length > 0 || orderMismatches > 0) {
      run.status = "suspected";
    } else if (run.orderLockError) {
      run.status = "partial";
    }

    if (balanceMismatches > 0) {
      run.alerts.push({
        level: "P1",
        code: "BALANCE_RECONCILIATION_MISMATCH",
        message: `balance reconciliation found ${balanceMismatches} mismatches (${run.balance?.mismatchedAssets.join(", ")})`
      });
    }
    for (const trip of decision.trips.filter((item) => item.reason === "order_lock_mismatch")) {
      run.alerts.push({
        level: "P1",
        code: "ORDER_LOCK_MISMATCH_CONFIRMED",
        message: `${trip.assetCode}: order locks differ from open orders in ${this.deps.config.confirmations} consecutive runs (${trip.orderIds?.length ?? 0} orders)`
      });
    }
    for (const action of run.breaker.actions) {
      if (action.outcome === "paused" || action.outcome === "already_paused") {
        run.alerts.push({
          level: "P1",
          code: "RECONCILIATION_BREAKER_TRIPPED",
          message: `${action.assetCode} withdrawals paused automatically (${action.reason})`
        });
      } else if (action.outcome === "failed") {
        run.alerts.push({
          level: "P1",
          code: "RECONCILIATION_BREAKER_FAILED",
          message: `could not pause ${action.assetCode} withdrawals: ${action.error ?? "unknown error"}`
        });
      }
    }
    for (const suspect of decision.suspects) {
      run.alerts.push({
        level: "P2",
        code: "ORDER_LOCK_MISMATCH_SUSPECTED",
        message: `${suspect.assetCode}: ${suspect.orderIds.length} order locks differ (run ${suspect.consecutiveRuns}/${this.deps.config.confirmations} before the breaker trips)`
      });
    }
    if (run.orderLockError) {
      run.alerts.push({ level: "P2", code: "ORDER_LOCK_RECONCILIATION_UNAVAILABLE", message: run.orderLockError });
    }

    return this.finish(run, started);
  }

  private async applyTrip(run: ReconciliationRunRecord, trip: BreakerTrip): Promise<ReconciliationBreakerAction> {
    if (!this.deps.config.breakerEnabled) {
      return { assetCode: trip.assetCode, reason: trip.reason, outcome: "disabled" };
    }
    if (!this.deps.withdrawals) {
      return { assetCode: trip.assetCode, reason: trip.reason, outcome: "failed", error: "risk-service client is not configured" };
    }
    const reason =
      trip.reason === "balance_mismatch"
        ? `对账熔断：${trip.assetCode} 余额对账不平（run ${run.runId}）`
        : `对账熔断：${trip.assetCode} 委托冻结与账本冻结连续 ${this.deps.config.confirmations} 轮不一致（run ${run.runId}）`;
    try {
      const result = await this.deps.withdrawals.pauseAssetWithdrawals({ assetCode: trip.assetCode, reason });
      if (result.changed) {
        this.deps.log?.("error", `[P1] reconciliation breaker paused ${trip.assetCode} withdrawals: ${reason}`);
      }
      return { assetCode: trip.assetCode, reason: trip.reason, outcome: result.changed ? "paused" : "already_paused" };
    } catch (error) {
      this.deps.log?.("error", `[P1] reconciliation breaker could not pause ${trip.assetCode}: ${readMessage(error)}`);
      return { assetCode: trip.assetCode, reason: trip.reason, outcome: "failed", error: readMessage(error) };
    }
  }

  private async finish(run: ReconciliationRunRecord, started: Date): Promise<ReconciliationRunRecord> {
    const completed = this.now();
    run.completedAt = completed.toISOString();
    run.durationMs = Math.max(completed.getTime() - started.getTime(), 0);
    try {
      await this.deps.runs.save(run);
    } catch (error) {
      this.deps.log?.("warn", `could not store reconciliation run ${run.runId}: ${readMessage(error)}`);
    }
    this.lastRun = { at: run.completedAt, status: run.status };
    if (run.status !== "ok") {
      this.deps.log?.(run.status === "mismatch" ? "error" : "warn", `reconciliation run ${run.runId}: ${run.status}`);
    }
    return run;
  }
}

function summarizeBalance(report: LedgerBalanceReconciliationReport): ReconciliationBalanceSection {
  const mismatched = report.items.filter((item) => item.mismatchReasons.length > 0);
  return {
    scannedCount: report.scannedCount,
    mismatchCount: report.mismatchCount,
    mismatchedAssets: [...new Set(mismatched.map((item) => item.assetCode as string))].sort(),
    mismatches: mismatched.slice(0, MAX_STORED_DIFFERENCES).map((item) => ({
      accountId: item.accountId,
      assetCode: item.assetCode as AssetCode,
      accountType: item.accountType,
      mismatchReasons: item.mismatchReasons,
      snapshotTotal: item.snapshotTotal,
      expectedTotal: item.expectedTotal,
      snapshotLocked: item.snapshotLocked,
      expectedLocked: item.expectedLocked
    }))
  };
}

function summarizeOrderLock(report: ReturnType<typeof buildOrderLockReconciliationReport>): ReconciliationOrderLockSection {
  const mismatchesByAsset: Record<string, string[]> = {};
  for (const item of report.mismatches) {
    (mismatchesByAsset[item.assetCode] ??= []).push(item.orderId);
  }
  return {
    ledgerSnapshotAt: report.ledgerSnapshotAt,
    graceMs: report.graceMs,
    scannedOrders: report.scannedOrders,
    scannedAccountAssets: report.scannedAccountAssets,
    matchedCount: report.matchedCount,
    inFlightCount: report.inFlightCount,
    mismatchCount: report.mismatchCount,
    mismatchedAssets: report.mismatchedAssets,
    mismatchesByAsset,
    mismatches: report.mismatches.slice(0, MAX_STORED_DIFFERENCES),
    inFlight: report.inFlight.slice(0, MAX_STORED_DIFFERENCES),
    items: report.items.slice(0, MAX_STORED_DIFFERENCES)
  };
}

function toBreakerInput(run: Pick<ReconciliationRunRecord, "balance" | "orderLock">): BreakerRunInput {
  return {
    balanceMismatchedAssets: run.balance?.mismatchedAssets ?? [],
    orderLockMismatches: run.orderLock?.mismatchesByAsset ?? {}
  };
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
