import type { AssetCode, Network } from "@web3-cex/domain";

export interface CreateTransferRequestDto {
  referenceId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface RetryTransferRequestDto {
  requestedBy?: string;
  reason?: string;
}

export interface SyncTransferStatusRequestDto {
  requestedBy?: string;
  reason?: string;
}

export interface InjectFaultRequestDto {
  providerName?: string;
  durationSeconds?: number | string;
  reason?: string;
  requestedBy?: string;
}

export interface ClearFaultInjectionRequestDto {
  providerName?: string;
}

export interface ProbeBroadcastRequestDto {
  network?: string;
  count?: number | string;
}
