import assert from "node:assert/strict";
import test from "node:test";

import {
  countNewUnread,
  describeNotification,
  keepReadMarkers,
  notificationLink
} from "../client/lib/notifications.js";
import {
  buildStatementQuery,
  dateRangeToIso,
  escapeCsvField,
  formatSignedAmount,
  normalizeDecimal,
  STATEMENT_CSV_HEADER,
  statementRowsToCsv,
  toStatementRow,
  type StatementLine
} from "../client/lib/statement.js";

function line(overrides: Partial<StatementLine>): StatementLine {
  return {
    lineId: "entry:e-1",
    source: "entry",
    occurredAt: "2026-03-07T00:00:00.000Z",
    assetCode: "USDT",
    category: "deposit",
    action: "deposit_credit",
    amount: "1000",
    totalDelta: "1000",
    availableDelta: "1000",
    lockedDelta: "0",
    referenceType: "deposit",
    referenceId: "dep-1",
    ...overrides
  };
}

test("deposit entry maps to a positive row linked to the deposit", () => {
  const row = toStatementRow(
    line({
      journalId: "j-1",
      balanceAfter: { total: "1000.000000000000000000", available: "1000", locked: "0" }
    })
  );
  assert.equal(row.typeLabel, "充值入账");
  assert.equal(row.categoryLabel, "充值");
  assert.equal(row.amount, "1000");
  assert.equal(row.amountScope, "total");
  assert.deepEqual(row.balanceAfter, { total: "1000", available: "1000", locked: "0" });
  assert.equal(row.link, "/assets?tab=deposits&highlight=dep-1");
  assert.equal(row.journalId, "j-1");
});

test("withdrawal freeze moves only available and links to the withdrawal", () => {
  const row = toStatementRow(
    line({
      lineId: "lock:ev-1",
      source: "lock_event",
      category: "withdrawal",
      action: "withdrawal_freeze",
      amount: "101",
      totalDelta: "0",
      availableDelta: "-101",
      lockedDelta: "101",
      referenceType: "withdrawal",
      referenceId: "wd-1"
    })
  );
  assert.equal(row.typeLabel, "提现冻结");
  assert.equal(row.amount, "-101");
  assert.equal(row.amountScope, "available");
  assert.equal(row.link, "/assets?tab=withdrawals&highlight=wd-1");
  assert.equal(row.balanceAfter, undefined);
});

test("trade lines link to the trade, keep the fee and fall back for unknown sources", () => {
  const debit = toStatementRow(
    line({
      category: "trade",
      action: "trade_debit",
      amount: "300",
      totalDelta: "-300.000000000000000000",
      availableDelta: "0",
      lockedDelta: "-300",
      businessType: "spot_order_lock_settled",
      businessId: "trade-1",
      referenceType: "spot_order",
      referenceId: "ord-1"
    })
  );
  assert.equal(debit.typeLabel, "成交支出");
  assert.equal(debit.amount, "-300");
  assert.equal(debit.sourceLabel, "成交");
  assert.equal(debit.link, "/orders?tab=trades&highlight=trade-1");
  assert.equal(debit.tradeId, "trade-1", "opens the T-account view");

  const orderFreeze = toStatementRow(
    line({
      source: "lock_event",
      category: "trade",
      action: "order_freeze",
      totalDelta: "0",
      availableDelta: "-500",
      referenceType: "spot_order",
      referenceId: "ord-1"
    })
  );
  assert.equal(orderFreeze.link, "/orders?tab=history&highlight=ord-1");
  assert.equal(orderFreeze.tradeId, undefined);

  const credit = toStatementRow(
    line({
      assetCode: "ETH",
      category: "trade",
      action: "trade_credit",
      amount: "0.0999",
      totalDelta: "0.0999",
      availableDelta: "0.0999",
      referenceType: "spot_trade",
      referenceId: "trade-1",
      feeAmount: "0.000100000000000000",
      feeAssetCode: "ETH"
    })
  );
  assert.equal(credit.typeLabel, "成交收入");
  assert.equal(credit.feeAmount, "0.0001");
  assert.equal(credit.feeAssetCode, "ETH");

  const seed = toStatementRow(
    line({
      category: "adjustment",
      action: "adjustment_credit",
      businessType: "opening_balance_backfill",
      referenceType: "opening_balance",
      referenceId: "seed-1"
    })
  );
  assert.equal(seed.typeLabel, "调账入账");
  assert.equal(seed.link, undefined);
  assert.equal(seed.sourceLabel, "opening_balance_backfill");
});

