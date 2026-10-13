// Pure helpers that turn raw service records into UI-friendly views.
// Kept free of React so they can be unit tested with node:test.

import { type Tone, toNumber } from "@web3-cex/web-ui";

import type {
  BalanceRecord,
  DepositRecord,
  OrderRecord,
  OrderSide,
  TradeRecord,
  WithdrawalRecord
} from "./types.js";

export type { Tone };

/** Upserts `incoming` into `current` by key and keeps newest first. */
export function mergeRecords<T>(current: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of current) {
    byKey.set(keyOf(item), item);
  }
  for (const item of incoming) {
    byKey.set(keyOf(item), { ...(byKey.get(keyOf(item)) ?? {}), ...item });
  }
  return [...byKey.values()].sort((left, right) => timeOf(right) - timeOf(left));
}

export function timeOf(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const raw =
    record.updatedAt ??
    record.executedAt ??
    record.creditedAt ??
    record.confirmedAt ??
    record.requestedAt ??
    record.detectedAt ??
    record.createdAt;
  const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const OPEN_ORDER_STATUSES = new Set([
  "pending_trigger",
  "pending_risk",
  "accepted",
  "partially_filled",
  "recovery_pending"
]);

export function isOpenOrder(order: OrderRecord): boolean {
  return OPEN_ORDER_STATUSES.has(order.status ?? "");
}

const ORDER_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  pending_trigger: {
    label: "待触发",
    tone: "info",
    hint: "止损单已冻结资金，等待最新成交价触及触发价后再提交到撮合引擎"
  },
  pending_risk: {
    label: "风控中",
    tone: "info",
    hint: "risk-service 正在校验余额、价格偏离和最小数量"
  },
  accepted: {
    label: "挂单中",
    tone: "info",
    hint: "已冻结资金并进入撮合引擎订单簿，等待对手方"
  },
  partially_filled: {
    label: "部分成交",
    tone: "warning",
    hint: "部分数量已成交并结算，剩余数量仍在订单簿中"
  },
  recovery_pending: {
    label: "恢复中",
    tone: "warning",
    hint: "撮合或结算回报异常，order-service 的恢复队列会自动重试"
  },
  filled: { label: "完全成交", tone: "positive", hint: "全部成交，settlement-service 已完成结算" },
  cancelled: { label: "已撤销", tone: "neutral", hint: "剩余数量已从订单簿移除并解冻资金" },
  rejected: { label: "已拒绝", tone: "negative", hint: "未通过风控或撮合校验，资金未被冻结" }
};

export function describeOrderStatus(status: string | undefined) {
  return (
    ORDER_STATUS[status ?? ""] ?? {
      label: status ?? "未知",
      tone: "neutral" as Tone,
      hint: "未知状态"
    }
  );
}

