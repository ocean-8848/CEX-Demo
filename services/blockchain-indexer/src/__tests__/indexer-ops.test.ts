import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultIndexerAlertThresholds,
  evaluateIndexerAlertThresholds,
  scanConfiguredEvmNetworks
} from "../application/indexer-ops.js";

test("scanConfiguredEvmNetworks aggregates one cycle across configured networks", async () => {
  const report = await scanConfiguredEvmNetworks({
    generatedAt: "2026-03-08T10:00:00.000Z",
    networks: ["ethereum", "base"],
    async scanDeposits(network) {
      return {
        scannedBlockCount: network === "ethereum" ? 12 : 8,
        matchedObservationCount: network === "ethereum" ? 2 : 1
      };
    },
    async scanWithdrawals(network) {
      return {
        trackedTransactionCount: network === "ethereum" ? 3 : 1,
        matchedObservationCount: network === "ethereum" ? 1 : 0
      };
    }
  });

  assert.equal(report.networkCount, 2);
  assert.equal(report.failedCount, 0);
  assert.deepEqual(report.results, [
    {
      network: "ethereum",
      status: "ok",
      depositMatchedObservationCount: 2,
      withdrawalMatchedObservationCount: 1,
      depositScannedBlockCount: 12,
      trackedWithdrawalCount: 3
    },
    {
      network: "base",
      status: "ok",
      depositMatchedObservationCount: 1,
      withdrawalMatchedObservationCount: 0,
      depositScannedBlockCount: 8,
      trackedWithdrawalCount: 1
    }
  ]);
});

test("evaluateIndexerAlertThresholds returns alert when backlog and lag exceed thresholds", () => {
  const overview = evaluateIndexerAlertThresholds(
    {
      generatedAt: "2026-03-08T10:00:00.000Z",
      backlog: {
        pendingDepositCount: 3,
        pendingWithdrawalCount: 2,
        oldestPendingDepositAgeSeconds: 900,
        oldestPendingWithdrawalAgeSeconds: 800
      },
      cursors: [
        {
          observationType: "deposit",
          network: "ethereum",
          headBlock: 200,
          lastScannedBlock: 50,
          lastFinalizedBlock: 45,
          lagBlocks: 150,
          cursorAgeSeconds: 1800,
          reorgDetectedAt: "2026-03-08T09:59:00.000Z"
        }
      ],
      reorgCursorCount: 1
    },
    {
      ...defaultIndexerAlertThresholds(),
      maxPendingDeposits: 1,
      maxPendingWithdrawals: 1,
      maxOldestPendingDepositAgeSeconds: 60,
      maxOldestPendingWithdrawalAgeSeconds: 60,
      maxScanLagBlocks: 20,
      maxStaleCursorAgeSeconds: 300,
      maxReorgCursors: 0
    }
  );

  assert.equal(overview.status, "alert");
  assert.deepEqual(overview.alerts, [
    "pending_deposit_count=3 exceeds threshold 1",
    "pending_withdrawal_count=2 exceeds threshold 1",
    "oldest_pending_deposit_age_seconds=900 exceeds threshold 60",
    "oldest_pending_withdrawal_age_seconds=800 exceeds threshold 60",
    "deposit_cursor_lag_blocks:ethereum=150 exceeds threshold 20",
    "deposit_cursor_age_seconds:ethereum=1800 exceeds threshold 300",
    "reorg_cursor_count=1 exceeds threshold 0"
  ]);
});
