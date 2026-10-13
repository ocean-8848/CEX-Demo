import assert from "node:assert/strict";
import test from "node:test";

import {
  changeRatio,
  decimalsOf,
  floorToStep,
  formatAmount,
  formatFixed,
  formatPercent,
  marketLabel,
  shortHash
} from "@web3-cex/web-ui";

import {
  describeOrderStatus,
  filledRatio,
  isOpenOrder,
  mergeRecords,
  summarizeBalances,
  takerSide,
  userTradeFee,
  userTradeSide
} from "../client/lib/records.js";
import { describeCooldownError, formatWait, humanizeError } from "../client/lib/api.js";
import { parseHash } from "../client/lib/router.js";

test("format helpers render 18-decimal service strings for humans", () => {
  assert.equal(decimalsOf("0.01"), 2);
  assert.equal(decimalsOf("0.0001"), 4);
  assert.equal(decimalsOf("1"), 0);
  assert.equal(formatFixed("3200.000000000000000000", 2), "3,200.00");
  assert.equal(formatAmount("5.500000000000000000"), "5.5");
  assert.equal(formatAmount(undefined), "--");
  assert.equal(formatPercent(0.0123), "+1.23%");
  assert.equal(formatPercent(-0.5), "-50.00%");
  assert.equal(marketLabel("ETH-USDT"), "ETH/USDT");
  assert.equal(shortHash("0x1234567890abcdef1234"), "0x1234…1234");
});

test("changeRatio ignores tickers without a reference price", () => {
  assert.equal(changeRatio("0", "0"), null);
  assert.equal(changeRatio("110", "100"), 0.1);
});

test("floorToStep never rounds an order quantity up", () => {
  assert.equal(floorToStep(0.123456, "0.001"), "0.123");
  assert.equal(floorToStep(7.8124 / 3200 * 3200, "0.001"), "7.812");
  assert.equal(floorToStep(0.0004, "0.001"), "");
  assert.equal(floorToStep(1, "0.0001"), "1.0000");
});

test("order helpers classify lifecycle states", () => {
  assert.equal(isOpenOrder({ orderId: "1", status: "partially_filled" }), true);
  assert.equal(isOpenOrder({ orderId: "1", status: "filled" }), false);
  assert.equal(describeOrderStatus("accepted").label, "挂单中");
  assert.equal(filledRatio({ orderId: "1", quantity: "2", filledQuantity: "0.5" }), 0.25);
});

test("trade helpers derive sides and fees from the user's perspective", () => {
  const trade = {
    tradeId: "t1",
    price: "3000",
    quantity: "2",
    buyerOrderId: "b",
    sellerOrderId: "s",
    takerOrderId: "s",
    buyerUserId: "alice",
    sellerUserId: "bob",
    sellerFeeRate: "0.001",
    buyerFeeRate: "0.0005"
  };
  assert.equal(takerSide(trade), "sell");
  assert.equal(userTradeSide(trade, "alice"), "buy");
  assert.equal(userTradeSide(trade, "bob"), "sell");
  assert.deepEqual(userTradeFee(trade, "bob"), { amount: 6, asset: "quote" });
  assert.deepEqual(userTradeFee(trade, "alice"), { amount: 0.001, asset: "base" });
});

test("mergeRecords upserts by key and keeps newest first", () => {
  const merged = mergeRecords(
    [
      { orderId: "a", status: "accepted", updatedAt: "2026-01-01T00:00:00Z" },
      { orderId: "b", status: "accepted", updatedAt: "2026-01-01T00:00:01Z" }
    ],
    [{ orderId: "a", status: "filled", updatedAt: "2026-01-01T00:00:02Z" }],
    (item) => item.orderId
  );
  assert.deepEqual(
    merged.map((item) => `${item.orderId}:${item.status}`),
    ["a:filled", "b:accepted"]
  );
});

test("summarizeBalances aggregates spot balances per asset", () => {
  const summary = summarizeBalances([
    { accountId: "acct", accountType: "spot", assetCode: "ETH", available: "1.5", locked: "0.5" },
    { accountId: "acct", accountType: "spot", assetCode: "USDT", available: "100", locked: "0" },
    { accountId: "fee", accountType: "fee", assetCode: "USDT", available: "999", locked: "0" }
  ], ["USDT", "ETH"]);
  assert.deepEqual(
    summary.map((item) => [item.assetCode, item.available, item.locked, item.total]),
    [
      ["USDT", 100, 0, 100],
      ["ETH", 1.5, 0.5, 2]
    ]
  );
});

