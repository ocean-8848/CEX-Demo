import { randomUUID } from "node:crypto";

import { CustodyError } from "../domain/errors.js";
import type { CustodyProvider, CustodyProviderResolver } from "../domain/provider.js";
import type { CustodyRepository } from "../domain/repository.js";
import type {
  CreateTransferCommand,
  CustodyTransferAttemptAction,
  CustodyTransferAttemptRecord,
  CustodyTransferRecord,
  RetryTransferCommand,
  SyncTransferStatusCommand
} from "../domain/types.js";
import type { CustodyProviderRuntimeRegistry } from "./custody-provider-runtime-registry.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  maxBroadcastAttempts?: number;
  retryDelayMs?: number;
  runtimeRegistry?: CustodyProviderRuntimeRegistry;
}

export class CustodyApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxBroadcastAttempts: number;
  private readonly retryDelayMs: number;
  private readonly providerResolver: CustodyProviderResolver;
  private readonly runtimeRegistry?: CustodyProviderRuntimeRegistry;

  constructor(
    private readonly repository: CustodyRepository,
    providerOrResolver: CustodyProvider | CustodyProviderResolver,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxBroadcastAttempts = options.maxBroadcastAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
    this.providerResolver = toProviderResolver(providerOrResolver);
    this.runtimeRegistry = options.runtimeRegistry;
  }

  async createTransfer(command: CreateTransferCommand): Promise<CustodyTransferRecord> {
    this.assertTransferAmounts(command.amount, command.fee);

    const existing = await this.repository.findTransferByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return this.getRequiredTransfer(existing.custodyTransferId);
    }

    const provider = this.providerResolver.selectProviderForCreate(command);
    const now = this.now().toISOString();
    const baseRecord: CustodyTransferRecord = {
      custodyTransferId: this.createId(),
      referenceId: command.referenceId,
      assetCode: command.assetCode,
      network: command.network,
      toAddress: command.toAddress,
      amount: command.amount,
      fee: command.fee,
      idempotencyKey: command.idempotencyKey,
      providerName: provider.providerName,
      status: "accepted",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: command.metadata ?? {}
    };

    await this.repository.saveTransfer(baseRecord);
    return this.broadcastTransfer(baseRecord, command, "broadcast", provider);
  }

  async retryTransfer(command: RetryTransferCommand): Promise<CustodyTransferRecord> {
    const transfer = await this.getRequiredTransfer(command.custodyTransferId);

    if (transfer.status === "confirmed") {
      throw new CustodyError(
        "TRANSFER_ALREADY_FINALIZED",
        `Transfer ${transfer.custodyTransferId} is already confirmed`
      );
    }

    if (transfer.status === "broadcasted") {
      throw new CustodyError(
        "TRANSFER_RETRY_NOT_ALLOWED",
        `Transfer ${transfer.custodyTransferId} has already been broadcasted`
      );
    }

    if (transfer.attemptCount >= this.maxBroadcastAttempts) {
      throw new CustodyError(
        "TRANSFER_RETRY_NOT_ALLOWED",
        `Transfer ${transfer.custodyTransferId} exhausted max broadcast attempts`
      );
    }

    const provider = this.providerResolver.selectProviderForRetry(transfer);

    return this.broadcastTransfer(
      transfer,
      {
        referenceId: transfer.referenceId,
        assetCode: transfer.assetCode,
        network: transfer.network,
        toAddress: transfer.toAddress,
        amount: transfer.amount,
        fee: transfer.fee,
        idempotencyKey: transfer.idempotencyKey,
        metadata: {
          ...transfer.metadata,
          retry: {
            requestedBy: command.requestedBy,
            reason: command.reason,
            retriedAt: this.now().toISOString()
          }
        }
      },
      "retry",
      provider
    );
  }

  async syncTransferStatus(command: SyncTransferStatusCommand): Promise<CustodyTransferRecord> {
    const transfer = await this.getRequiredTransfer(command.custodyTransferId);

    if (!transfer.txHash && !transfer.providerTransferId) {
      throw new CustodyError(
        "PROVIDER_STATUS_SYNC_FAILED",
        `Transfer ${transfer.custodyTransferId} does not have a provider reference yet`
      );
    }

    const now = this.now().toISOString();
    const provider = this.providerResolver.getProviderByName(transfer.providerName);
    const startedAt = this.now().getTime();

    try {
      const result = await provider.getTransferStatus({
        custodyTransferId: transfer.custodyTransferId,
        referenceId: transfer.referenceId,
        assetCode: transfer.assetCode,
        network: transfer.network,
        txHash: transfer.txHash,
        providerTransferId: transfer.providerTransferId,
        metadata: transfer.metadata
      });

      const nextStatus =
        transfer.status === "confirmed" ? "confirmed" : result.status;
      const updatedTransfer: CustodyTransferRecord = {
        ...transfer,
        providerName: result.providerName,
        providerTransferId: result.providerTransferId ?? transfer.providerTransferId,
        status: nextStatus,
        txHash: result.txHash ?? transfer.txHash,
        lastErrorCode: result.errorCode,
        lastErrorMessage: result.errorMessage,
        broadcastedAt:
          transfer.broadcastedAt ??
          (nextStatus === "broadcasted" || nextStatus === "confirmed" ? now : undefined),
        confirmedAt: nextStatus === "confirmed" ? transfer.confirmedAt ?? now : transfer.confirmedAt,
        failedAt: nextStatus === "failed" ? transfer.failedAt ?? now : transfer.failedAt,
        lastSyncedAt: now,
        nextRetryAt: nextStatus === "failed" ? transfer.nextRetryAt : undefined,
        updatedAt: now
      };

      await this.repository.withTransaction(async (repository) => {
        await repository.saveTransfer(updatedTransfer);
        await repository.saveTransferAttempt(
          this.buildAttemptRecord({
            transfer: updatedTransfer,
            attemptNumber: transfer.attemptCount === 0 ? 1 : transfer.attemptCount,
            action: "sync_status",
            status: "succeeded",
            txHash: updatedTransfer.txHash,
            requestPayload: result.requestPayload ?? {
              txHash: transfer.txHash,
              providerTransferId: transfer.providerTransferId
            },
            responsePayload: result.responsePayload ?? {
              status: updatedTransfer.status
            }
          })
        );
      });

      this.runtimeRegistry?.recordOperationResult({
        providerName: updatedTransfer.providerName,
        network: updatedTransfer.network,
        operation: "sync_status",
        success: true,
        latencyMs: this.now().getTime() - startedAt
      });

      return this.getRequiredTransfer(updatedTransfer.custodyTransferId);
    } catch (error) {
      const custodyError = toCustodyError(
        error,
        "PROVIDER_STATUS_SYNC_FAILED",
        "Failed to sync custody transfer status"
      );

      await this.repository.saveTransferAttempt(
        this.buildAttemptRecord({
          transfer,
          attemptNumber: transfer.attemptCount === 0 ? 1 : transfer.attemptCount,
          action: "sync_status",
          status: "failed",
          txHash: transfer.txHash,
          errorCode: custodyError.code,
          errorMessage: custodyError.message,
          requestPayload: {
            txHash: transfer.txHash,
            providerTransferId: transfer.providerTransferId
          },
          responsePayload: {}
        })
      );

      this.runtimeRegistry?.recordOperationResult({
        providerName: transfer.providerName,
        network: transfer.network,
        operation: "sync_status",
        success: false,
        latencyMs: this.now().getTime() - startedAt,
        errorCode: custodyError.code,
        errorMessage: custodyError.message
      });

      throw custodyError;
    }
  }

  async getTransfer(custodyTransferId: string): Promise<CustodyTransferRecord | null> {
    const transfer = await this.repository.findTransferById(custodyTransferId);
    if (!transfer) {
      return null;
    }

    return {
      ...transfer,
      attempts: await this.repository.listTransferAttempts(custodyTransferId)
    };
  }

  private async getRequiredTransfer(custodyTransferId: string): Promise<CustodyTransferRecord> {
    const transfer = await this.getTransfer(custodyTransferId);

    if (!transfer) {
      throw new CustodyError(
        "TRANSFER_NOT_FOUND",
        `Transfer ${custodyTransferId} not found`
      );
    }

    return transfer;
  }

  private async broadcastTransfer(
    existingTransfer: CustodyTransferRecord,
    command: CreateTransferCommand,
    action: Extract<CustodyTransferAttemptAction, "broadcast" | "retry">,
    provider: CustodyProvider
  ): Promise<CustodyTransferRecord> {
    const attemptNumber = existingTransfer.attemptCount + 1;
    const now = this.now().toISOString();
    const startedAt = this.now().getTime();

    try {
      const result = await provider.createTransfer({
        custodyTransferId: existingTransfer.custodyTransferId,
        referenceId: command.referenceId,
        assetCode: command.assetCode,
        network: command.network,
        toAddress: command.toAddress,
        amount: command.amount,
        fee: command.fee,
        metadata: command.metadata ?? {}
      });

      const broadcastedTransfer: CustodyTransferRecord = {
        ...existingTransfer,
        providerName: result.providerName,
        providerTransferId: result.providerTransferId ?? existingTransfer.providerTransferId,
        status: result.status,
        txHash: result.txHash ?? existingTransfer.txHash,
        attemptCount: attemptNumber,
        nextRetryAt: undefined,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        broadcastedAt:
          existingTransfer.broadcastedAt ??
          (result.status === "broadcasted" ? now : undefined),
        failedAt: undefined,
        lastSyncedAt: now,
        updatedAt: now,
        metadata: command.metadata ?? existingTransfer.metadata
      };

      await this.repository.withTransaction(async (repository) => {
        await repository.saveTransfer(broadcastedTransfer);
        await repository.saveTransferAttempt(
          this.buildAttemptRecord({
            transfer: broadcastedTransfer,
            attemptNumber,
            action,
            status: "succeeded",
            txHash: broadcastedTransfer.txHash,
            requestPayload: result.requestPayload ?? {
              referenceId: command.referenceId,
              assetCode: command.assetCode,
              network: command.network,
              toAddress: command.toAddress,
              amount: command.amount,
              fee: command.fee
            },
            responsePayload: result.responsePayload ?? {
              status: result.status,
              txHash: result.txHash
            }
          })
        );
      });

      this.runtimeRegistry?.recordOperationResult({
        providerName: broadcastedTransfer.providerName,
        network: broadcastedTransfer.network,
        operation: action,
        success: true,
        latencyMs: this.now().getTime() - startedAt
      });

      return this.getRequiredTransfer(existingTransfer.custodyTransferId);
    } catch (error) {
      const custodyError = toCustodyError(
        error,
        "PROVIDER_BROADCAST_FAILED",
        "Failed to broadcast custody transfer"
      );
      const failedTransfer: CustodyTransferRecord = {
        ...existingTransfer,
        attemptCount: attemptNumber,
        status: "failed",
        lastErrorCode: custodyError.code,
        lastErrorMessage: custodyError.message,
        failedAt: now,
        nextRetryAt:
          attemptNumber < this.maxBroadcastAttempts
            ? new Date(this.now().getTime() + attemptNumber * this.retryDelayMs).toISOString()
            : undefined,
        updatedAt: now,
        metadata: command.metadata ?? existingTransfer.metadata
      };

      await this.repository.withTransaction(async (repository) => {
        await repository.saveTransfer(failedTransfer);
        await repository.saveTransferAttempt(
          this.buildAttemptRecord({
            transfer: failedTransfer,
            attemptNumber,
            action,
            status: "failed",
            errorCode: custodyError.code,
            errorMessage: custodyError.message,
            requestPayload: {
              referenceId: command.referenceId,
              assetCode: command.assetCode,
              network: command.network,
              toAddress: command.toAddress,
              amount: command.amount,
              fee: command.fee
            },
            responsePayload: {}
          })
        );
      });

      this.runtimeRegistry?.recordOperationResult({
        providerName: provider.providerName,
        network: existingTransfer.network,
        operation: action,
        success: false,
        latencyMs: this.now().getTime() - startedAt,
        errorCode: custodyError.code,
        errorMessage: custodyError.message
      });

      throw custodyError;
    }
  }

  private buildAttemptRecord(input: {
    transfer: CustodyTransferRecord;
    attemptNumber: number;
    action: CustodyTransferAttemptAction;
    status: CustodyTransferAttemptRecord["status"];
    txHash?: string;
    errorCode?: string;
    errorMessage?: string;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): CustodyTransferAttemptRecord {
    return {
      attemptId: this.createId(),
      custodyTransferId: input.transfer.custodyTransferId,
      attemptNumber: input.attemptNumber,
      action: input.action,
      status: input.status,
      providerName: input.transfer.providerName,
      txHash: input.txHash,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      requestPayload: input.requestPayload,
      responsePayload: input.responsePayload,
      createdAt: this.now().toISOString()
    };
  }

  private assertTransferAmounts(amount: string, fee: string): void {
    if (Number(amount) <= 0 || Number(fee) < 0) {
      throw new CustodyError(
        "INVALID_AMOUNT",
        "Transfer amount must be greater than zero and fee must be positive or zero"
      );
    }
  }
}

function toProviderResolver(
  providerOrResolver: CustodyProvider | CustodyProviderResolver
): CustodyProviderResolver {
  if ("selectProviderForCreate" in providerOrResolver) {
    return providerOrResolver;
  }

  return {
    selectProviderForCreate() {
      return providerOrResolver;
    },
    selectProviderForRetry() {
      return providerOrResolver;
    },
    getProviderByName() {
      return providerOrResolver;
    },
    listProviderRoutes() {
      return [];
    }
  };
}

function toCustodyError(
  error: unknown,
  fallbackCode: CustodyError["code"],
  fallbackMessage: string
): CustodyError {
  if (error instanceof CustodyError) {
    return error;
  }

  return new CustodyError(
    fallbackCode,
    error instanceof Error ? error.message : fallbackMessage
  );
}
