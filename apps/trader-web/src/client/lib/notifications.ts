// Notification center (M4-2): turns wallet-service notification records into
// human-readable Chinese copy plus a link to the record they are about.
// Pure functions only, so they are unit tested without React.

import { formatAmount } from "@web3-cex/web-ui";

import type { NotificationRecord } from "./types.js";

export type NotificationTone = "positive" | "negative" | "neutral";

export interface NotificationView {
  key: string;
  title: string;
  detail: string;
  tone: NotificationTone;
  /** App path (without `#`) of the related withdrawal / deposit / order. */
  link?: string;
  unread: boolean;
  createdAt?: string;
}

const COPY: Record<string, { title: string; detail: string; tone: NotificationTone }> = {
  "withdrawal.requested": { title: "提现申请已提交", detail: "资金已冻结，等待运营审核", tone: "neutral" },
  "withdrawal.approved": { title: "提现审核通过", detail: "即将由托管服务广播上链", tone: "neutral" },
  "withdrawal.rejected": { title: "提现被驳回", detail: "冻结的资金已解冻回可用余额", tone: "negative" },
  "withdrawal.broadcasted": { title: "提现已广播上链", detail: "等待区块确认", tone: "neutral" },
  "withdrawal.confirmed": { title: "提现已完成", detail: "链上确认数已达标，资金已出账", tone: "positive" },
  "deposit.credited": { title: "充值已到账", detail: "资金已记入现货账户可用余额", tone: "positive" }
};

export function notificationKey(record: NotificationRecord): string {
  return record.notificationId ?? `${record.eventType ?? "unknown"}:${record.createdAt ?? ""}`;
}

export function notificationLink(record: NotificationRecord): string | undefined {
  const payload = record.payload ?? {};
  const withdrawalId = record.withdrawalId ?? readString(payload.withdrawalId);
  if (withdrawalId) {
    return `/assets?tab=withdrawals&highlight=${encodeURIComponent(withdrawalId)}`;
  }
  const depositId = record.depositId ?? readString(payload.depositId);
  if (depositId) {
    return `/assets?tab=deposits&highlight=${encodeURIComponent(depositId)}`;
  }
  const orderId = readString(payload.orderId);
  if (orderId) {
    return `/orders?tab=history&highlight=${encodeURIComponent(orderId)}`;
  }
  return undefined;
}

export function describeNotification(record: NotificationRecord): NotificationView {
  const copy = COPY[record.eventType ?? ""];
  const payload = record.payload ?? {};
  const amount = readString(payload.amount);
  const assetCode = readString(payload.assetCode);
  const amountText = amount ? `${formatAmount(amount, 8)} ${assetCode ?? ""}`.trim() : "";
  const detail = [amountText, copy?.detail ?? record.body ?? ""].filter(Boolean).join(" · ");

  return {
    key: notificationKey(record),
    title: copy?.title ?? record.subject ?? record.eventType ?? "账户通知",
    detail,
    tone: copy?.tone ?? "neutral",
    link: notificationLink(record),
    unread: !record.readAt,
    createdAt: record.createdAt
  };
}

/**
 * How many of `incoming` are new unread notifications compared with `known`.
 * Used to bump the bell count from realtime events without a REST round trip.
 */
export function countNewUnread(known: NotificationRecord[], incoming: NotificationRecord[]): number {
  const seen = new Set(known.map(notificationKey));
  let count = 0;
  for (const record of incoming) {
    const key = notificationKey(record);
    if (!seen.has(key) && !record.readAt) {
      count += 1;
    }
    seen.add(key);
  }
  return count;
}

/** Read markers are monotonic: a stale realtime snapshot must not "unread" a row. */
export function keepReadMarkers(
  previous: NotificationRecord[],
  incoming: NotificationRecord[]
): NotificationRecord[] {
  const readAtByKey = new Map(
    previous.filter((record) => record.readAt).map((record) => [notificationKey(record), record.readAt])
  );
  return incoming.map((record) =>
    record.readAt || !readAtByKey.has(notificationKey(record))
      ? record
      : { ...record, readAt: readAtByKey.get(notificationKey(record)) }
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
