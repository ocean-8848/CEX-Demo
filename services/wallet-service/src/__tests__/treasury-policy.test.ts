import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReserveReconciliation,
  computeTreasuryHoldings,
  evaluateHotWalletWatermark,
  formatRatio,
  parseAssetAmountMap,
  parseHotWalletWatermarks,
  planSweeps
} from "../domain/treasury-policy.js";
import type { TreasuryTransferTotal } from "../domain/treasury-types.js";

const total = (overrides: Partial<TreasuryTransferTotal>): TreasuryTransferTotal => ({
  kind: "sweep",
  fromWallet: "deposit",
  toWallet: "hot",
  assetCode: "USDT",
  network: "ethereum",
  status: "confirmed",
  amount: "0",
  count: 1,
  ...overrides
});

test("parseHotWalletWatermarks computes the midpoint target and rejects bad ranges", () => {
  const watermarks = parseHotWalletWatermarks("usdt=50000/200000, ETH=10/40");
  assert.deepEqual(watermarks.USDT, { low: "50000", high: "200000", target: "125000" });
  assert.deepEqual(watermarks.ETH, { low: "10", high: "40", target: "25" });
  assert.deepEqual(parseHotWalletWatermarks(""), {});
  assert.throws(() => parseHotWalletWatermarks("ETH=40/10"), /low < high/);
  assert.throws(() => parseHotWalletWatermarks("ETH=0/10"), /low < high/);
  assert.throws(() => parseHotWalletWatermarks("ETH:1-2"), /expected/);
  assert.deepEqual(parseAssetAmountMap("USDT=10,eth=0.01"), { USDT: "10", ETH: "0.01" });
});

test("computeTreasuryHoldings derives deposit / hot / cold / in-transit balances", () => {
  const [usdt] = computeTreasuryHoldings({
    creditedDeposits: [{ assetCode: "USDT", network: "ethereum", amount: "1000", count: 3 }],
    sentWithdrawals: [
      { assetCode: "USDT", network: "ethereum", status: "confirmed", amount: "200", fee: "1", count: 1 },
      { assetCode: "USDT", network: "ethereum", status: "broadcasted", amount: "50", fee: "1", count: 1 }
    ],
    transferTotals: [
      total({ kind: "genesis", fromWallet: "external", toWallet: "hot", amount: "100000" }),
      total({ kind: "genesis", fromWallet: "external", toWallet: "cold", amount: "900000" }),
      total({ kind: "sweep", status: "confirmed", amount: "600" }),
      total({ kind: "sweep", status: "broadcasted", amount: "300" }),
      total({ kind: "sweep", status: "failed", amount: "999" }),
      total({ kind: "rebalance_to_cold", fromWallet: "hot", toWallet: "cold", status: "confirmed", amount: "10000" }),
      total({ kind: "rebalance_to_hot", fromWallet: "cold", toWallet: "hot", status: "broadcasted", amount: "5000" }),
      total({ kind: "rebalance_to_hot", fromWallet: "cold", toWallet: "hot", status: "proposed", amount: "77777" })
    ]
  });
  assert.ok(usdt);
  assert.equal(usdt.depositAddresses, "100", "1000 credited - 600 confirmed - 300 in-flight sweep");
  assert.equal(usdt.hot, "90350", "100000 + 600 - 10000 - 200 - 50");
  assert.equal(usdt.cold, "905000", "900000 + 10000 - 5000");
  assert.equal(usdt.internalInTransit, "5300");
  assert.equal(usdt.total, "1000750");
  assert.equal(usdt.withdrawalsInFlight, "50");
  assert.equal(usdt.withdrawalsInFlightCount, 1);
  assert.equal(usdt.genesis, "1000000");
});

test("internal transfers never change the platform total, withdrawals do", () => {
  const base = {
    creditedDeposits: [{ assetCode: "ETH", network: "ethereum" as const, amount: "5", count: 1 }],
    sentWithdrawals: []
  };
  const before = computeTreasuryHoldings({ ...base, transferTotals: [] })[0]!;
  const during = computeTreasuryHoldings({
    ...base,
    transferTotals: [total({ assetCode: "ETH", status: "broadcasted", amount: "5" })]
  })[0]!;
  const after = computeTreasuryHoldings({
    ...base,
    transferTotals: [total({ assetCode: "ETH", status: "confirmed", amount: "5" })]
  })[0]!;
  assert.equal(before.total, "5");
  assert.equal(during.total, "5");
  assert.equal(after.total, "5");
  assert.equal(after.hot, "5");
  assert.equal(after.depositAddresses, "0");
});

test("computeTreasuryHoldings lists configured assets without activity", () => {
  const holdings = computeTreasuryHoldings({
    creditedDeposits: [],
    sentWithdrawals: [],
    transferTotals: [],
    assets: [{ assetCode: "SOL", network: "ethereum" }]
  });
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0]?.total, "0");
});

