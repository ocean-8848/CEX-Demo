import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FEE_TIER_CONFIG,
  FeeTierConfigError,
  describeFeeTierProgress,
  effectiveFeeRate,
  feeTierForVolume,
  isMarketMakerUser,
  listSpotMarketDefinitions,
  multiplyAmounts,
  parseFeeTierConfig,
  resolveFeeTier,
  resolveFeeTierConfigPath
} from "../index.js";

function rawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveFeeTierConfigPath(), "utf8")) as Record<string, unknown>;
}

function expectIssue(raw: unknown, pattern: RegExp) {
  assert.throws(
    () => parseFeeTierConfig(raw),
    (error: unknown) => {
      assert.ok(error instanceof FeeTierConfigError);
      assert.ok(
        error.issues.some((issue) => pattern.test(issue)),
        `expected an issue matching ${pattern}, got:\n${error.issues.join("\n")}`
      );
      return true;
    }
  );
}

const config = parseFeeTierConfig({
  version: 1,
  volumeAsset: "USDT",
  volumeWindowDays: 30,
  tiers: [
    { tier: "VIP0", minVolume: "0", makerFeeRate: "0.0005", takerFeeRate: "0.001" },
    { tier: "VIP1", minVolume: "100000", makerFeeRate: "0.0004", takerFeeRate: "0.0009" },
    { tier: "VIP2", minVolume: "500000", makerFeeRate: "0.0003", takerFeeRate: "0.0008" }
  ],
  marketMakers: [{ userId: "mm-1", label: "做市商", feeTier: "VIP0" }]
});

test("shipped config: VIP0 equals the current default market rates", () => {
  const vip0 = FEE_TIER_CONFIG.tiers[0];
  assert.equal(vip0?.minVolume, "0");
  for (const market of listSpotMarketDefinitions()) {
    // min(VIP0, market) must be the market rate, so VIP0 users pay exactly what they paid before tiers.
    assert.equal(effectiveFeeRate(vip0, market, "maker"), market.makerFeeRate, market.market);
    assert.equal(effectiveFeeRate(vip0, market, "taker"), market.takerFeeRate, market.market);
  }
  assert.ok(isMarketMakerUser("10000000-0000-0000-0000-000000000301"), "demo ask maker is in the programme");
});

test("tier resolution by trailing volume uses inclusive thresholds", () => {
  assert.equal(feeTierForVolume(config, "0").tier, "VIP0");
  assert.equal(feeTierForVolume(config, "99999.99").tier, "VIP0");
  assert.equal(feeTierForVolume(config, "100000").tier, "VIP1");
  assert.equal(feeTierForVolume(config, "750000").tier, "VIP2");
});

test("override beats programme beats volume", () => {
  assert.deepEqual(resolveFeeTier(config, { userId: "u1", volume: "120000" }), {
    tier: "VIP1",
    name: "VIP1",
    source: "volume",
    makerFeeRate: "0.0004",
    takerFeeRate: "0.0009"
  });
  assert.equal(resolveFeeTier(config, { userId: "mm-1", volume: "900000" }).tier, "VIP0");
  assert.equal(resolveFeeTier(config, { userId: "mm-1", volume: "900000" }).source, "programme");
  const overridden = resolveFeeTier(config, { userId: "mm-1", volume: "0", overrideTier: "VIP2" });
  assert.equal(overridden.tier, "VIP2");
  assert.equal(overridden.source, "override");
  // Unknown override (e.g. a tier removed from config) falls back instead of failing trades.
  assert.equal(resolveFeeTier(config, { userId: "u1", volume: "0", overrideTier: "VIP9" }).source, "volume");
});

test("effective rate is min(tier, market) and fees follow the resolved rate", () => {
  const market = { makerFeeRate: "0.0005", takerFeeRate: "0.001" };
  const vip2 = resolveFeeTier(config, { volume: "600000" });
  assert.equal(effectiveFeeRate(vip2, market, "maker"), "0.0003");
  assert.equal(effectiveFeeRate(vip2, market, "taker"), "0.0008");
  // Promotional market cheaper than the tier keeps the market rate.
  assert.equal(effectiveFeeRate(vip2, { makerFeeRate: "0", takerFeeRate: "0.0005" }, "taker"), "0.0005");
  assert.equal(effectiveFeeRate(undefined, market, "taker"), "0.001");
  // Seller fee on 2 ETH @ 3200 as VIP2 taker.
  assert.equal(multiplyAmounts(multiplyAmounts("3200", "2"), effectiveFeeRate(vip2, market, "taker")), "5.12");
});

test("progress to the next tier", () => {
  const progress = describeFeeTierProgress(config, "25000");
  assert.equal(progress.current.tier, "VIP0");
  assert.equal(progress.next?.tier, "VIP1");
  assert.equal(progress.remainingVolume, "75000");
  assert.equal(progress.progressRatio, 0.25);
  const top = describeFeeTierProgress(config, "900000");
  assert.equal(top.next, undefined);
  assert.equal(top.remainingVolume, "0");
});

test("validator rejects inconsistent ladders", () => {
  const raw = rawConfig();
  const tiers = raw.tiers as Array<Record<string, unknown>>;
  expectIssue({ ...raw, tiers: [{ ...tiers[0], minVolume: "10" }, ...tiers.slice(1)] }, /must be 0/);
  expectIssue({ ...raw, tiers: [tiers[0], { ...tiers[1], minVolume: "0" }] }, /must be greater than/);
  expectIssue({ ...raw, tiers: [tiers[0], { ...tiers[1], takerFeeRate: "0.5" }] }, /must not exceed/);
  expectIssue({ ...raw, tiers: [tiers[0], { ...tiers[0] }] }, /duplicated/);
  expectIssue({ ...raw, volumeAsset: "DOGE" }, /volumeAsset/);
  expectIssue({ ...raw, marketMakers: [{ userId: "x", label: "m", feeTier: "VIP9" }] }, /feeTier/);
  expectIssue({ ...raw, extra: true }, /unknown top-level key extra/);
});
