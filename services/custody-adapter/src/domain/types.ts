import type { AssetCode, Network } from "@web3-cex/domain";

export type CustodyTransferStatus = "accepted" | "broadcasted" | "confirmed" | "failed";
export type CustodyTransferAttemptAction = "broadcast" | "retry" | "sync_status";
export type CustodyTransferAttemptStatus = "succeeded" | "failed";
export type CustodyProviderHealthStatus = "healthy" | "degraded" | "unhealthy";
export type CustodyProviderCircuitState = "closed" | "open" | "half_open";

export interface CreateTransferCommand {
  referenceId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface RetryTransferCommand {
  custodyTransferId: string;
  requestedBy?: string;
  reason?: string;
}

export interface SyncTransferStatusCommand {
  custodyTransferId: string;
  requestedBy?: string;
  reason?: string;
}

export interface CustodyProviderHealthcheckCommand {
  network: Network;
}

export interface CustodyTransferAttemptRecord {
  attemptId: string;
  custodyTransferId: string;
  attemptNumber: number;
  action: CustodyTransferAttemptAction;
  status: CustodyTransferAttemptStatus;
  providerName: string;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
  createdAt: string;
}

export interface CustodyTransferRecord {
  custodyTransferId: string;
  referenceId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  idempotencyKey: string;
  providerName: string;
  providerTransferId?: string;
  status: CustodyTransferStatus;
  txHash?: string;
  attemptCount: number;
  nextRetryAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  broadcastedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  attempts?: CustodyTransferAttemptRecord[];
}

export interface CustodyProviderCreateTransferCommand {
  custodyTransferId: string;
  referenceId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  metadata: Record<string, unknown>;
}

export interface CustodyProviderCreateTransferResult {
  providerName: string;
  providerTransferId?: string;
  status: Extract<CustodyTransferStatus, "accepted" | "broadcasted">;
  txHash?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
}

export interface CustodyProviderTransferStatusCommand {
  custodyTransferId: string;
  referenceId: string;
  assetCode: AssetCode;
  network: Network;
  txHash?: string;
  providerTransferId?: string;
  metadata: Record<string, unknown>;
}

export interface CustodyProviderTransferStatusResult {
  providerName: string;
  providerTransferId?: string;
  status: CustodyTransferStatus;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
}

export interface CustodyProviderHealthcheckResult {
  providerName: string;
  network: Network;
  status: CustodyProviderHealthStatus;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}
