import { addAmounts, compareAmounts, subtractAmounts } from "@web3-cex/domain";

import type {
  GatewayJournalDirection,
  GatewayJournalEntry,
  GatewayLedgerJournal,
  GatewayTradeRecord
} from "./types.js";

/**
 * Customer-facing journal views (M3-3).
 *
 * Ledger journals reference raw account ids, including the other side of a
 * trade. Everything in this module turns them into a masked view: the
 * viewer's own accounts become 「我的现货账户」, other customers become
 * 「对手方」 and platform accounts get a readable name. Account ids, user ids,
 * order ids, idempotency keys and trace ids never leave this module.
 *
 * The masking context and balance check are not trade specific, so an asset
 * statement can reuse them with a different set of journals.
 */

export type JournalAccountRole =
  | "self"
  | "counterparty"
  | "platform_settlement"
  | "platform_fee"
  | "platform"
  | "unknown";

export interface JournalAccountInfo {
  userId?: string;
  accountType?: string;
}

export interface JournalMaskingContext {
  viewerUserId: string;
  /** Accounts the viewer owns (known up front, e.g. from the trade record). */
  ownAccountIds: ReadonlySet<string>;
  /** Accounts known to belong to another customer. */
  counterpartyAccountIds: ReadonlySet<string>;
  /** Ledger metadata for every other account referenced by the journals. */
  accountDirectory: ReadonlyMap<string, JournalAccountInfo>;
}

export interface MaskedJournalEntry {
  accountRole: JournalAccountRole;
  accountLabel: string;
  assetCode: string;
  direction: GatewayJournalDirection;
  amount: string;
  referenceType: string;
}

export interface AssetBalanceCheck {
  assetCode: string;
  debitTotal: string;
  creditTotal: string;
  balanced: boolean;
}

export interface MaskedJournal {
  journalId: string;
  businessType: string;
  stage: string;
  stageLabel: string;
  createdAt: string;
  entries: MaskedJournalEntry[];
  totals: AssetBalanceCheck[];
  balanced: boolean;
}

export interface ViewerAssetChange {
  assetCode: string;
  /** Credits minus debits on the viewer's own accounts (credit = balance up). */
  netChange: string;
}

export interface TradeJournalView {
  tradeId: string;
  market: string;
  price: string;
  quantity: string;
  executedAt: string;
  viewerSide: "buy" | "sell" | "both";
  viewerLiquidity: "maker" | "taker" | "both";
  settled: boolean;
  journals: MaskedJournal[];
  totals: AssetBalanceCheck[];
  balanced: boolean;
  viewerChanges: ViewerAssetChange[];
}

export const TRADE_JOURNAL_BUSINESS_TYPES = [
  // Lock consumption. Older ledgers posted it as "withdrawal_settled".
  "spot_order_lock_settled",
  "withdrawal_settled",
  "spot_trade_settlement_base",
  "spot_trade_settlement_quote"
] as const;

const STAGE_RANK: Record<string, number> = {
  lock_consume: 0,
  settle_base: 1,
  settle_quote: 2
};

/** Keeps only the journals a trade settlement produces for `tradeId`. */
export function selectTradeJournals(
  tradeId: string,
  journals: GatewayLedgerJournal[]
): GatewayLedgerJournal[] {
  return journals.filter((journal) => {
    if (journal.businessId !== tradeId) {
      return false;
    }
    if (journal.businessType === "withdrawal_settled" || journal.businessType === "spot_order_lock_settled") {
      // Only lock consumption for spot orders belongs to the trade.
      return journal.entries.some((entry) => entry.referenceType === "spot_order");
    }
    return (TRADE_JOURNAL_BUSINESS_TYPES as readonly string[]).includes(journal.businessType);
  });
}

