import type {
  CustodyTransferAttemptRecord,
  CustodyTransferRecord
} from "./types.js";

export interface CustodyRepository {
  withTransaction<T>(operation: (repository: CustodyRepository) => Promise<T>): Promise<T>;
  saveTransfer(record: CustodyTransferRecord): Promise<void>;
  saveTransferAttempt(record: CustodyTransferAttemptRecord): Promise<void>;
  findTransferById(custodyTransferId: string): Promise<CustodyTransferRecord | null>;
  findTransferByIdempotencyKey(idempotencyKey: string): Promise<CustodyTransferRecord | null>;
  listTransfersNeedingStatusSync(limit: number, syncedBefore: string): Promise<CustodyTransferRecord[]>;
  listRetryableTransfers(limit: number, now: string): Promise<CustodyTransferRecord[]>;
  listTransferAttempts(custodyTransferId: string): Promise<CustodyTransferAttemptRecord[]>;
}
