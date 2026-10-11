import type { CustodyRepository } from "../domain/repository.js";
import type {
  CustodyTransferAttemptRecord,
  CustodyTransferRecord
} from "../domain/types.js";

export class InMemoryCustodyRepository implements CustodyRepository {
  private readonly transfersById = new Map<string, CustodyTransferRecord>();
  private readonly transfersByIdempotencyKey = new Map<string, CustodyTransferRecord>();
  private readonly attemptsByTransferId = new Map<string, CustodyTransferAttemptRecord[]>();

  async withTransaction<T>(operation: (repository: CustodyRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async saveTransfer(record: CustodyTransferRecord): Promise<void> {
    this.transfersById.set(record.custodyTransferId, record);
    this.transfersByIdempotencyKey.set(record.idempotencyKey, record);
  }

  async saveTransferAttempt(record: CustodyTransferAttemptRecord): Promise<void> {
    const existing = this.attemptsByTransferId.get(record.custodyTransferId) ?? [];
    this.attemptsByTransferId.set(record.custodyTransferId, [...existing, record]);
  }

  async findTransferById(custodyTransferId: string): Promise<CustodyTransferRecord | null> {
    return this.transfersById.get(custodyTransferId) ?? null;
  }

  async findTransferByIdempotencyKey(idempotencyKey: string): Promise<CustodyTransferRecord | null> {
    return this.transfersByIdempotencyKey.get(idempotencyKey) ?? null;
  }

  async listTransfersNeedingStatusSync(
    limit: number,
    syncedBefore: string
  ): Promise<CustodyTransferRecord[]> {
    return [...this.transfersById.values()]
      .filter(
        (transfer) =>
          (transfer.status === "accepted" || transfer.status === "broadcasted") &&
          (!transfer.lastSyncedAt || transfer.lastSyncedAt <= syncedBefore)
      )
      .sort((left, right) =>
        (left.lastSyncedAt ?? left.createdAt).localeCompare(right.lastSyncedAt ?? right.createdAt)
      )
      .slice(0, limit);
  }

  async listRetryableTransfers(limit: number, now: string): Promise<CustodyTransferRecord[]> {
    return [...this.transfersById.values()]
      .filter(
        (transfer) =>
          transfer.status === "failed" &&
          !!transfer.nextRetryAt &&
          transfer.nextRetryAt <= now
      )
      .sort((left, right) => (left.nextRetryAt ?? "").localeCompare(right.nextRetryAt ?? ""))
      .slice(0, limit);
  }

  async listTransferAttempts(custodyTransferId: string): Promise<CustodyTransferAttemptRecord[]> {
    return this.attemptsByTransferId.get(custodyTransferId) ?? [];
  }
}
