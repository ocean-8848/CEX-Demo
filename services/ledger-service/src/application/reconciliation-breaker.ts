/**
 * Reconciliation circuit breaker (A2c): decides which assets get their
 * withdrawals paused automatically after a reconciliation run.
 *
 * - Balance reconciliation (journal net vs snapshot vs locks) reads one
 *   REPEATABLE READ snapshot, so a mismatch cannot be a timing artefact: the
 *   asset trips on the first run.
 * - Order ↔ lock reconciliation compares two services read at different
 *   moments. Timing-explained differences are already excluded; a remaining
 *   mismatch only trips when the SAME order mismatches in `confirmations`
 *   consecutive runs (default 2). A first sighting is reported as
 *   "suspected" (P2) so ops can look before anything is paused.
 *
 * Tripping pauses the asset's withdrawals through risk-service with
 * `source: "automatic"` and raises a P1 alert. Resuming is always manual.
 */

export type BreakerTripReason = "balance_mismatch" | "order_lock_mismatch";

export interface BreakerRunInput {
  /** Assets with at least one balance reconciliation mismatch. */
  balanceMismatchedAssets: string[];
  /** Counted order ↔ lock mismatches, asset → order ids. */
  orderLockMismatches: Record<string, string[]>;
}

export interface BreakerTrip {
  assetCode: string;
  reason: BreakerTripReason;
  /** Orders that mismatched in every confirming run (order-lock trips). */
  orderIds?: string[];
}

export interface BreakerSuspect {
  assetCode: string;
  orderIds: string[];
  /** How many consecutive runs (including this one) saw the oldest of these orders mismatch. */
  consecutiveRuns: number;
}

export interface BreakerDecision {
  trips: BreakerTrip[];
  suspects: BreakerSuspect[];
}

export function evaluateReconciliationBreaker(params: {
  current: BreakerRunInput;
  /** Earlier completed runs, most recent first. */
  previous: BreakerRunInput[];
  /** Consecutive runs an order ↔ lock mismatch must persist before tripping (≥ 1). */
  confirmations: number;
}): BreakerDecision {
  const confirmations = Math.max(1, Math.trunc(params.confirmations));
  const trips: BreakerTrip[] = [];
  const suspects: BreakerSuspect[] = [];
  const tripped = new Set<string>();

  for (const assetCode of [...new Set(params.current.balanceMismatchedAssets)].sort()) {
    trips.push({ assetCode, reason: "balance_mismatch" });
    tripped.add(assetCode);
  }

  for (const assetCode of Object.keys(params.current.orderLockMismatches).sort()) {
    const currentOrders = new Set(params.current.orderLockMismatches[assetCode] ?? []);
    if (currentOrders.size === 0) {
      continue;
    }
    // For each order, count how many consecutive runs (from now backwards) it mismatched in.
    let persisting = [...currentOrders];
    let streak = 1;
    for (const run of params.previous) {
      if (streak >= confirmations) {
        break;
      }
      const earlier = new Set(run.orderLockMismatches[assetCode] ?? []);
      const stillThere = persisting.filter((orderId) => earlier.has(orderId));
      if (stillThere.length === 0) {
        break;
      }
      persisting = stillThere;
      streak += 1;
    }

    if (streak >= confirmations) {
      if (!tripped.has(assetCode)) {
        trips.push({ assetCode, reason: "order_lock_mismatch", orderIds: persisting.sort() });
        tripped.add(assetCode);
      }
    } else {
      suspects.push({ assetCode, orderIds: [...currentOrders].sort(), consecutiveRuns: streak });
    }
  }

  return { trips, suspects };
}