test("parseHash maps hash routes to pages", () => {
  assert.deepEqual(
    (({ page, params }) => ({ page, params }))(parseHash("#/trade/BTC-USDT")),
    { page: "trade", params: ["BTC-USDT"] }
  );
  const assets = parseHash("#/assets?action=withdraw&asset=ETH");
  assert.equal(assets.page, "assets");
  assert.equal(assets.query.get("action"), "withdraw");
  assert.equal(parseHash("#/unknown").page, "home");
  assert.equal(parseHash("").page, "home");
});

test("security error hints map M4/M5 wallet codes to actionable Chinese messages", () => {
  const notEnabled = humanizeError(
    'Wallet service rejected request: {"code":"WITHDRAWAL_2FA_NOT_ENABLED","message":"Two-factor authentication must be enabled"}',
    "WALLET_UPSTREAM_FAILED"
  );
  assert.match(notEnabled, /^请先在账户页开启二次验证/);

  const cooldown = humanizeError(
    "Withdrawals are locked for 2m 0s after adding a new withdrawal address; 1m 58s remaining (remainingSeconds=118, until x)",
    "WITHDRAWAL_SECURITY_COOLDOWN"
  );
  assert.equal(cooldown, "安全冷却期：新增提现地址后暂停提现，还需等待 1 分 58 秒");
  assert.match(describeCooldownError("WITHDRAWAL_SECURITY_COOLDOWN after a two-factor authentication change remainingSeconds=90000") ?? "", /修改二次验证.*25 小时 0 分/);
  assert.equal(describeCooldownError("other"), null);
  assert.equal(formatWait(5), "5 秒");

  assert.match(humanizeError("Recovery code is invalid", "TWO_FACTOR_RECOVERY_CODE_INVALID"), /^恢复码无效/);
  assert.match(humanizeError("Withdrawal amount exceeds the daily limit of 2000 USDT (KYC tier unverified)"), /KYC 等级/);
});

test("emergency switch codes map to Chinese hints", () => {
  assert.match(humanizeError("USDT withdrawals are paused (drill)", "ASSET_WITHDRAWALS_PAUSED"), /^该币种提现已被平台暂停/);
  assert.match(humanizeError("All withdrawals are paused", "WITHDRAWALS_PAUSED"), /^平台已暂停全部提现/);
  assert.match(humanizeError("The exchange is in read-only mode", "API_WRITE_FROZEN"), /^平台处于只读模式/);
});

test("fee tier helpers use the user's VIP rate and the rate recorded on the trade", async () => {
  const { effectiveRateFor, formatRate, userTradeFeeRate } = await import("../client/lib/fee-tier.js");
  const profile = {
    userId: "alice",
    tier: "VIP2",
    name: "VIP 2",
    source: "volume" as const,
    makerFeeRate: "0.0003",
    takerFeeRate: "0.0008",
    volume: "600000",
    volumeAsset: "USDT",
    volumeWindowDays: 30,
    nextTier: null,
    remainingVolume: "0",
    progressRatio: 1,
    override: null,
    marketMaker: null,
    markets: [{ market: "ETH-USDT", makerFeeRate: "0.0003", takerFeeRate: "0.0008" }],
    tiers: []
  };
  const market = { makerFeeRate: "0.0005", takerFeeRate: "0.001" };
  assert.equal(effectiveRateFor(profile, "ETH-USDT", "taker", market), 0.0008);
  assert.equal(effectiveRateFor(null, "ETH-USDT", "taker", market), 0.001, "logged out: market default");
  assert.equal(effectiveRateFor(profile, "BTC-USDT", "maker", market), 0.0005, "unknown market falls back");
  const trade = {
    tradeId: "t1",
    price: "3000",
    quantity: "2",
    buyerOrderId: "b",
    sellerOrderId: "s",
    buyerUserId: "alice",
    sellerUserId: "bob",
    sellerFeeRate: "0.0005",
    buyerFeeRate: "0.0008",
    buyerFeeTier: "VIP2"
  };
  assert.deepEqual(userTradeFeeRate(trade, "alice"), { rate: 0.0008, tier: "VIP2" });
  assert.deepEqual(userTradeFeeRate(trade, "bob"), { rate: 0.0005, tier: undefined });
  assert.equal(formatRate(0.001), "0.1%");
  assert.equal(formatRate("0.0008"), "0.08%");
});