export function classifyJournalAccount(
  accountId: string,
  assetCode: string,
  context: JournalMaskingContext
): { role: JournalAccountRole; label: string } {
  if (context.ownAccountIds.has(accountId)) {
    return { role: "self", label: "我的现货账户" };
  }
  if (context.counterpartyAccountIds.has(accountId)) {
    return { role: "counterparty", label: "对手方" };
  }

  const info = context.accountDirectory.get(accountId);
  if (!info) {
    return { role: "unknown", label: "其他账户" };
  }
  if (info.userId) {
    return info.userId === context.viewerUserId
      ? { role: "self", label: "我的现货账户" }
      : { role: "counterparty", label: "对手方" };
  }
  if (info.accountType === "fee") {
    return { role: "platform_fee", label: `平台手续费账户（${assetCode}）` };
  }
  if (info.accountType === "spot") {
    return { role: "platform_settlement", label: `平台结算中转账户（${assetCode}）` };
  }
  return { role: "platform", label: `平台账户（${assetCode}）` };
}

/** Debit total vs credit total per asset; balanced when every asset matches. */
export function checkJournalBalance(
  entries: Array<Pick<GatewayJournalEntry, "assetCode" | "direction" | "amount">>
): AssetBalanceCheck[] {
  const totals = new Map<string, { debit: string; credit: string }>();
  for (const entry of entries) {
    const current = totals.get(entry.assetCode) ?? { debit: "0", credit: "0" };
    if (entry.direction === "debit") {
      current.debit = addAmounts(current.debit, entry.amount);
    } else {
      current.credit = addAmounts(current.credit, entry.amount);
    }
    totals.set(entry.assetCode, current);
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetCode, total]) => ({
      assetCode,
      debitTotal: total.debit,
      creditTotal: total.credit,
      balanced: compareAmounts(total.debit, total.credit) === 0
    }));
}

export function maskJournal(
  journal: GatewayLedgerJournal,
  context: JournalMaskingContext
): MaskedJournal {
  const entries = journal.entries.map((entry): MaskedJournalEntry => {
    const account = classifyJournalAccount(entry.accountId, entry.assetCode, context);
    return {
      accountRole: account.role,
      accountLabel: account.label,
      assetCode: entry.assetCode,
      direction: entry.direction,
      amount: entry.amount,
      referenceType: entry.referenceType
    };
  });
  const totals = checkJournalBalance(journal.entries);
  const { stage, stageLabel } = describeStage(journal, entries);

  return {
    journalId: journal.journalId,
    businessType: journal.businessType,
    stage,
    stageLabel,
    createdAt: journal.createdAt,
    entries,
    totals,
    balanced: totals.every((total) => total.balanced)
  };
}

/** Net credit - debit on the viewer's own accounts, per asset. */
export function summarizeViewerChanges(journals: MaskedJournal[]): ViewerAssetChange[] {
  const net = new Map<string, string>();
  for (const journal of journals) {
    for (const entry of journal.entries) {
      if (entry.accountRole !== "self") {
        continue;
      }
      const current = net.get(entry.assetCode) ?? "0";
      net.set(
        entry.assetCode,
        entry.direction === "credit"
          ? addAmounts(current, entry.amount)
          : subtractAmounts(current, entry.amount)
      );
    }
  }
  return [...net.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetCode, netChange]) => ({ assetCode, netChange }));
}

/** Builds the masking context for a trade from the viewer's perspective. */
export function buildTradeMaskingContext(
  trade: Pick<
    GatewayTradeRecord,
    "buyerUserId" | "sellerUserId" | "buyerAccountId" | "sellerAccountId"
  >,
  viewerUserId: string,
  accountDirectory: ReadonlyMap<string, JournalAccountInfo> = new Map()
): JournalMaskingContext {
  const ownAccountIds = new Set<string>();
  const counterpartyAccountIds = new Set<string>();
  if (trade.buyerUserId === viewerUserId) {
    ownAccountIds.add(trade.buyerAccountId);
  } else {
    counterpartyAccountIds.add(trade.buyerAccountId);
  }
  if (trade.sellerUserId === viewerUserId) {
    ownAccountIds.add(trade.sellerAccountId);
  } else {
    counterpartyAccountIds.add(trade.sellerAccountId);
  }
  return { viewerUserId, ownAccountIds, counterpartyAccountIds, accountDirectory };
}