export function filledRatio(order: OrderRecord): number {
  const quantity = toNumber(order.quantity);
  const filled = toNumber(order.filledQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(filled)) {
    return 0;
  }
  return Math.min(filled / quantity, 1);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** Taker side of a public trade: the aggressor decides the trade colour. */
export function takerSide(trade: TradeRecord): OrderSide {
  if (trade.takerSide) {
    return trade.takerSide;
  }
  if (trade.side) {
    return trade.side;
  }
  return trade.takerOrderId && trade.takerOrderId === trade.sellerOrderId ? "sell" : "buy";
}

/** Side of a private trade from the logged-in user's point of view. */
export function userTradeSide(trade: TradeRecord, userId: string | undefined): OrderSide {
  if (userId && trade.sellerUserId === userId && trade.buyerUserId !== userId) {
    return "sell";
  }
  if (userId && trade.buyerUserId === userId) {
    return "buy";
  }
  return takerSide(trade);
}

/**
 * Fee paid by the user on a trade. Each side pays in the asset it receives:
 * the buyer in base (quantity * buyerFeeRate), the seller in quote.
 */
export function userTradeFee(
  trade: TradeRecord,
  userId: string | undefined
): { amount: number; asset: "base" | "quote" } {
  const side = userTradeSide(trade, userId);
  if (side === "buy") {
    const rate = toNumber(trade.buyerFeeRate ?? "0");
    const amount = toNumber(trade.quantity) * rate;
    return { amount: Number.isFinite(amount) ? amount : 0, asset: "base" };
  }
  const quote = toNumber(trade.price) * toNumber(trade.quantity);
  const rate = toNumber(trade.sellerFeeRate);
  const amount = quote * rate;
  return { amount: Number.isFinite(amount) ? amount : 0, asset: "quote" };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface AssetBalance {
  assetCode: string;
  accountId: string;
  available: number;
  locked: number;
  total: number;
}

// `assetOrder` is the config/markets.json asset order (runtime config `assets`).
export function summarizeBalances(balances: BalanceRecord[], assetOrder: string[] = []): AssetBalance[] {
  const byAsset = new Map<string, AssetBalance>();
  for (const balance of balances) {
    if (balance.accountType && balance.accountType !== "spot") {
      continue;
    }
    const available = toNumber(balance.available) || 0;
    const locked = toNumber(balance.locked) || 0;
    const existing = byAsset.get(balance.assetCode);
    if (existing) {
      existing.available += available;
      existing.locked += locked;
      existing.total = existing.available + existing.locked;
    } else {
      byAsset.set(balance.assetCode, {
        assetCode: balance.assetCode,
        accountId: balance.accountId,
        available,
        locked,
        total: available + locked
      });
    }
  }
  const order = assetOrder;
  return [...byAsset.values()].sort(
    (left, right) =>
      (order.indexOf(left.assetCode) + 1 || 99) - (order.indexOf(right.assetCode) + 1 || 99)
  );
}

export function availableOf(balances: AssetBalance[], assetCode: string): number {
  return balances.find((item) => item.assetCode === assetCode)?.available ?? 0;
}

export function spotAccountId(balances: BalanceRecord[]): string {
  return (
    balances.find((item) => !item.accountType || item.accountType === "spot")?.accountId ??
    balances[0]?.accountId ??
    ""
  );
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export interface FundingStep {
  key: string;
  label: string;
}

export const DEPOSIT_STEPS: FundingStep[] = [
  { key: "detected", label: "链上检测" },
  { key: "confirming", label: "区块确认" },
  { key: "confirmed", label: "确认完成" },
  { key: "credited", label: "已入账" }
];

export const WITHDRAWAL_STEPS: FundingStep[] = [
  { key: "requested", label: "已申请" },
  { key: "under_review", label: "人工审核" },
  { key: "approved", label: "审核通过" },
  { key: "broadcasted", label: "已广播" },
  { key: "confirmed", label: "链上确认" }
];

const FUNDING_STATUS: Record<string, { label: string; tone: Tone }> = {
  detected: { label: "已检测", tone: "info" },
  confirming: { label: "确认中", tone: "info" },
  confirmed: { label: "待入账", tone: "info" },
  credited: { label: "已入账", tone: "positive" },
  requested: { label: "已申请", tone: "info" },
  under_review: { label: "审核中", tone: "warning" },
  approved: { label: "审核通过", tone: "info" },
  broadcasted: { label: "已广播", tone: "info" },
  failed: { label: "失败", tone: "negative" },
  rejected: { label: "已拒绝", tone: "negative" }
};

export function describeFundingStatus(status: string | undefined, kind: "deposit" | "withdrawal") {
  if (status === "confirmed" && kind === "withdrawal") {
    return { label: "已完成", tone: "positive" as Tone };
  }
  return FUNDING_STATUS[status ?? ""] ?? { label: status ?? "未知", tone: "neutral" as Tone };
}

export function fundingStepIndex(steps: FundingStep[], status: string | undefined): number {
  const index = steps.findIndex((step) => step.key === status);
  return index;
}

export function depositKey(item: DepositRecord): string {
  return item.depositId;
}

export function withdrawalKey(item: WithdrawalRecord): string {
  return item.withdrawalId;
}
