import test from "node:test";
import assert from "node:assert/strict";

import { entryToLine, lockEventToLine } from "../application/account-statement.js";
import { LedgerApplicationService } from "../application/ledger-application-service.js";
import { InMemoryLedgerRepository } from "../infrastructure/in-memory-ledger-repository.js";

function createService() {
  const repository = new InMemoryLedgerRepository();
  let tick = 0;
  let id = 0;
  const service = new LedgerApplicationService(repository, {
    // Every call moves the clock so the history has a strict order.
    now: () => new Date(Date.parse("2026-03-07T00:00:00.000Z") + tick++ * 1000),
    createId: () => `id_${String(++id).padStart(4, "0")}`
  });
  return { repository, service };
}

async function seedHistory() {
  const context = createService();
  const { service } = context;
  await service.createAccount({ accountId: "user-spot", userId: "user-1", accountType: "spot" });
  await service.createAccount({ accountId: "chain-source", accountType: "opening_balance" });
  await service.createAccount({ accountId: "withdrawal-settlement", accountType: "spot" });
  await service.createAccount({ accountId: "quote-settlement", accountType: "spot" });
  await service.createAccount({ accountId: "base-settlement", accountType: "opening_balance" });
  await service.createAccount({ accountId: "fee-eth", accountType: "fee" });

  // 1. Deposit 1000 USDT.
  await service.postJournal({
    businessType: "deposit_confirmed",
    businessId: "dep-1",
    idempotencyKey: "deposit:dep-1",
    traceId: "deposit:dep-1",
    entries: [
      { accountId: "chain-source", assetCode: "USDT", direction: "debit", amount: "1000", referenceType: "deposit", referenceId: "dep-1" },
      { accountId: "user-spot", assetCode: "USDT", direction: "credit", amount: "1000", referenceType: "deposit", referenceId: "dep-1" }
    ]
  });

  // 2. Withdrawal: freeze 101, then it is confirmed on chain and consumed.
  await service.freezeBalance({ accountId: "user-spot", assetCode: "USDT", amount: "101", referenceType: "withdrawal", referenceId: "wd-1" });
  await service.consumeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    referenceType: "withdrawal",
    referenceId: "wd-1",
    settlementAccountId: "withdrawal-settlement"
  });

  // 3. Buy order locks 500 USDT, one trade consumes 300, cancel releases 200.
  await service.freezeBalance({ accountId: "user-spot", assetCode: "USDT", amount: "500", referenceType: "spot_order", referenceId: "ord-1" });
  await service.consumeBalance({
    accountId: "user-spot",
    assetCode: "USDT",
    referenceType: "spot_order",
    referenceId: "ord-1",
    amount: "300",
    businessId: "trade-1",
    settlementAccountId: "quote-settlement"
  });
  // Buyer receives base net of the base-asset fee.
  await service.postJournal({
    businessType: "spot_trade_settlement_base",
    businessId: "trade-1",
    idempotencyKey: "spot_trade:base:trade-1",
    traceId: "trade:trade-1",
    entries: [
      { accountId: "base-settlement", assetCode: "ETH", direction: "debit", amount: "0.1", referenceType: "spot_trade", referenceId: "trade-1" },
      { accountId: "user-spot", assetCode: "ETH", direction: "credit", amount: "0.0999", referenceType: "spot_trade", referenceId: "trade-1" },
      { accountId: "fee-eth", assetCode: "ETH", direction: "credit", amount: "0.0001", referenceType: "spot_trade_fee", referenceId: "trade-1" }
    ]
  });
  await service.releaseBalance({ accountId: "user-spot", assetCode: "USDT", referenceType: "spot_order", referenceId: "ord-1" });

  return context;
}

test("account statement merges entries and lock events with replayed running balances", async () => {
  const { service } = await seedHistory();

  const statement = await service.getAccountStatement({ accountId: "user-spot" });
  // The settled balance.consumed events are folded into their journal debits.
  assert.equal(statement.total, 7);
  assert.deepEqual(statement.balanceDerivable, { USDT: true, ETH: true });
  assert.deepEqual(
    statement.items.map((line) => `${line.assetCode}:${line.action}:${line.totalDelta}`),
    [
      "USDT:order_release:0",
      "ETH:trade_credit:0.0999",
      "USDT:trade_debit:-300",
      "USDT:order_freeze:0",
      "USDT:withdrawal_debit:-101",
      "USDT:withdrawal_freeze:0",
      "USDT:deposit_credit:1000"
    ]
  );

  // Newest first; the latest USDT line ends on the real balance snapshot.
  const latestUsdt = statement.items.find((line) => line.assetCode === "USDT");
  assert.equal(latestUsdt?.action, "order_release");
  assert.deepEqual(latestUsdt?.balanceAfter, { total: "599", available: "599", locked: "0" });
  const balance = await service.getBalance("user-spot", "USDT");
  assert.equal(balance.available, "599");

  const deposit = statement.items.at(-1);
  assert.equal(deposit?.action, "deposit_credit");
  assert.equal(deposit?.category, "deposit");
  assert.equal(deposit?.referenceId, "dep-1");
  assert.deepEqual(deposit?.balanceAfter, { total: "1000", available: "1000", locked: "0" });

  const withdrawalFreeze = statement.items.find((line) => line.action === "withdrawal_freeze");
  assert.deepEqual(withdrawalFreeze?.balanceAfter, { total: "1000", available: "899", locked: "101" });
  assert.equal(withdrawalFreeze?.availableDelta, "-101");
  const withdrawalDebit = statement.items.find((line) => line.action === "withdrawal_debit");
  assert.deepEqual(withdrawalDebit?.balanceAfter, { total: "899", available: "899", locked: "0" });
  assert.equal(withdrawalDebit?.lockedDelta, "-101");

  const tradeDebit = statement.items.find((line) => line.action === "trade_debit");
  assert.equal(tradeDebit?.category, "trade");
  assert.equal(tradeDebit?.businessId, "trade-1", "trade debit links to the trade");
  assert.equal(tradeDebit?.referenceId, "ord-1");
  assert.deepEqual(tradeDebit?.balanceAfter, { total: "599", available: "399", locked: "200" });

  const tradeCredit = statement.items.find((line) => line.action === "trade_credit");
  assert.equal(tradeCredit?.feeAmount, "0.0001");
  assert.equal(tradeCredit?.feeAssetCode, "ETH");
  assert.deepEqual(tradeCredit?.balanceAfter, { total: "0.0999", available: "0.0999", locked: "0" });
});

