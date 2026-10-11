import assert from "node:assert/strict";
import test from "node:test";

import { buildTAccounts, verifyJournalBalance, type MaskedJournal } from "../client/lib/journals.js";
import { explainMatch, fromUnits, oppositeLevels, toUnits } from "../client/lib/match-explain.js";

const lvl = (price: string, quantity: string, orderCount?: number) => ({ price, quantity, orderCount });

test("decimal helpers round-trip 18-decimal strings without floats", () => {
  assert.equal(fromUnits(toUnits("0.1") + toUnits("0.2")), "0.3");
  assert.equal(fromUnits(toUnits("2000.000000000000000000")), "2000");
  assert.equal(fromUnits(toUnits("1") - toUnits("1.5")), "-0.5");
});

test("opposite levels follow price priority for each side", () => {
  const depth = { asks: [lvl("2002", "1"), lvl("2000", "1"), lvl("2001", "1")], bids: [lvl("1998", "1"), lvl("1999", "1")] };
  assert.deepEqual(oppositeLevels(depth, "buy").map((level) => level.price), ["2000", "2001", "2002"]);
  assert.deepEqual(oppositeLevels(depth, "sell").map((level) => level.price), ["1999", "1998"]);
});

test("multi-level sweep: walks asks from the lowest price, time priority inside a level", () => {
  const explanation = explainMatch({
    order: { side: "buy", type: "limit", timeInForce: "gtc", price: "2003", quantity: "3", filledQuantity: "3", status: "filled" },
    trades: [
      { price: "2001", quantity: "1.5", executionSequence: 12 },
      { price: "2000", quantity: "0.4", executionSequence: 10 },
      { price: "2000", quantity: "0.6", executionSequence: 11 },
      { price: "2002", quantity: "0.5", executionSequence: 13 }
    ],
    depthBefore: {
      bids: [lvl("1999", "4")],
      asks: [lvl("2005", "2"), lvl("2002", "1"), lvl("2001", "1.5"), lvl("2000", "1", 2)]
    }
  });

  assert.equal(explanation.bookSide, "asks");
  assert.equal(explanation.outcome, "filled");
  assert.equal(explanation.filledQuantity, "3");
  assert.equal(explanation.remainingQuantity, "0");
  assert.equal(explanation.quoteAmount, "6002.5");
  assert.ok(explanation.averagePrice?.startsWith("2000.8333"));
  assert.deepEqual(
    explanation.levels.map((level) => [level.price, level.state, level.filled, level.remainingAfter]),
    [
      ["2000", "swept", "1", "0"],
      ["2001", "swept", "1.5", "0"],
      ["2002", "partial", "0.5", "0.5"],
      ["2005", "beyond_limit", "0", "2"]
    ]
  );
  // Two maker orders at 2000 matched in time order.
  assert.deepEqual(
    explanation.levels[0]?.fills.map((fill) => [fill.queuePosition, fill.quantity]),
    [
      [1, "0.4"],
      [2, "0.6"]
    ]
  );
  assert.deepEqual(
    explanation.fills.map((fill) => fill.price),
    ["2000", "2000", "2001", "2002"]
  );
  assert.deepEqual(
    explanation.steps.map((step) => step.kind),
    ["intro", "level", "level", "level", "outcome"]
  );
  assert.equal(explanation.steps[3]?.remaining, "0");
});

test("partial fill: remainder rests in the book at the limit price", () => {
  const explanation = explainMatch({
    order: { side: "buy", type: "limit", timeInForce: "gtc", price: "2001", quantity: "2", filledQuantity: "1.2", status: "partially_filled" },
    trades: [
      { price: "2000", quantity: "0.5" },
      { price: "2001", quantity: "0.7" }
    ],
    depthBefore: { bids: [], asks: [lvl("2000", "0.5"), lvl("2001", "0.7"), lvl("2002", "3")] }
  });

  assert.equal(explanation.outcome, "resting");
  assert.equal(explanation.remainingQuantity, "0.8");
  const stop = explanation.steps.find((step) => step.kind === "stop");
  assert.ok(stop, "a stop step explains why matching ended");
  assert.match(stop.detail, /2002/);
  assert.match(stop.detail, /高于限价/);
  const outcome = explanation.steps.at(-1)!;
  assert.equal(outcome.kind, "outcome");
  assert.match(outcome.detail, /挂入买盘/);
  assert.equal(outcome.remaining, "0.8");
});

test("IOC sell: hits bids from the highest price and cancels the remainder", () => {
  const explanation = explainMatch({
    order: { side: "sell", type: "limit", timeInForce: "ioc", price: "1998", quantity: "5", filledQuantity: "3", status: "cancelled" },
    trades: [
      { price: "2000", quantity: "1" },
      { price: "1999", quantity: "2" }
    ],
    depthBefore: { asks: [lvl("2001", "1")], bids: [lvl("1997", "4"), lvl("2000", "1"), lvl("1999", "2")] }
  });

  assert.equal(explanation.bookSide, "bids");
  assert.equal(explanation.outcome, "ioc_cancelled");
  assert.equal(explanation.remainingQuantity, "2");
  assert.deepEqual(
    explanation.levels.map((level) => [level.price, level.state]),
    [
      ["2000", "swept"],
      ["1999", "swept"],
      ["1997", "beyond_limit"]
    ]
  );
  assert.match(explanation.steps.at(-1)!.detail, /IOC/);
  assert.equal(explanation.steps.at(-1)!.remaining, "0");
});

