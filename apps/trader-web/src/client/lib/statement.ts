// Asset statement (M4-5): maps ledger statement lines (GET /ledger/entries)
// to display rows and CSV. Pure functions only, unit tested in client-lib.test.

export type StatementCategory = "deposit" | "withdrawal" | "trade" | "adjustment";
export type StatementCategoryFilter = StatementCategory | "fee";

export type StatementAction =
  | "deposit_credit"
  | "withdrawal_freeze"
  | "withdrawal_release"
  | "withdrawal_debit"
  | "order_freeze"
  | "order_release"
  | "trade_debit"
  | "trade_credit"
  | "adjustment_credit"
  | "adjustment_debit";

export interface StatementBalance {
  total: string;
  available: string;
  locked: string;
}

/** One line as returned by the gateway (ledger-service account statement). */
export interface StatementLine {
  lineId: string;
  source: "entry" | "lock_event";
  occurredAt: string;
  assetCode: string;
  category: StatementCategory;
  action: StatementAction | string;
  amount: string;
  totalDelta: string;
  availableDelta: string;
  lockedDelta: string;
  balanceAfter?: StatementBalance;
  businessType?: string;
  businessId?: string;
  referenceType: string;
  referenceId: string;
  journalId?: string;
  entryId?: string;
  direction?: "debit" | "credit";
  feeAmount?: string;
  feeAssetCode?: string;
  description?: string;
}

export interface StatementPage {
  accountId?: string;
  items: StatementLine[];
  total: number;
  limit: number;
  offset: number;
  balanceDerivable?: Record<string, boolean>;
}

export interface StatementRow {
  id: string;
  occurredAt: string;
  typeLabel: string;
  categoryLabel: string;
  assetCode: string;
  /** Signed plain decimal ("1000", "-101.5"). */
  amount: string;
  /**
   * "total" when money entered / left the account; "available" for freeze /
   * release, which only move money between available and locked.
   */
  amountScope: "total" | "available";
  feeAmount?: string;
  feeAssetCode?: string;
  balanceAfter?: StatementBalance;
  sourceLabel: string;
  sourceId: string;
  /** App path (without `#`) of the source record. */
  link?: string;
  /** Set for trade lines: opens the M3-3 T-account view of that trade. */
  tradeId?: string;
  journalId?: string;
}

export const STATEMENT_ACTION_LABELS: Record<StatementAction, string> = {
  deposit_credit: "充值入账",
  withdrawal_freeze: "提现冻结",
  withdrawal_release: "提现解冻",
  withdrawal_debit: "提现出账",
  order_freeze: "下单冻结",
  order_release: "委托解冻",
  trade_debit: "成交支出",
  trade_credit: "成交收入",
  adjustment_credit: "调账入账",
  adjustment_debit: "调账出账"
};

export const STATEMENT_CATEGORY_LABELS: Record<StatementCategoryFilter, string> = {
  deposit: "充值",
  withdrawal: "提现",
  trade: "成交",
  fee: "手续费",
  adjustment: "调账 / 期初"
};

export function toStatementRow(line: StatementLine): StatementRow {
  const movesTotal = !isZero(line.totalDelta);
  const amount = normalizeDecimal(movesTotal ? line.totalDelta : line.availableDelta);
  const source = describeSource(line);

  return {
    id: line.lineId,
    occurredAt: line.occurredAt,
    typeLabel: STATEMENT_ACTION_LABELS[line.action as StatementAction] ?? line.action,
    categoryLabel: STATEMENT_CATEGORY_LABELS[line.category] ?? line.category,
    assetCode: line.assetCode,
    amount,
    amountScope: movesTotal ? "total" : "available",
    feeAmount: line.feeAmount ? normalizeDecimal(line.feeAmount) : undefined,
    feeAssetCode: line.feeAmount ? line.feeAssetCode : undefined,
    balanceAfter: line.balanceAfter
      ? {
          total: normalizeDecimal(line.balanceAfter.total),
          available: normalizeDecimal(line.balanceAfter.available),
          locked: normalizeDecimal(line.balanceAfter.locked)
        }
      : undefined,
    sourceLabel: source.label,
    sourceId: source.id,
    link: source.link,
    tradeId: source.label === "成交" ? source.id : undefined,
    journalId: line.journalId
  };
}