/** Account ids that still need a ledger lookup to be classified. */
export function listUnclassifiedAccountIds(
  journals: GatewayLedgerJournal[],
  context: Pick<JournalMaskingContext, "ownAccountIds" | "counterpartyAccountIds">
): string[] {
  const ids = new Set<string>();
  for (const journal of journals) {
    for (const entry of journal.entries) {
      if (
        !context.ownAccountIds.has(entry.accountId) &&
        !context.counterpartyAccountIds.has(entry.accountId)
      ) {
        ids.add(entry.accountId);
      }
    }
  }
  return [...ids];
}

export function buildTradeJournalView(params: {
  trade: GatewayTradeRecord;
  viewerUserId: string;
  journals: GatewayLedgerJournal[];
  context: JournalMaskingContext;
}): TradeJournalView {
  const { trade, viewerUserId } = params;
  const isBuyer = trade.buyerUserId === viewerUserId;
  const isSeller = trade.sellerUserId === viewerUserId;
  const viewerOrderIds = [
    ...(isBuyer ? [trade.buyerOrderId] : []),
    ...(isSeller ? [trade.sellerOrderId] : [])
  ];
  const isMaker = viewerOrderIds.includes(trade.makerOrderId);
  const isTaker = viewerOrderIds.includes(trade.takerOrderId);

  const masked = selectTradeJournals(trade.tradeId, params.journals)
    .map((journal) => maskJournal(journal, params.context))
    .sort(
      (left, right) =>
        (STAGE_RANK[left.stage] ?? 9) - (STAGE_RANK[right.stage] ?? 9) ||
        left.createdAt.localeCompare(right.createdAt)
    );
  const totals = checkJournalBalance(masked.flatMap((journal) => journal.entries));

  return {
    tradeId: trade.tradeId,
    market: trade.market,
    price: trade.price,
    quantity: trade.quantity,
    executedAt: trade.executedAt,
    viewerSide: isBuyer && isSeller ? "both" : isBuyer ? "buy" : "sell",
    viewerLiquidity: isMaker && isTaker ? "both" : isMaker ? "maker" : "taker",
    settled: masked.some((journal) => journal.stage !== "lock_consume"),
    journals: masked,
    totals,
    balanced: masked.length > 0 && totals.every((total) => total.balanced),
    viewerChanges: summarizeViewerChanges(masked)
  };
}

function describeStage(
  journal: GatewayLedgerJournal,
  entries: MaskedJournalEntry[]
): { stage: string; stageLabel: string } {
  const assetCode = journal.entries[0]?.assetCode ?? "";
  switch (journal.businessType) {
    case "spot_order_lock_settled":
    case "withdrawal_settled": {
      const source = entries.find((entry) => entry.direction === "debit");
      const owner =
        source?.accountRole === "self"
          ? "我的"
          : source?.accountRole === "counterparty"
            ? "对手方"
            : "";
      return {
        stage: "lock_consume",
        stageLabel: `消耗${owner}委托冻结的 ${assetCode}，划入结算中转账户`
      };
    }
    case "spot_trade_settlement_base":
      return { stage: "settle_base", stageLabel: `交割基础资产 ${assetCode}：中转账户 → 买方（扣除买方手续费）` };
    case "spot_trade_settlement_quote":
      return { stage: "settle_quote", stageLabel: `交割计价资产 ${assetCode}：中转账户 → 卖方（扣除卖方手续费）` };
    default:
      return { stage: journal.businessType, stageLabel: journal.description ?? journal.businessType };
  }
}
