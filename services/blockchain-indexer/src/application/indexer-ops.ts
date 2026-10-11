import type { EvmNetwork } from "../domain/evm-client.js";

export interface ScheduledScanCycleNetworkResult {
  network: EvmNetwork;
  status: "ok" | "error";
  depositMatchedObservationCount?: number;
  withdrawalMatchedObservationCount?: number;
  depositScannedBlockCount?: number;
  trackedWithdrawalCount?: number;
  errorMessage?: string;
}

export interface ScheduledScanCycleReport {
  generatedAt: string;
  networkCount: number;
  failedCount: number;
  results: ScheduledScanCycleNetworkResult[];
}

export interface IndexerCursorHealth {
  observationType: "deposit" | "withdrawal";
  network: EvmNetwork;
  headBlock?: number;
  lastScannedBlock?: number;
  lastFinalizedBlock?: number;
  lagBlocks?: number;
  cursorAgeSeconds?: number;
  reorgDetectedAt?: string;
}

export interface IndexerObservationBacklogSummary {
  pendingDepositCount: number;
  pendingWithdrawalCount: number;
  oldestPendingDepositAgeSeconds?: number;
  oldestPendingWithdrawalAgeSeconds?: number;
}

export interface IndexerOpsOverview {
  generatedAt: string;
  cursors: IndexerCursorHealth[];
  backlog: IndexerObservationBacklogSummary;
  reorgCursorCount: number;
  status: "ok" | "alert";
  alerts: string[];
}

export interface IndexerAlertThresholds {
  maxPendingDeposits: number;
  maxPendingWithdrawals: number;
  maxOldestPendingDepositAgeSeconds: number;
  maxOldestPendingWithdrawalAgeSeconds: number;
  maxScanLagBlocks: number;
  maxStaleCursorAgeSeconds: number;
  maxReorgCursors: number;
}

export async function scanConfiguredEvmNetworks(params: {
  generatedAt?: string;
  networks: EvmNetwork[];
  scanDeposits: (network: EvmNetwork) => Promise<{
    scannedBlockCount: number;
    matchedObservationCount: number;
  }>;
  scanWithdrawals: (network: EvmNetwork) => Promise<{
    trackedTransactionCount: number;
    matchedObservationCount: number;
  }>;
}): Promise<ScheduledScanCycleReport> {
  const results: ScheduledScanCycleNetworkResult[] = [];

  for (const network of params.networks) {
    try {
      const [depositResult, withdrawalResult] = await Promise.all([
        params.scanDeposits(network),
        params.scanWithdrawals(network)
      ]);

      results.push({
        network,
        status: "ok",
        depositMatchedObservationCount: depositResult.matchedObservationCount,
        withdrawalMatchedObservationCount: withdrawalResult.matchedObservationCount,
        depositScannedBlockCount: depositResult.scannedBlockCount,
        trackedWithdrawalCount: withdrawalResult.trackedTransactionCount
      });
    } catch (error) {
      results.push({
        network,
        status: "error",
        errorMessage: error instanceof Error ? error.message : "unknown scan error"
      });
    }
  }

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    networkCount: params.networks.length,
    failedCount: results.filter((result) => result.status === "error").length,
    results
  };
}

export function defaultIndexerAlertThresholds(): IndexerAlertThresholds {
  return {
    maxPendingDeposits: 50,
    maxPendingWithdrawals: 50,
    maxOldestPendingDepositAgeSeconds: 600,
    maxOldestPendingWithdrawalAgeSeconds: 600,
    maxScanLagBlocks: 100,
    maxStaleCursorAgeSeconds: 900,
    maxReorgCursors: 0
  };
}

export function evaluateIndexerAlertThresholds(
  overview: Omit<IndexerOpsOverview, "status" | "alerts">,
  thresholds: IndexerAlertThresholds
): IndexerOpsOverview {
  const alerts: string[] = [];

  if (overview.backlog.pendingDepositCount > thresholds.maxPendingDeposits) {
    alerts.push(
      `pending_deposit_count=${overview.backlog.pendingDepositCount} exceeds threshold ${thresholds.maxPendingDeposits}`
    );
  }

  if (overview.backlog.pendingWithdrawalCount > thresholds.maxPendingWithdrawals) {
    alerts.push(
      `pending_withdrawal_count=${overview.backlog.pendingWithdrawalCount} exceeds threshold ${thresholds.maxPendingWithdrawals}`
    );
  }

  if (
    overview.backlog.oldestPendingDepositAgeSeconds !== undefined &&
    overview.backlog.oldestPendingDepositAgeSeconds >
      thresholds.maxOldestPendingDepositAgeSeconds
  ) {
    alerts.push(
      `oldest_pending_deposit_age_seconds=${overview.backlog.oldestPendingDepositAgeSeconds} exceeds threshold ${thresholds.maxOldestPendingDepositAgeSeconds}`
    );
  }

  if (
    overview.backlog.oldestPendingWithdrawalAgeSeconds !== undefined &&
    overview.backlog.oldestPendingWithdrawalAgeSeconds >
      thresholds.maxOldestPendingWithdrawalAgeSeconds
  ) {
    alerts.push(
      `oldest_pending_withdrawal_age_seconds=${overview.backlog.oldestPendingWithdrawalAgeSeconds} exceeds threshold ${thresholds.maxOldestPendingWithdrawalAgeSeconds}`
    );
  }

  for (const cursor of overview.cursors) {
    if (cursor.lagBlocks !== undefined && cursor.lagBlocks > thresholds.maxScanLagBlocks) {
      alerts.push(
        `${cursor.observationType}_cursor_lag_blocks:${cursor.network}=${cursor.lagBlocks} exceeds threshold ${thresholds.maxScanLagBlocks}`
      );
    }

    if (
      cursor.cursorAgeSeconds !== undefined &&
      cursor.cursorAgeSeconds > thresholds.maxStaleCursorAgeSeconds
    ) {
      alerts.push(
        `${cursor.observationType}_cursor_age_seconds:${cursor.network}=${cursor.cursorAgeSeconds} exceeds threshold ${thresholds.maxStaleCursorAgeSeconds}`
      );
    }
  }

  if (overview.reorgCursorCount > thresholds.maxReorgCursors) {
    alerts.push(
      `reorg_cursor_count=${overview.reorgCursorCount} exceeds threshold ${thresholds.maxReorgCursors}`
    );
  }

  return {
    ...overview,
    status: alerts.length > 0 ? "alert" : "ok",
    alerts
  };
}