function describeSource(line: StatementLine): { label: string; id: string; link?: string } {
  switch (line.referenceType) {
    case "deposit":
      return {
        label: "充值",
        id: line.referenceId,
        link: `/assets?tab=deposits&highlight=${encodeURIComponent(line.referenceId)}`
      };
    case "withdrawal":
      return {
        label: "提现",
        id: line.referenceId,
        link: `/assets?tab=withdrawals&highlight=${encodeURIComponent(line.referenceId)}`
      };
    case "spot_trade":
      return {
        label: "成交",
        id: line.referenceId,
        link: `/orders?tab=trades&highlight=${encodeURIComponent(line.referenceId)}`
      };
    case "spot_order":
      // A lock consumed by a trade carries the trade id as businessId.
      if (line.source === "entry" && line.businessId && line.businessId !== line.referenceId) {
        return {
          label: "成交",
          id: line.businessId,
          link: `/orders?tab=trades&highlight=${encodeURIComponent(line.businessId)}`
        };
      }
      return {
        label: "委托",
        id: line.referenceId,
        link: `/orders?tab=history&highlight=${encodeURIComponent(line.referenceId)}`
      };
    default:
      return { label: line.businessType ?? line.referenceType, id: line.referenceId };
  }
}

// ---------------------------------------------------------------------------
// Decimal helpers (string based; amounts carry up to 18 decimals)
// ---------------------------------------------------------------------------

/** "-0.500000000000000000" -> "-0.5", "+12" -> "12", "-0" -> "0". */
export function normalizeDecimal(value: string): string {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const [, sign = "", whole = "", fraction = ""] = match;
  const integer = whole.replace(/^0+(?=\d)/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  const body = decimals ? `${integer}.${decimals}` : integer;
  return sign === "-" && body !== "0" ? `-${body}` : body;
}

export function isZero(value: string | undefined): boolean {
  return !value || normalizeDecimal(value) === "0";
}

/** UI form of a signed amount: "+1000" / "-101.5" / "0". */
export function formatSignedAmount(amount: string): string {
  const normalized = normalizeDecimal(amount);
  if (normalized === "0" || normalized.startsWith("-")) {
    return normalized;
  }
  return `+${normalized}`;
}

// ---------------------------------------------------------------------------
// Date range (date inputs are local calendar days)
// ---------------------------------------------------------------------------

/** "2026-03-07" (local) -> inclusive from / exclusive to ISO timestamps. */
export function dateRangeToIso(from?: string, to?: string): { from?: string; to?: string } {
  const parse = (value: string, addDays: number) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return undefined;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  return {
    from: from ? parse(from, 0) : undefined,
    to: to ? parse(to, 1) : undefined
  };
}

export function buildStatementQuery(params: {
  assetCode?: string;
  category?: string;
  includeLockEvents?: boolean;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}): string {
  const search = new URLSearchParams();
  if (params.assetCode) {
    search.set("assetCode", params.assetCode);
  }
  if (params.category) {
    search.set("category", params.category);
  }
  if (params.includeLockEvents === false) {
    search.set("includeLockEvents", "false");
  }
  const range = dateRangeToIso(params.from, params.to);
  if (range.from) {
    search.set("from", range.from);
  }
  if (range.to) {
    search.set("to", range.to);
  }
  search.set("limit", String(params.limit));
  search.set("offset", String(params.offset));
  return search.toString();
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export const STATEMENT_CSV_HEADER = [
  "时间(UTC)",
  "类型",
  "分类",
  "币种",
  "变动数量",
  "变动口径",
  "手续费",
  "手续费币种",
  "变动后总额",
  "变动后可用",
  "变动后冻结",
  "来源",
  "来源ID",
  "账本凭证(journalId)"
];

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * RFC 4180 field escaping. Text that a spreadsheet would evaluate as a formula
 * (=, +, -, @ at the start) is prefixed with an apostrophe; plain decimal
 * amounts (including negative ones) are left untouched.
 */
export function escapeCsvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) {
    return "";
  }
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !NUMERIC.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function statementRowsToCsv(rows: StatementRow[]): string {
  const lines = [STATEMENT_CSV_HEADER.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.occurredAt,
        row.typeLabel,
        row.categoryLabel,
        row.assetCode,
        row.amount,
        row.amountScope === "total" ? "总额" : "可用(冻结/解冻)",
        row.feeAmount ?? "",
        row.feeAssetCode ?? "",
        row.balanceAfter?.total ?? "",
        row.balanceAfter?.available ?? "",
        row.balanceAfter?.locked ?? "",
        row.sourceLabel,
        row.sourceId,
        row.journalId ?? ""
      ]
        .map(escapeCsvField)
        .join(",")
    );
  }
  // CRLF per RFC 4180; the BOM lets Excel detect UTF-8 (Chinese headers).
  return `﻿${lines.join("\r\n")}\r\n`;
}
