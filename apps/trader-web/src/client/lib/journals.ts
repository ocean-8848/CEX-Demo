// trade journal (T-account) view: types mirror the gateway response of
// GET /api/v1/gateway/trades/:tradeId/journals. Account ids never reach the
// browser; entries only carry a role + a readable label.

import type { ApiClient } from "./api.js";
import { fromUnits, toUnits } from "./match-explain.js";

export type JournalAccountRole =
  | "self"
  | "counterparty"
  | "platform_settlement"
  | "platform_fee"
  | "platform"
  | "unknown";

export interface MaskedJournalEntry {
  accountRole: JournalAccountRole;
  accountLabel: string;
  assetCode: string;
  direction: "debit" | "credit";
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
  viewerChanges: Array<{ assetCode: string; netChange: string }>;
}

/** Reusable fetch: an asset statement can call the same gateway helper. */
export function fetchTradeJournals(
  api: ApiClient,
  token: string,
  tradeId: string
): Promise<TradeJournalView> {
  return api.gateway<TradeJournalView>(`/trades/${encodeURIComponent(tradeId)}/journals`, {
    token
  });
}

export interface TAccountLine {
  amount: string;
  stageLabel: string;
  referenceType: string;
}

export interface TAccount {
  key: string;
  accountRole: JournalAccountRole;
  accountLabel: string;
  assetCode: string;
  debits: TAccountLine[];
  credits: TAccountLine[];
  debitTotal: string;
  creditTotal: string;
  /** Credit minus debit: for customer accounts in this ledger, credit = balance up. */
  net: string;
}

const ROLE_ORDER: Record<JournalAccountRole, number> = {
  self: 0,
  counterparty: 1,
  platform_settlement: 2,
  platform_fee: 3,
  platform: 4,
  unknown: 5
};

/** Groups all entries into one T-account per (account, asset). */
export function buildTAccounts(journals: MaskedJournal[]): TAccount[] {
  const accounts = new Map<string, TAccount>();
  for (const journal of journals) {
    for (const entry of journal.entries) {
      const key = `${entry.accountRole}:${entry.accountLabel}:${entry.assetCode}`;
      const account =
        accounts.get(key) ??
        ({
          key,
          accountRole: entry.accountRole,
          accountLabel: entry.accountLabel,
          assetCode: entry.assetCode,
          debits: [],
          credits: [],
          debitTotal: "0",
          creditTotal: "0",
          net: "0"
        } satisfies TAccount);
      const line = {
        amount: entry.amount,
        stageLabel: journal.stageLabel,
        referenceType: entry.referenceType
      };
      if (entry.direction === "debit") {
        account.debits.push(line);
        account.debitTotal = fromUnits(toUnits(account.debitTotal) + toUnits(entry.amount));
      } else {
        account.credits.push(line);
        account.creditTotal = fromUnits(toUnits(account.creditTotal) + toUnits(entry.amount));
      }
      account.net = fromUnits(toUnits(account.creditTotal) - toUnits(account.debitTotal));
      accounts.set(key, account);
    }
  }
  return [...accounts.values()].sort(
    (left, right) =>
      ROLE_ORDER[left.accountRole] - ROLE_ORDER[right.accountRole] ||
      left.assetCode.localeCompare(right.assetCode) ||
      left.accountLabel.localeCompare(right.accountLabel)
  );
}

/**
 * Recomputes debit / credit totals per asset in the browser so the "借贷平衡"
 * badge does not just trust the server flag.
 */
export function verifyJournalBalance(journals: MaskedJournal[]): AssetBalanceCheck[] {
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const entry of journals.flatMap((journal) => journal.entries)) {
    const current = totals.get(entry.assetCode) ?? { debit: 0n, credit: 0n };
    if (entry.direction === "debit") {
      current.debit += toUnits(entry.amount);
    } else {
      current.credit += toUnits(entry.amount);
    }
    totals.set(entry.assetCode, current);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetCode, total]) => ({
      assetCode,
      debitTotal: fromUnits(total.debit),
      creditTotal: fromUnits(total.credit),
      balanced: total.debit === total.credit
    }));
}
