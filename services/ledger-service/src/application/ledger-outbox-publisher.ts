import type { LedgerRepository } from "../domain/repository.js";
import type { OutboxEventRecord } from "../domain/types.js";

export interface LedgerOutboxTransport {
  publish(events: OutboxEventRecord[]): Promise<void>;
  publishDeadLetter?(params: {
    event: OutboxEventRecord;
    errorMessage: string;
    deadLetteredAt: string;
  }): Promise<void>;
}

interface PublisherOptions {
  batchSize?: number;
  now?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class LedgerOutboxPublisher {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: LedgerRepository,
    private readonly transport: LedgerOutboxTransport,
    options: PublisherOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
  }

  async publishPending(limit = this.batchSize): Promise<{
    publishedCount: number;
    failedCount: number;
    deadLetteredCount: number;
    eventIds: string[];
  }> {
    const now = this.now().toISOString();
    const events = await this.repository.listPendingOutboxEvents(limit, now);
    if (events.length === 0) {
      return {
        publishedCount: 0,
        failedCount: 0,
        deadLetteredCount: 0,
        eventIds: []
      };
    }

    const publishedEventIds: string[] = [];
    let failedCount = 0;
    let deadLetteredCount = 0;

    for (const event of events) {
      try {
        await this.transport.publish([event]);
        await this.repository.markOutboxEventsPublished([event.eventId], now);
        publishedEventIds.push(event.eventId);
      } catch (error) {
        failedCount += 1;
        const errorMessage =
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown outbox publish error";
        const attempts = event.publishAttempts + 1;

        if (attempts >= this.maxAttempts) {
          deadLetteredCount += 1;
          await this.repository.recordOutboxEventFailure({
            eventId: event.eventId,
            attemptedAt: now,
            errorMessage,
            deadLetteredAt: now
          });

          if (this.transport.publishDeadLetter) {
            try {
              await this.transport.publishDeadLetter({
                event,
                errorMessage,
                deadLetteredAt: now
              });
            } catch {
              // Dead-letter publishing is best-effort; the database flag remains the source of truth.
            }
          }
        } else {
          await this.repository.recordOutboxEventFailure({
            eventId: event.eventId,
            attemptedAt: now,
            errorMessage,
            nextAttemptAt: new Date(this.now().getTime() + this.retryDelayMs * attempts).toISOString()
          });
        }
      }
    }

    return {
      publishedCount: publishedEventIds.length,
      failedCount,
      deadLetteredCount,
      eventIds: publishedEventIds
    };
  }
}
