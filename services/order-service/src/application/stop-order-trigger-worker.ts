import { listSpotMarkets, type SpotMarket } from "@web3-cex/domain";

import type { OrderApplicationService } from "./order-application-service.js";

interface StopOrderTriggerWorkerOptions {
  /** Poll interval; 0 disables the timer (triggering can still be run manually). */
  pollIntervalMs: number;
  listMarkets?: () => SpotMarket[];
}

/**
 * Drives stop-order triggering from the last trade price. Every tick it looks
 * at each market's pending_trigger orders and the latest persisted trade (the
 * same trades order-service publishes as trade.executed events). Orders and
 * their trigger state live in PostgreSQL, so pending stops survive restarts;
 * the compare-and-set inside triggerStopOrders keeps triggering idempotent.
 */
export class StopOrderTriggerWorker {
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<unknown> | null = null;
  private lastRunAt?: string;
  private lastError?: string;
  private triggeredCount = 0;
  /** Markets whose crossed triggers are currently held (halted market / API write freeze). */
  private readonly heldMarkets = new Map<string, string>();

  constructor(
    private readonly applicationService: Pick<OrderApplicationService, "triggerStopOrders">,
    private readonly options: StopOrderTriggerWorkerOptions
  ) {}

  start(): void {
    if (this.options.pollIntervalMs <= 0 || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over all markets; overlapping ticks are skipped. */
  async runOnce(): Promise<Array<{ market: SpotMarket; lastPrice?: string; triggeredOrderIds: string[] }>> {
    if (this.inFlight) {
      return [];
    }
    const run = this.runAllMarkets();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  getStatus() {
    return {
      pollIntervalMs: this.options.pollIntervalMs,
      running: Boolean(this.timer),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      triggeredCount: this.triggeredCount,
      heldMarkets: Object.fromEntries(this.heldMarkets)
    };
  }

  private async runAllMarkets() {
    const markets = this.options.listMarkets?.() ?? listSpotMarkets();
    const results = [];
    for (const market of markets) {
      try {
        const result = await this.applicationService.triggerStopOrders(market);
        this.triggeredCount += result.triggeredOrderIds.length;
        if (result.heldReason) {
          this.heldMarkets.set(market, result.heldReason);
        } else {
          this.heldMarkets.delete(market);
        }
        results.push(result);
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.lastRunAt = new Date().toISOString();
    return results;
  }
}
