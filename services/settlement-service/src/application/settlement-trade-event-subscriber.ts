import {
  listSpotMarkets,
  compareTradeExecutedEvents,
  type SpotMarket
} from "@web3-cex/domain";
import { extractTraceContext, SpanKind, withSpan } from "@web3-cex/telemetry";

import { SettlementApplicationService } from "./settlement-application-service.js";
import type { SettlementConsumerPauseControl } from "./settlement-consumer-pause.js";
import type {
  SettlementOrderEventClient,
  SettlementTradeEventStreamEntry
} from "../domain/order-event-client.js";
import type {
  SettlementAutomationTrigger,
  SettlementEventSubscriberReport
} from "../domain/types.js";

export interface SettlementTradeEventSubscriberOptions {
  now?: () => Date;
  consumerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  overlapCount?: number;
  markets?: SpotMarket[];
  /** Fault-lab pause switch; while paused every cycle is skipped. */
  pauseControl?: SettlementConsumerPauseControl;
}

export interface RunSettlementTradeEventSubscriptionCommand {
  market?: SpotMarket;
  allowGap?: boolean;
  trigger?: SettlementAutomationTrigger;
  afterStreamEntryId?: string;
  limit?: number;
  overlapCount?: number;
}

export class SettlementTradeEventSubscriber {
  private readonly now: () => Date;
  private readonly consumerId: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly overlapCount: number;
  private readonly markets: SpotMarket[];
  private readonly pauseControl?: SettlementConsumerPauseControl;

