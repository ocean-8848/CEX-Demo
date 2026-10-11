import { LedgerOutboxPublisher } from "./ledger-outbox-publisher.js";
import type { LedgerRepository } from "../domain/repository.js";
import type { LedgerOutboxTransport } from "./ledger-outbox-publisher.js";

interface RemediatorOptions {
  now?: () => Date;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface DrainOutboxAlertsResult {
  requeuedCount: number;
  publishedCount: number;
  failedCount: number;
  deadLetteredCount: number;
  cycles: number;
}

export class LedgerAlertRemediator {
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: LedgerRepository,
    private readonly transport: LedgerOutboxTransport,
    options: RemediatorOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
  }

  async drainOutboxAlerts(params: {
    requeueDeadLetter?: boolean;
    maxCycles?: number;
  } = {}): Promise<DrainOutboxAlertsResult> {
    const publisher = new LedgerOutboxPublisher(this.repository, this.transport, {
      now: this.now,
      batchSize: this.batchSize,
      maxAttempts: this.maxAttempts,
      retryDelayMs: this.retryDelayMs
    });
    const requeueDeadLetter = params.requeueDeadLetter !== false;
    const maxCycles = params.maxCycles ?? 10;

    let requeuedCount = 0;
    if (requeueDeadLetter) {
      const deadLettered = await this.repository.listDeadLetteredOutboxEvents(this.batchSize);
      if (deadLettered.length > 0) {
        await this.repository.requeueOutboxEvents(
          deadLettered.map((event) => event.eventId),
          this.now().toISOString()
        );
        requeuedCount = deadLettered.length;
      }
    }

    let cycles = 0;
    let publishedCount = 0;
    let failedCount = 0;
    let deadLetteredCount = 0;

    while (cycles < maxCycles) {
      cycles += 1;
      const result = await publisher.publishPending();
      publishedCount += result.publishedCount;
      failedCount += result.failedCount;
      deadLetteredCount += result.deadLetteredCount;

      if (result.publishedCount === 0 && result.failedCount === 0 && result.deadLetteredCount === 0) {
        break;
      }
    }

    return {
      requeuedCount,
      publishedCount,
      failedCount,
      deadLetteredCount,
      cycles
    };
  }
}
