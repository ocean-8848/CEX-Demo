import type { AssetCode } from "@web3-cex/domain";

import { addAmounts, compareAmounts, subtractAmounts } from "../domain/money.js";
import type {
  AccountStatement,
  AccountStatementQuery,
  BalanceSnapshot,
  StatementAction,
  StatementBalance,
  StatementCategory,
  StatementEntrySource,
  StatementLine,
  StatementLockEventSource
} from "../domain/types.js";

/**
 * Business types of journals posted by `consumeBalance`: the debit moves a
 * previously locked amount into a settlement account, so it reduces `locked`
 * (not `available`). Spot-order locks are journaled as
 * "spot_order_lock_settled"; older trade data still carries
 * "withdrawal_settled" with referenceType = spot_order, so both count.
 */
const LOCK_SETTLEMENT_BUSINESS_TYPES = new Set(["withdrawal_settled", "spot_order_lock_settled"]);

type StatementLineDraft = Omit<StatementLine, "balanceAfter">;

/**
 * Builds the customer statement of one account from its full history:
 * journal entries (money in / out) merged with balance lock events (freeze /
 * release, which only move money between available and locked).
 *
 * Running balances are replayed from zero in chronological order and only
 * exposed for an asset when the replay ends exactly on the current balance
 * snapshot, so a learner never sees a "resulting balance" the ledger cannot
 * prove.
 */
export function buildAccountStatement(params: {
  query: AccountStatementQuery;
  entries: StatementEntrySource[];
  lockEvents: StatementLockEventSource[];
  /** Current snapshots of the account, used to verify the replay. */
  balances: BalanceSnapshot[];
  limit: number;
  offset: number;
}): AccountStatement {
  const { query } = params;
  const drafts: StatementLineDraft[] = [
    ...params.entries.map(entryToLine),
    ...params.lockEvents.map(lockEventToLine).filter((line): line is StatementLineDraft => line !== null)
  ].filter((line) => !query.assetCode || line.assetCode === query.assetCode);

  drafts.sort(compareChronologically);

  const running = new Map<AssetCode, StatementBalance>();
  const withBalances: StatementLine[] = drafts.map((line) => {
    const previous = running.get(line.assetCode) ?? { total: "0", available: "0", locked: "0" };
    const next: StatementBalance = {
      total: addAmounts(previous.total, line.totalDelta),
      available: addAmounts(previous.available, line.availableDelta),
      locked: addAmounts(previous.locked, line.lockedDelta)
    };
    running.set(line.assetCode, next);
    return { ...line, balanceAfter: next };
  });

  const balanceDerivable: Record<string, boolean> = {};
  const assets = new Set<AssetCode>([
    ...running.keys(),
    ...params.balances
      .map((balance) => balance.assetCode)
      .filter((assetCode) => !query.assetCode || assetCode === query.assetCode)
  ]);
  for (const assetCode of assets) {
    const replayed = running.get(assetCode) ?? { total: "0", available: "0", locked: "0" };
    const snapshot = params.balances.find((balance) => balance.assetCode === assetCode);
    balanceDerivable[assetCode] =
      compareAmounts(replayed.available, snapshot?.available ?? "0") === 0 &&
      compareAmounts(replayed.locked, snapshot?.locked ?? "0") === 0;
  }

  const fromMs = parseTime(query.from);
  const toMs = parseTime(query.to);
  const includeLockEvents = query.includeLockEvents !== false;

  const filtered = withBalances
    .filter((line) => {
      if (!includeLockEvents && line.source === "lock_event" && line.totalDelta === "0") {
        return false;
      }
      if (query.category === "fee") {
        if (!line.feeAmount) {
          return false;
        }
      } else if (query.category && line.category !== query.category) {
        return false;
      }
      if (query.businessType && line.businessType !== query.businessType) {
        return false;
      }
      const at = Date.parse(line.occurredAt);
      if (fromMs !== undefined && at < fromMs) {
        return false;
      }
      if (toMs !== undefined && at >= toMs) {
        return false;
      }
      return true;
    })
    .map((line) =>
      balanceDerivable[line.assetCode] ? line : { ...line, balanceAfter: undefined }
    )
    .reverse();

  return {
    accountId: query.accountId,
    items: filtered.slice(params.offset, params.offset + params.limit),
    total: filtered.length,
    limit: params.limit,
    offset: params.offset,
    balanceDerivable
  };
}