test("account statement filters by asset, category, fee, lock visibility, date range and paginates", async () => {
  const { service } = await seedHistory();

  const eth = await service.getAccountStatement({ accountId: "user-spot", assetCode: "ETH" });
  assert.deepEqual(eth.items.map((line) => line.action), ["trade_credit"]);
  assert.deepEqual(eth.balanceDerivable, { ETH: true });

  const withdrawals = await service.getAccountStatement({ accountId: "user-spot", category: "withdrawal" });
  assert.deepEqual(withdrawals.items.map((line) => line.action), ["withdrawal_debit", "withdrawal_freeze"]);

  const fees = await service.getAccountStatement({ accountId: "user-spot", category: "fee" });
  assert.deepEqual(fees.items.map((line) => line.action), ["trade_credit"]);

  const noLocks = await service.getAccountStatement({ accountId: "user-spot", includeLockEvents: false });
  assert.equal(noLocks.items.some((line) => line.source === "lock_event"), false);
  assert.equal(noLocks.total, 4);

  const byBusinessType = await service.getAccountStatement({ accountId: "user-spot", businessType: "deposit_confirmed" });
  assert.deepEqual(byBusinessType.items.map((line) => line.action), ["deposit_credit"]);

  const all = await service.getAccountStatement({ accountId: "user-spot" });
  const pivot = all.items[2]!.occurredAt;
  const before = await service.getAccountStatement({ accountId: "user-spot", to: pivot });
  assert.equal(before.total, all.total - 3);
  const since = await service.getAccountStatement({ accountId: "user-spot", from: pivot });
  assert.equal(since.total, 3);
  // Running balances are computed on the full history, not on the filtered page.
  assert.deepEqual(since.items[2]?.balanceAfter, all.items[2]?.balanceAfter);

  const page = await service.getAccountStatement({ accountId: "user-spot", limit: 2, offset: 2 });
  assert.equal(page.total, all.total);
  assert.deepEqual(page.items.map((line) => line.lineId), all.items.slice(2, 4).map((line) => line.lineId));
});

test("running balances are hidden when history cannot explain the snapshot", async () => {
  const { repository, service } = await seedHistory();
  // A balance written outside of journals (legacy seed) breaks the replay.
  const current = await service.getBalance("user-spot", "USDT");
  await repository.saveBalance({ ...current, available: "10000" });

  const statement = await service.getAccountStatement({ accountId: "user-spot" });
  assert.equal(statement.balanceDerivable.USDT, false);
  assert.equal(statement.balanceDerivable.ETH, true);
  assert.equal(statement.items.find((line) => line.assetCode === "USDT")?.balanceAfter, undefined);
  assert.ok(statement.items.find((line) => line.assetCode === "ETH")?.balanceAfter);
});

test("statement line mapping normalizes amounts and skips settled consumption events", () => {
  const line = entryToLine({
    entryId: "e-1",
    journalId: "j-1",
    accountId: "a",
    assetCode: "USDT",
    direction: "debit",
    amount: "12.500000000000000000",
    businessType: "withdrawal_settled",
    businessId: "wd-9",
    traceId: "t",
    referenceType: "withdrawal",
    referenceId: "wd-9",
    createdAt: "2026-03-07T00:00:00.000Z"
  });
  assert.equal(line.amount, "12.5");
  assert.equal(line.totalDelta, "-12.5");
  assert.equal(line.lockedDelta, "-12.5");
  assert.equal(line.availableDelta, "0");
  assert.equal(line.action, "withdrawal_debit");

  // Spot-order lock consumption: new and legacy business type names both reduce locked.
  for (const businessType of ["spot_order_lock_settled", "withdrawal_settled"]) {
    const tradeDebit = entryToLine({
      entryId: `e-${businessType}`,
      journalId: "j-2",
      accountId: "a",
      assetCode: "USDT",
      direction: "debit",
      amount: "300",
      businessType,
      businessId: "trade-9",
      traceId: "t",
      referenceType: "spot_order",
      referenceId: "ord-9",
      createdAt: "2026-03-07T00:00:00.000Z"
    });
    assert.equal(tradeDebit.action, "trade_debit");
    assert.equal(tradeDebit.category, "trade");
    assert.equal(tradeDebit.lockedDelta, "-300");
    assert.equal(tradeDebit.availableDelta, "0");
  }

  assert.equal(
    lockEventToLine({
      eventId: "ev-1",
      eventType: "balance.consumed",
      assetCode: "USDT",
      amount: "1",
      referenceType: "withdrawal",
      referenceId: "wd-9",
      settled: true,
      createdAt: "2026-03-07T00:00:00.000Z"
    }),
    null
  );
});