test("planSweeps groups by deposit address and skips dust", () => {
  const plans = planSweeps(
    [
      { depositId: "d2", userId: "u1", assetCode: "USDT", network: "ethereum", address: "0xa", amount: "10" },
      { depositId: "d1", userId: "u1", assetCode: "USDT", network: "ethereum", address: "0xa", amount: "5.5" },
      { depositId: "d3", userId: "u2", assetCode: "USDT", network: "ethereum", address: "0xb", amount: "0.5" },
      { depositId: "d4", userId: "u1", assetCode: "ETH", network: "ethereum", address: "0xa", amount: "1" }
    ],
    { USDT: "1" }
  );
  assert.deepEqual(plans, [
    { assetCode: "ETH", network: "ethereum", fromAddress: "0xa", amount: "1", depositIds: ["d4"] },
    { assetCode: "USDT", network: "ethereum", fromAddress: "0xa", amount: "15.5", depositIds: ["d1", "d2"] }
  ]);
});

test("evaluateHotWalletWatermark proposes hot->cold above high and cold->hot below low", () => {
  const watermark = { low: "10", high: "40", target: "25" };
  const holdings = (hot: string, cold = "100") => ({ assetCode: "ETH", network: "ethereum" as const, hot, cold });

  const above = evaluateHotWalletWatermark({ holdings: holdings("55.123456789"), watermark, hasOpenRebalance: false });
  assert.equal(above.state, "above_high");
  assert.equal(above.proposal?.kind, "rebalance_to_cold");
  assert.equal(above.proposal?.amount, "30.12345678", "floored to 8 decimals");

  const below = evaluateHotWalletWatermark({ holdings: holdings("4"), watermark, hasOpenRebalance: false });
  assert.equal(below.proposal?.kind, "rebalance_to_hot");
  assert.equal(below.proposal?.amount, "21");

  const capped = evaluateHotWalletWatermark({ holdings: holdings("4", "3"), watermark, hasOpenRebalance: false });
  assert.equal(capped.proposal?.amount, "3", "never more than the cold wallet holds");

  const empty = evaluateHotWalletWatermark({ holdings: holdings("4", "0"), watermark, hasOpenRebalance: false });
  assert.equal(empty.proposal, undefined);
  assert.match(empty.skippedReason ?? "", /冷钱包余额不足/);

  const within = evaluateHotWalletWatermark({ holdings: holdings("25"), watermark, hasOpenRebalance: false });
  assert.equal(within.state, "within");
  assert.equal(within.proposal, undefined);

  const open = evaluateHotWalletWatermark({ holdings: holdings("100"), watermark, hasOpenRebalance: true });
  assert.equal(open.state, "above_high");
  assert.equal(open.proposal, undefined, "one open rebalance per asset");

  assert.equal(evaluateHotWalletWatermark({ holdings: holdings("100"), hasOpenRebalance: false }).state, "unconfigured");
});

test("buildReserveReconciliation compares reserves with liabilities net of in-flight withdrawals", () => {
  const holdings = computeTreasuryHoldings({
    creditedDeposits: [{ assetCode: "USDT", network: "ethereum", amount: "1000", count: 1 }],
    sentWithdrawals: [{ assetCode: "USDT", network: "ethereum", status: "broadcasted", amount: "100", fee: "1", count: 1 }],
    transferTotals: [
      total({ kind: "genesis", fromWallet: "external", toWallet: "cold", amount: "5000" }),
      total({ kind: "genesis", fromWallet: "external", toWallet: "hot", assetCode: "ETH", amount: "1" })
    ]
  });
  const report = buildReserveReconciliation({
    generatedAt: "2026-01-01T00:00:00.000Z",
    holdings,
    liabilities: [
      { assetCode: "USDT", total: "4500" },
      { assetCode: "ETH", total: "2" },
      { assetCode: "BTC", total: "0" }
    ]
  });
  const usdt = report.items.find((item) => item.assetCode === "USDT")!;
  assert.equal(usdt.reserves, "5900", "1000 deposits + 5000 cold - 100 paid out");
  assert.equal(usdt.netLiabilities, "4400", "4500 - 100 in flight");
  assert.equal(usdt.surplus, "1500");
  assert.equal(usdt.reserveRatio, "1.3409");
  assert.equal(usdt.status, "covered");

  const eth = report.items.find((item) => item.assetCode === "ETH")!;
  assert.equal(eth.status, "shortfall");
  assert.equal(eth.reserveRatio, "0.5000");
  assert.equal(eth.surplus, "-1");

  const btc = report.items.find((item) => item.assetCode === "BTC")!;
  assert.equal(btc.status, "no_liabilities");
  assert.equal(btc.reserveRatio, undefined);

  assert.equal(report.status, "shortfall");
  assert.equal(report.shortfallCount, 1);
});

test("formatRatio floors to 4 decimals", () => {
  assert.equal(formatRatio("2", "3"), "0.6666");
  assert.equal(formatRatio("3", "3"), "1.0000");
  assert.equal(formatRatio("1", "0"), undefined);
});
