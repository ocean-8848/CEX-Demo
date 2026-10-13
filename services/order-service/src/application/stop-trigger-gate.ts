import {
  CachedControlSwitchReader,
  createHttpControlSwitchLoader,
  type ControlSwitchReader,
  type SpotMarket
} from "@web3-cex/domain";

import { buildInternalServiceHeaders } from "../infrastructure/internal-service-request.js";

/**
 * Stop orders already passed risk when they were placed, so the trigger
 * worker does not go through risk validation again. It must still respect the
 * same stop conditions as new orders: while the market is halted / delisted or
 * the API write freeze (emergency switch) is on, a crossed trigger is HELD —
 * the order stays `pending_trigger` with its funds frozen — and fires on the
 * first tick after the condition clears. Nothing is rejected.
 */
export type StopTriggerHoldReason = "market_halted" | "market_delisted" | "api_write_frozen";

export interface StopTriggerGate {
  check(market: SpotMarket): Promise<{ hold: boolean; reason?: StopTriggerHoldReason }>;
}

export function evaluateStopTriggerHold(input: {
  marketStatus?: string;
  apiWriteFrozen: boolean;
}): { hold: boolean; reason?: StopTriggerHoldReason } {
  if (input.apiWriteFrozen) {
    return { hold: true, reason: "api_write_frozen" };
  }
  if (input.marketStatus === "halted") {
    return { hold: true, reason: "market_halted" };
  }
  if (input.marketStatus === "delisted") {
    return { hold: true, reason: "market_delisted" };
  }
  return { hold: false };
}

const MARKETS_PATH = "/api/v1/risk/markets";

/**
 * Reads the effective market status and the emergency switches from
 * risk-service (both cached, default 2s). On a failed refresh the last known
 * state is used; before anything was ever loaded the gate is open, matching
 * the other switch consumers.
 */
export class RiskStopTriggerGate implements StopTriggerGate {
  private readonly switches: ControlSwitchReader;
  private markets: { statuses: Map<string, string>; expiresAt: number } | null = null;
  private lastKnownStatuses = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly options: { cacheMs?: number } = {}
  ) {
    this.switches = new CachedControlSwitchReader(
      createHttpControlSwitchLoader({ baseUrl, callerName: "order-service" }),
      {
        cacheMs: options.cacheMs ?? 2000,
        onError: (error) => console.warn(`[order-service] control switches unavailable: ${readMessage(error)}`)
      }
    );
  }

  async check(market: SpotMarket) {
    const [state, statuses] = await Promise.all([this.switches.getState(), this.loadStatuses()]);
    return evaluateStopTriggerHold({ marketStatus: statuses.get(market), apiWriteFrozen: Boolean(state.apiWriteFrozen) });
  }

  private async loadStatuses(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.markets && this.markets.expiresAt > now) {
      return this.markets.statuses;
    }
    try {
      const response = await fetch(`${this.baseUrl}${MARKETS_PATH}`, {
        headers: buildInternalServiceHeaders({ method: "GET", path: MARKETS_PATH }),
        signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) {
        throw new Error(`risk-service markets responded ${response.status}`);
      }
      const payload = (await response.json()) as Array<{ market?: string; status?: string }>;
      const statuses = new Map(
        payload
          .filter((item) => typeof item.market === "string" && typeof item.status === "string")
          .map((item) => [item.market as string, item.status as string])
      );
      this.lastKnownStatuses = statuses;
      this.markets = { statuses, expiresAt: now + (this.options.cacheMs ?? 2000) };
      return statuses;
    } catch (error) {
      console.warn(`[order-service] market status unavailable for stop triggers: ${readMessage(error)}`);
      this.markets = { statuses: this.lastKnownStatuses, expiresAt: now + 1000 };
      return this.lastKnownStatuses;
    }
  }
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
