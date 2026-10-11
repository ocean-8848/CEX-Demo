import type { CustodyApplicationService } from "./custody-application-service.js";
import type { CustodyRepository } from "../domain/repository.js";

interface WorkerOptions {
  batchSize?: number;
  now?: () => Date;
  syncIntervalMs?: number;
}

export class CustodyTransferSyncWorker {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly syncIntervalMs: number;

  constructor(
    private readonly repository: CustodyRepository,
    private readonly applicationService: CustodyApplicationService,
    options: WorkerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.now = options.now ?? (() => new Date());
    this.syncIntervalMs = options.syncIntervalMs ?? 30_000;
  }

  async runOnce(): Promise<{
    retriedCount: number;
    syncedCount: number;
    failedCount: number;
    transferIds: string[];
  }> {
    const now = this.now().toISOString();
    const syncedBefore = new Date(this.now().getTime() - this.syncIntervalMs).toISOString();
    const retryableTransfers = await this.repository.listRetryableTransfers(this.batchSize, now);
    const syncableTransfers = await this.repository.listTransfersNeedingStatusSync(
      this.batchSize,
      syncedBefore
    );

    let retriedCount = 0;
    let syncedCount = 0;
    let failedCount = 0;
    const transferIds: string[] = [];

    for (const transfer of retryableTransfers) {
      try {
        const retried = await this.applicationService.retryTransfer({
          custodyTransferId: transfer.custodyTransferId,
          requestedBy: "system:custody-sync-worker",
          reason: "scheduled retry"
        });
        retriedCount += 1;
        transferIds.push(retried.custodyTransferId);
      } catch {
        failedCount += 1;
      }
    }

    for (const transfer of syncableTransfers) {
      try {
        const synced = await this.applicationService.syncTransferStatus({
          custodyTransferId: transfer.custodyTransferId,
          requestedBy: "system:custody-sync-worker",
          reason: "scheduled sync"
        });
        syncedCount += 1;
        transferIds.push(synced.custodyTransferId);
      } catch {
        failedCount += 1;
      }
    }

    return {
      retriedCount,
      syncedCount,
      failedCount,
      transferIds
    };
  }
}
