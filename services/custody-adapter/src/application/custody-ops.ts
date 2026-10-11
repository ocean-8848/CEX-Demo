import type { CustodyProviderRouteRuntimeSnapshot } from "./custody-provider-runtime-registry.js";

export interface CustodyTransferBacklogSummary {
  pendingSyncCount: number;
  retryableCount: number;
  failedCount: number;
  oldestPendingSyncAgeSeconds?: number;
}

export interface CustodyWorkerScheduleSnapshot {
  workerName: "provider_healthcheck" | "transfer_sync";
  enabled: boolean;
  intervalMs?: number;
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  lastErrorMessage?: string;
  lastResult?: Record<string, unknown>;
}

export interface CustodyOpsOverview {
  generatedAt: string;
  backlog: CustodyTransferBacklogSummary;
  routes: CustodyProviderRouteRuntimeSnapshot[];
  schedules: CustodyWorkerScheduleSnapshot[];
  openCircuitCount: number;
  unhealthyRouteCount: number;
  status: "ok" | "alert";
  alerts: string[];
}

export interface CustodyProviderSlaSnapshot {
  providerName: string;
  network: string;
  priority: number;
  healthStatus: CustodyProviderRouteRuntimeSnapshot["healthStatus"];
  circuitState: CustodyProviderRouteRuntimeSnapshot["circuitState"];
  transferCount: number;
  confirmedCount: number;
  failedCount: number;
  pendingCount: number;
  confirmationRate?: number;
  averageConfirmationLatencySeconds?: number;
  broadcastAttemptCount: number;
  broadcastSuccessRate?: number;
  syncAttemptCount: number;
  syncSuccessRate?: number;
  retryAttemptCount: number;
  routeSelectionCount: number;
  lastSelectionAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastHealthCheckedAt?: string;
  lastHealthLatencyMs?: number;
}

export interface CustodyOpsReport {
  generatedAt: string;
  windowHours: number;
  overview: CustodyOpsOverview;
  providerSla: CustodyProviderSlaSnapshot[];
}

export interface CustodyAlertThresholds {
  maxPendingSyncCount: number;
  maxRetryableCount: number;
  maxFailedCount: number;
  maxOldestPendingSyncAgeSeconds: number;
  maxOpenCircuitCount: number;
  maxUnhealthyRouteCount: number;
}

export function defaultCustodyAlertThresholds(): CustodyAlertThresholds {
  return {
    maxPendingSyncCount: 25,
    maxRetryableCount: 10,
    maxFailedCount: 10,
    maxOldestPendingSyncAgeSeconds: 600,
    maxOpenCircuitCount: 0,
    maxUnhealthyRouteCount: 0
  };
}

export function evaluateCustodyAlertThresholds(
  overview: Omit<CustodyOpsOverview, "status" | "alerts">,
  thresholds: CustodyAlertThresholds
): CustodyOpsOverview {
  const alerts: string[] = [];

  if (overview.backlog.pendingSyncCount > thresholds.maxPendingSyncCount) {
    alerts.push(
      `pending_sync_count=${overview.backlog.pendingSyncCount} exceeds threshold ${thresholds.maxPendingSyncCount}`
    );
  }

  if (overview.backlog.retryableCount > thresholds.maxRetryableCount) {
    alerts.push(
      `retryable_count=${overview.backlog.retryableCount} exceeds threshold ${thresholds.maxRetryableCount}`
    );
  }

  if (overview.backlog.failedCount > thresholds.maxFailedCount) {
    alerts.push(
      `failed_count=${overview.backlog.failedCount} exceeds threshold ${thresholds.maxFailedCount}`
    );
  }

  if (
    overview.backlog.oldestPendingSyncAgeSeconds !== undefined &&
    overview.backlog.oldestPendingSyncAgeSeconds > thresholds.maxOldestPendingSyncAgeSeconds
  ) {
    alerts.push(
      `oldest_pending_sync_age_seconds=${overview.backlog.oldestPendingSyncAgeSeconds} exceeds threshold ${thresholds.maxOldestPendingSyncAgeSeconds}`
    );
  }

  if (overview.openCircuitCount > thresholds.maxOpenCircuitCount) {
    alerts.push(
      `open_circuit_count=${overview.openCircuitCount} exceeds threshold ${thresholds.maxOpenCircuitCount}`
    );
  }

  if (overview.unhealthyRouteCount > thresholds.maxUnhealthyRouteCount) {
    alerts.push(
      `unhealthy_route_count=${overview.unhealthyRouteCount} exceeds threshold ${thresholds.maxUnhealthyRouteCount}`
    );
  }

  return {
    ...overview,
    status: alerts.length > 0 ? "alert" : "ok",
    alerts
  };
}