  constructor(
    private readonly applicationService: SettlementApplicationService,
    private readonly orderEventClient: SettlementOrderEventClient,
    options: SettlementTradeEventSubscriberOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.consumerId = options.consumerId ?? "settlement-service";
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 50), 1), 500);
    this.overlapCount = Math.min(
      Math.max(Math.trunc(options.overlapCount ?? this.batchSize), 1),
      this.batchSize
    );
    this.markets =
      options.markets && options.markets.length > 0
        ? [...options.markets]
        : listSpotMarkets({ includeDelisted: true });
    this.pauseControl = options.pauseControl;
  }

  async runOnce(command: RunSettlementTradeEventSubscriptionCommand = {}) {
    if (this.pauseControl?.isPaused()) {
      // Paused by the fault lab: leave the stream and checkpoint untouched (no
      // automation history either, otherwise every poll would add a row).
      this.pauseControl.recordSkippedCycle();
      const skippedAt = this.now().toISOString();
      return {
        consumerId: this.consumerId,
        skipped: true,
        skipReason: "paused",
        pause: this.pauseControl.getState(),
        processedCount: 0,
        appliedCount: 0,
        duplicateCount: 0,
        acknowledgedCount: 0,
        failedCount: 0,
        marketSummaries: [],
        cycleStartedAt: skippedAt,
        cycleCompletedAt: skippedAt,
        cycleDurationMs: 0
      };
    }

    const cycleStartedAt = this.now();
    const markets = this.resolveMarkets(command.market);
    const marketSummaries: Array<Record<string, unknown>> = [];
    let processedCount = 0;
    let appliedCount = 0;
    let duplicateCount = 0;
    let acknowledgedCount = 0;
    let failedCount = 0;

    for (const market of markets) {
      // A pause requested mid-cycle takes effect before the next market...
      if (this.pauseControl?.isPaused()) {
        break;
      }
      const checkpoint = (
        await this.applicationService.listTradeEventConsumerCheckpoints({
          consumerId: this.consumerId,
          market,
          limit: 1,
          offset: 0
        })
      )[0];
      const resolvedLimit = Math.min(
        Math.max(Math.trunc(command.limit ?? this.batchSize), 1),
        500
      );
      const resolvedOverlapCount = Math.min(
        Math.max(Math.trunc(command.overlapCount ?? this.overlapCount), 0),
        resolvedLimit
      );
      const executionSequenceFrom = checkpoint
        ? Math.max(checkpoint.lastExecutionSequence - resolvedOverlapCount + 1, 1)
        : undefined;
      const entries = [...(
        await this.orderEventClient.listTradeEventStreamEntries({
          market,
          afterStreamEntryId: command.afterStreamEntryId ?? checkpoint?.lastStreamEntryId,
          executionSequenceFrom,
          limit: resolvedLimit,
          overlapCount: resolvedOverlapCount
        })
      )].sort((left, right) => compareTradeExecutedEvents(left.event, right.event));
      const marketSummary: Record<string, unknown> = {
        market,
        fetchedCount: entries.length,
        appliedCount: 0,
        duplicateCount: 0,
        acknowledgedCount: 0,
        failedCount: 0,
        executionSequenceFrom,
        lastExecutionSequence: checkpoint?.lastExecutionSequence,
        lastReplayCursor: checkpoint?.lastReplayCursor,
        lastStreamEntryId: checkpoint?.lastStreamEntryId
      };

      for (const entry of entries) {
        // ...and before the next entry: the checkpoint only covers what was
        // already applied, so the rest is picked up after resume.
        if (this.pauseControl?.isPaused()) {
          marketSummary.interruptedByPause = true;
          break;
        }
        try {
          const result = await this.consumeEntry(
            entry,
            command.allowGap,
            checkpoint?.lastExecutionSequence
          );
          processedCount += 1;
          marketSummary.lastExecutionSequence = result.executionSequence;
          marketSummary.lastReplayCursor = result.replayCursor;
          marketSummary.lastStreamEntryId = result.checkpoint.lastStreamEntryId;

          if (result.action === "applied") {
            appliedCount += 1;
            marketSummary.appliedCount = Number(marketSummary.appliedCount ?? 0) + 1;
          } else if (result.action === "deferred") {
            // Handed to the recovery worker; keep consuming the rest of the stream.
            failedCount += 1;
            marketSummary.deferredCount = Number(marketSummary.deferredCount ?? 0) + 1;
            marketSummary.lastError = result.error;
          } else {
            duplicateCount += 1;
            marketSummary.duplicateCount = Number(marketSummary.duplicateCount ?? 0) + 1;
          }

          if (result.settlementId) {
            await this.orderEventClient.acknowledgeTradeSettlement({
              tradeId: result.tradeId,
              settlementId: result.settlementId
            });
            acknowledgedCount += 1;
            marketSummary.acknowledgedCount = Number(marketSummary.acknowledgedCount ?? 0) + 1;
          }
        } catch (error) {
          failedCount += 1;
          marketSummary.failedCount = Number(marketSummary.failedCount ?? 0) + 1;
          marketSummary.lastError = readErrorMessage(error);
          break;
        }
      }

      marketSummaries.push(marketSummary);
    }

    const cycleCompletedAt = this.now();
    const summary = {
      consumerId: this.consumerId,
      processedCount,
      appliedCount,
      duplicateCount,
      acknowledgedCount,
      failedCount,
      marketSummaries,
      cycleStartedAt: cycleStartedAt.toISOString(),
      cycleCompletedAt: cycleCompletedAt.toISOString(),
      cycleDurationMs: cycleCompletedAt.getTime() - cycleStartedAt.getTime()
    };

    await this.applicationService.persistAutomationExecutionSafely({
      executionType: "event_subscription_cycle",
      status:
        failedCount > 0
          ? processedCount > failedCount || acknowledgedCount > 0
            ? "partial"
            : "failed"
          : "succeeded",
      trigger: command.trigger ?? "automatic",
      workerId: this.consumerId,
      market: command.market,
      targetId: command.market,
      summary,
      errorMessage: failedCount > 0 ? "trade event subscription cycle completed with failures" : undefined,
      startedAt: summary.cycleStartedAt,
      completedAt: summary.cycleCompletedAt,
      durationMs: summary.cycleDurationMs
    });

    return summary;
  }

  /**
   * Settles one stream entry. New entries continue the publisher's trace (the
   * traceparent stored next to the event in the stream), so one order shows
   * gateway, order, engine, stream and settlement spans in a single trace.
   * Overlap re-reads (already behind the checkpoint) are not traced, otherwise
   * every poll would append duplicate spans to old traces.
   */
  private async consumeEntry(
    entry: SettlementTradeEventStreamEntry,
    allowGap: boolean | undefined,
    checkpointExecutionSequence: number | undefined
  ) {
    const consume = () =>
      this.applicationService.consumeTradeExecutionEvent({
        consumerId: this.consumerId,
        event: entry.event,
        allowGap,
        streamEntryId: entry.streamEntryId,
        streamPublishedAt: entry.publishedAt
      });
    const alreadyCheckpointed =
      checkpointExecutionSequence !== undefined &&
      entry.executionSequence <= checkpointExecutionSequence;
    if (!entry.traceparent || alreadyCheckpointed) {
      return consume();
    }

    return withSpan(
      `${entry.streamKey} process`,
      {
        "messaging.system": "redis_stream",
        "messaging.operation.type": "process",
        "messaging.destination.name": entry.streamKey,
        "messaging.message.id": entry.streamEntryId,
        "messaging.consumer.group.name": this.consumerId,
        market: entry.market,
        "trade.execution_sequence": entry.executionSequence
      },
      async (span) => {
        const result = await consume();
        span.setAttribute("settlement.action", result.action);
        return result;
      },
      {
        kind: SpanKind.CONSUMER,
        parent: extractTraceContext({ traceparent: entry.traceparent })
      }
    );
  }

  async runForever(onCycle?: (summary: Record<string, unknown>) => void): Promise<never> {
    for (;;) {
      const summary = await this.runOnce({
        trigger: "automatic"
      });
      onCycle?.({
        ...summary,
        processedAt: this.now().toISOString()
      });
      await sleep(this.pollIntervalMs);
    }
  }

  async getReport(
    mode: SettlementEventSubscriberReport["mode"] = "redis_stream"
  ): Promise<SettlementEventSubscriberReport> {
    const [latestCycle] = await this.applicationService.listAutomationExecutions({
      executionType: "event_subscription_cycle",
      limit: 1,
      offset: 0
    });

    return {
      enabled: mode !== "disabled",
      mode,
      consumerId: this.consumerId,
      batchSize: this.batchSize,
      overlapCount: this.overlapCount,
      pollIntervalMs: this.pollIntervalMs,
      markets: [...this.markets],
      latestCycle,
      pause: this.pauseControl?.getState()
    };
  }

  getConsumerId(): string {
    return this.consumerId;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  private resolveMarkets(market?: SpotMarket): SpotMarket[] {
    if (market) {
      return [market];
    }

    return [...this.markets];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown settlement event subscription error";
}
