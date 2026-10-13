import { compareAmounts } from "./decimal.js";
import type { OrderSide, OrderType } from "./index.js";

/**
 * Self-trade prevention: what the matching engine does when an incoming order
 * would match a resting order of the same account.
 * - expire_taker (default): keep the resting order, expire the incoming rest
 * - expire_maker: cancel the own resting order(s) and keep matching
 * - expire_both: cancel the own resting order and expire the incoming rest
 */
export type StpMode = "expire_taker" | "expire_maker" | "expire_both";

export const STP_MODES: readonly StpMode[] = ["expire_taker", "expire_maker", "expire_both"];
export const DEFAULT_STP_MODE: StpMode = "expire_taker";

export function isStpMode(value: unknown): value is StpMode {
  return typeof value === "string" && (STP_MODES as readonly string[]).includes(value);
}

export function isStopOrderType(type: OrderType | string): type is "stop_limit" | "stop_market" {
  return type === "stop_limit" || type === "stop_market";
}

/** Order type the matching engine sees once a stop order has triggered. */
export function engineOrderType(type: OrderType): "limit" | "market" {
  return type === "limit" || type === "stop_limit" ? "limit" : "market";
}

/** Whether a stop order triggers at `lastPrice` (buy: >=, sell: <=). */
export function isStopTriggered(
  side: OrderSide,
  triggerPrice: string,
  lastPrice: string
): boolean {
  const comparison = compareAmounts(lastPrice, triggerPrice);
  return side === "buy" ? comparison >= 0 : comparison <= 0;
}

