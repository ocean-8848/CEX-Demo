import assert from "node:assert/strict";
import test from "node:test";

import { buildLiabilitySummary, buildUserLiabilities } from "../application/ledger-liabilities.js";

const rows = [
  { userId: "u-2", assetCode: "USDT", available: "100.500000000000000000", locked: "20.000000000000000000" },
  { userId: "u-1", assetCode: "USDT", available: "1000", locked: "0" },
  { userId: "u-1", assetCode: "ETH", available: "1.25", locked: "0.75" },
  { userId: "u-3", assetCode: "ETH", available: "0", locked: "0" }
];

test("buildLiabilitySummary sums available + locked per asset and counts holders", () => {
  const summary = buildLiabilitySummary({ generatedAt: "2026-01-01T00:00:00.000Z", rows });
  assert.equal(summary.userCount, 2, "u-3 holds nothing");
  assert.deepEqual(summary.assets, [
    { assetCode: "ETH", available: "1.25", locked: "0.75", total: "2", userCount: 1 },
    { assetCode: "USDT", available: "1100.5", locked: "20", total: "1120.5", userCount: 2 }
  ]);
});

test("buildUserLiabilities groups by user, drops zero balances and normalizes decimals", () => {
  const list = buildUserLiabilities({ generatedAt: "2026-01-01T00:00:00.000Z", rows });
  assert.deepEqual(list.items, [
    { userId: "u-1", balances: { ETH: "2", USDT: "1000" } },
    { userId: "u-2", balances: { USDT: "120.5" } }
  ]);
});

test("a user with several accounts gets one combined leaf", () => {
  const list = buildUserLiabilities({
    generatedAt: "2026-01-01T00:00:00.000Z",
    rows: [
      { userId: "u-1", assetCode: "USDT", available: "1", locked: "0" },
      { userId: "u-1", assetCode: "USDT", available: "2", locked: "3" }
    ]
  });
  assert.deepEqual(list.items, [{ userId: "u-1", balances: { USDT: "6" } }]);
});
