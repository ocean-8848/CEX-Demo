import type { ControlSwitchScope, ControlSwitchState } from "@web3-cex/domain";

/** risk-service `/api/v1/risk/controls` (emergency switches). */
export interface OpsControlSwitchClient {
  getState(): Promise<ControlSwitchState>;
  setSwitch(command: {
    scope: ControlSwitchScope;
    assetCode?: string;
    enabled: boolean;
    reason?: string;
    operator: string;
  }): Promise<Record<string, unknown>>;
  listEvents(limit: number): Promise<{ items: Array<Record<string, unknown>> }>;
}

/** Subset of a ledger-service reconciliation run the console reads. */
export interface OpsReconciliationRun {
  runId: string;
  trigger: string;
  status: "ok" | "suspected" | "mismatch" | "partial" | "failed" | string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  balance?: { scannedCount?: number; mismatchCount?: number; mismatchedAssets?: string[] } | null;
  orderLock?: {
    scannedOrders?: number;
    matchedCount?: number;
    inFlightCount?: number;
    mismatchCount?: number;
    mismatchedAssets?: string[];
  } | null;
  orderLockError?: string;
  breaker?: {
    enabled?: boolean;
    confirmations?: number;
    trips?: Array<{ assetCode: string; reason: string }>;
    suspects?: Array<{ assetCode: string; orderIds: string[] }>;
    actions?: Array<{ assetCode: string; reason: string; outcome: string; error?: string }>;
  };
  alerts?: Array<{ level: string; code: string; message: string }>;
  error?: string;
}

export interface OpsReconciliationJobStatus {
  enabled: boolean;
  intervalSeconds: number;
  graceMs: number;
  breakerEnabled: boolean;
  confirmations: number;
  running?: boolean;
  lastRunAt?: string;
  lastStatus?: string;
  nextRunAt?: string;
}

/** ledger-service `/api/v1/ledger/ops/reconciliation/*` (scheduled job, history, lab drift). */
export interface OpsReconciliationClient {
  listRuns(limit: number): Promise<{ job: OpsReconciliationJobStatus; items: OpsReconciliationRun[] }>;
  runNow(): Promise<OpsReconciliationRun>;
  getDrift(): Promise<Record<string, unknown>>;
  injectDrift(command: { assetCode: string; amount?: string }): Promise<Record<string, unknown>>;
  clearDrift(): Promise<Record<string, unknown>>;
}

/** Only ops_admin holds it in the default RBAC (identity-service rbac.ts). */
export const CONTROLS_MANAGE_PERMISSION = "ops.controls.manage";