test("decimal helpers keep plain decimal strings", () => {
  assert.equal(normalizeDecimal("-0.500000000000000000"), "-0.5");
  assert.equal(normalizeDecimal("+12"), "12");
  assert.equal(normalizeDecimal("-0.000"), "0");
  assert.equal(normalizeDecimal("007.10"), "7.1");
  assert.equal(formatSignedAmount("5"), "+5");
  assert.equal(formatSignedAmount("-5"), "-5");
  assert.equal(formatSignedAmount("0"), "0");
});

test("CSV escaping quotes separators and neutralizes formulas but not negative amounts", () => {
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeCsvField("-101.5"), "-101.5");
  assert.equal(escapeCsvField("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(escapeCsvField("@cmd"), "'@cmd");
  assert.equal(escapeCsvField("-1+1"), "'-1+1");
  assert.equal(escapeCsvField(undefined), "");
  assert.equal(escapeCsvField(0), "0");
});

test("statement CSV has a header row, CRLF lines and plain decimal amounts", () => {
  const rows = [
    toStatementRow(line({ balanceAfter: { total: "1000", available: "1000", locked: "0" } })),
    toStatementRow(
      line({
        lineId: "entry:e-2",
        category: "withdrawal",
        action: "withdrawal_debit",
        amount: "101",
        totalDelta: "-101",
        availableDelta: "0",
        lockedDelta: "-101",
        referenceType: "withdrawal",
        referenceId: "wd,1"
      })
    )
  ];
  const csv = statementRowsToCsv(rows);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines[0], STATEMENT_CSV_HEADER.join(","));
  assert.equal(lines.length, 4);
  assert.equal(
    lines[1],
    "2026-03-07T00:00:00.000Z,充值入账,充值,USDT,1000,总额,,,1000,1000,0,充值,dep-1,"
  );
  assert.equal(
    lines[2],
    '2026-03-07T00:00:00.000Z,提现出账,提现,USDT,-101,总额,,,,,,提现,"wd,1",'
  );
});

test("statement query converts local calendar days to an inclusive / exclusive ISO range", () => {
  const range = dateRangeToIso("2026-03-07", "2026-03-07");
  assert.equal(range.from, new Date(2026, 2, 7).toISOString());
  assert.equal(range.to, new Date(2026, 2, 8).toISOString());
  assert.deepEqual(dateRangeToIso("bad", undefined), { from: undefined, to: undefined });

  const query = new URLSearchParams(
    buildStatementQuery({ assetCode: "USDT", category: "fee", includeLockEvents: false, limit: 20, offset: 40 })
  );
  assert.equal(query.get("assetCode"), "USDT");
  assert.equal(query.get("category"), "fee");
  assert.equal(query.get("includeLockEvents"), "false");
  assert.equal(query.get("limit"), "20");
  assert.equal(query.get("offset"), "40");
  assert.equal(query.has("from"), false);
});

test("notifications get Chinese titles, links and unread state", () => {
  const withdrawal = describeNotification({
    notificationId: "n-1",
    eventType: "withdrawal.rejected",
    withdrawalId: "wd-1",
    payload: { amount: "12.500000000000000000", assetCode: "USDT" },
    createdAt: "2026-03-07T00:00:00.000Z"
  });
  assert.equal(withdrawal.title, "提现被驳回");
  assert.equal(withdrawal.tone, "negative");
  assert.match(withdrawal.detail, /^12\.5 USDT · /);
  assert.equal(withdrawal.link, "/assets?tab=withdrawals&highlight=wd-1");
  assert.equal(withdrawal.unread, true);

  const deposit = describeNotification({
    notificationId: "n-2",
    eventType: "deposit.credited",
    depositId: "dep-1",
    readAt: "2026-03-07T00:01:00.000Z"
  });
  assert.equal(deposit.title, "充值已到账");
  assert.equal(deposit.unread, false);
  assert.equal(deposit.link, "/assets?tab=deposits&highlight=dep-1");

  assert.equal(
    notificationLink({ eventType: "order.filled", payload: { orderId: "ord-1" } }),
    "/orders?tab=history&highlight=ord-1"
  );
  assert.equal(describeNotification({ eventType: "x.y", subject: "Hello" }).title, "Hello");
});

test("unread bookkeeping counts only new unread items and keeps read markers", () => {
  const known = [{ notificationId: "a" }, { notificationId: "b", readAt: "t" }];
  assert.equal(
    countNewUnread(known, [
      { notificationId: "a" },
      { notificationId: "c" },
      { notificationId: "c" },
      { notificationId: "d", readAt: "t" }
    ]),
    1
  );
  const merged = keepReadMarkers(known, [{ notificationId: "b" }, { notificationId: "e" }]);
  assert.equal(merged[0]?.readAt, "t");
  assert.equal(merged[1]?.readAt, undefined);
});