test("market buy that exhausts the book is an IOC remainder cancellation", () => {
  const explanation = explainMatch({
    order: { side: "buy", type: "market", quantity: "3", filledQuantity: "1.5", status: "cancelled" },
    trades: [
      { price: "2000", quantity: "1" },
      // The book moved between the snapshot and submission.
      { price: "2004", quantity: "0.5" }
    ],
    depthBefore: { bids: [], asks: [lvl("2000", "1")] }
  });

  assert.equal(explanation.timeInForce, "ioc");
  assert.equal(explanation.outcome, "ioc_cancelled");
  assert.equal(explanation.levels[1]?.missingFromSnapshot, true);
  assert.match(explanation.steps.find((step) => step.kind === "stop")!.detail, /吃空|用完/);
});

test("FOK without enough liquidity inside the limit is rejected with nothing filled", () => {
  const explanation = explainMatch({
    order: { side: "buy", type: "limit", timeInForce: "fok", price: "2001", quantity: "5", filledQuantity: "0", status: "rejected" },
    trades: [],
    depthBefore: { bids: [], asks: [lvl("2000", "1"), lvl("2001", "2"), lvl("2002", "10"), lvl("2003", "10"), lvl("2004", "1")] }
  });

  assert.equal(explanation.outcome, "fok_rejected");
  assert.equal(explanation.availableWithinLimit, "3");
  assert.equal(explanation.filledQuantity, "0");
  assert.deepEqual(
    explanation.levels.map((level) => level.state),
    ["untouched", "untouched", "beyond_limit", "beyond_limit"]
  );
  assert.deepEqual(explanation.steps.map((step) => step.kind), ["intro", "outcome"]);
  assert.match(explanation.steps[1]!.detail, /FOK/);
});

test("a limit that does not cross the spread rests without trades", () => {
  const explanation = explainMatch({
    order: { side: "sell", type: "limit", timeInForce: "gtc", price: "2010", quantity: "1", filledQuantity: "0", status: "accepted" },
    trades: [],
    depthBefore: { asks: [], bids: [lvl("2000", "1")] }
  });
  assert.equal(explanation.outcome, "rested_no_fill");
  assert.equal(explanation.levels[0]?.state, "beyond_limit");
  assert.match(explanation.steps.find((step) => step.kind === "stop")!.detail, /低于限价/);
});

test("T-accounts group masked entries and the browser re-checks debit == credit per asset", () => {
  const journals: MaskedJournal[] = [
    {
      journalId: "j1",
      businessType: "withdrawal_settled",
      stage: "lock_consume",
      stageLabel: "消耗我的委托冻结的 USDT，划入结算中转账户",
      createdAt: "2026-10-10T00:00:00.000Z",
      entries: [
        { accountRole: "self", accountLabel: "我的现货账户", assetCode: "USDT", direction: "debit", amount: "1000", referenceType: "spot_order" },
        { accountRole: "platform_settlement", accountLabel: "平台结算中转账户（USDT）", assetCode: "USDT", direction: "credit", amount: "1000", referenceType: "spot_order" }
      ],
      totals: [],
      balanced: true
    },
    {
      journalId: "j2",
      businessType: "spot_trade_settlement_quote",
      stage: "settle_quote",
      stageLabel: "交割计价资产 USDT",
      createdAt: "2026-10-10T00:00:00.000Z",
      entries: [
        { accountRole: "platform_settlement", accountLabel: "平台结算中转账户（USDT）", assetCode: "USDT", direction: "debit", amount: "1000", referenceType: "spot_trade" },
        { accountRole: "counterparty", accountLabel: "对手方", assetCode: "USDT", direction: "credit", amount: "999.2", referenceType: "spot_trade" },
        { accountRole: "platform_fee", accountLabel: "平台手续费账户（USDT）", assetCode: "USDT", direction: "credit", amount: "0.8", referenceType: "spot_trade_fee" }
      ],
      totals: [],
      balanced: true
    }
  ];

  const accounts = buildTAccounts(journals);
  assert.deepEqual(
    accounts.map((account) => [account.accountLabel, account.debitTotal, account.creditTotal, account.net]),
    [
      ["我的现货账户", "1000", "0", "-1000"],
      ["对手方", "0", "999.2", "999.2"],
      ["平台结算中转账户（USDT）", "1000", "1000", "0"],
      ["平台手续费账户（USDT）", "0", "0.8", "0.8"]
    ]
  );
  assert.deepEqual(verifyJournalBalance(journals), [
    { assetCode: "USDT", debitTotal: "2000", creditTotal: "2000", balanced: true }
  ]);

  journals[1]!.entries[2]!.amount = "0.7";
  assert.equal(verifyJournalBalance(journals)[0]?.balanced, false);
});