export function entryToLine(entry: StatementEntrySource): StatementLineDraft {
  const amount = normalize(entry.amount);
  const consumesLock =
    entry.direction === "debit" && LOCK_SETTLEMENT_BUSINESS_TYPES.has(entry.businessType);
  const category = categorize(entry.referenceType, entry.businessType);
  const signed = entry.direction === "credit" ? amount : negate(amount);

  return {
    lineId: `entry:${entry.entryId}`,
    source: "entry",
    occurredAt: entry.createdAt,
    assetCode: entry.assetCode,
    category,
    action: entryAction(category, entry.direction),
    amount,
    totalDelta: signed,
    availableDelta: consumesLock ? "0" : signed,
    lockedDelta: consumesLock ? signed : "0",
    businessType: entry.businessType,
    businessId: entry.businessId,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    journalId: entry.journalId,
    entryId: entry.entryId,
    direction: entry.direction,
    feeAmount:
      entry.feeAmount && compareAmounts(entry.feeAmount, "0") > 0
        ? normalize(entry.feeAmount)
        : undefined,
    feeAssetCode:
      entry.feeAmount && compareAmounts(entry.feeAmount, "0") > 0 ? entry.feeAssetCode : undefined,
    description: entry.description
  };
}

/** Returns null for settled consumptions: their journal entry already tells the story. */
export function lockEventToLine(event: StatementLockEventSource): StatementLineDraft | null {
  if (event.eventType === "balance.consumed" && event.settled) {
    return null;
  }
  const amount = normalize(event.amount);
  const category = categorize(event.referenceType);
  const base = {
    lineId: `lock:${event.eventId}`,
    source: "lock_event" as const,
    occurredAt: event.createdAt,
    assetCode: event.assetCode,
    category,
    amount,
    referenceType: event.referenceType,
    referenceId: event.referenceId
  };

  if (event.eventType === "balance.locked") {
    return {
      ...base,
      action: category === "withdrawal" ? "withdrawal_freeze" : "order_freeze",
      totalDelta: "0",
      availableDelta: negate(amount),
      lockedDelta: amount
    };
  }
  if (event.eventType === "balance.released") {
    return {
      ...base,
      action: category === "withdrawal" ? "withdrawal_release" : "order_release",
      totalDelta: "0",
      availableDelta: amount,
      lockedDelta: negate(amount)
    };
  }
  // Legacy consumption without a settlement journal: funds left from locked.
  return {
    ...base,
    action: category === "withdrawal" ? "withdrawal_debit" : "trade_debit",
    totalDelta: negate(amount),
    availableDelta: "0",
    lockedDelta: negate(amount)
  };
}

export function categorize(referenceType: string, businessType?: string): StatementCategory {
  if (referenceType === "deposit" || businessType === "deposit_confirmed") {
    return "deposit";
  }
  if (referenceType === "withdrawal") {
    return "withdrawal";
  }
  if (
    referenceType === "spot_order" ||
    referenceType === "spot_trade" ||
    referenceType === "spot_trade_fee" ||
    businessType?.startsWith("spot_trade") ||
    businessType === "spot_order_lock_settled"
  ) {
    return "trade";
  }
  return "adjustment";
}

function entryAction(category: StatementCategory, direction: "debit" | "credit"): StatementAction {
  switch (category) {
    case "deposit":
      return direction === "credit" ? "deposit_credit" : "adjustment_debit";
    case "withdrawal":
      return direction === "debit" ? "withdrawal_debit" : "adjustment_credit";
    case "trade":
      return direction === "credit" ? "trade_credit" : "trade_debit";
    default:
      return direction === "credit" ? "adjustment_credit" : "adjustment_debit";
  }
}

function compareChronologically(left: StatementLineDraft, right: StatementLineDraft): number {
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (byTime !== 0) {
    return byTime;
  }
  // Same instant: a freeze happens before the money it froze is spent.
  const rank = (line: StatementLineDraft) => (line.source === "lock_event" ? 0 : 1);
  if (rank(left) !== rank(right)) {
    return rank(left) - rank(right);
  }
  return left.lineId.localeCompare(right.lineId);
}

function normalize(amount: string): string {
  return addAmounts(amount, "0");
}

function negate(amount: string): string {
  return subtractAmounts("0", amount);
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
