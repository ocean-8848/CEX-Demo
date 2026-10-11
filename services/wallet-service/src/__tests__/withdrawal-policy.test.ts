import assert from "node:assert/strict";
import test from "node:test";

import {
  applyApproval,
  checkWithdrawalLimits,
  DEFAULT_KYC_TIER_LIMITS,
  describeCooldown,
  evaluateCooldown,
  formatDuration,
  minAmount,
  normalizeKycTier,
  parseTierLimitOverrides,
  readApprovalPolicy,
  readApprovals,
  remainingAmount,
  resolveApprovalPolicy,
  resolveEffectiveLimits,
  utcDayWindow
} from "../domain/withdrawal-policy.js";
import { loadKycTierLimitsFromEnv } from "../infrastructure/withdrawal-validation-rules.js";

test("KYC tier limits grow with the tier and parse env overrides", () => {
  assert.equal(normalizeKycTier("L2"), "L2");
  assert.equal(normalizeKycTier("bogus"), "unverified");
  assert.equal(normalizeKycTier(undefined), "unverified");

  const usdt = (tier: "unverified" | "L1" | "L2") => DEFAULT_KYC_TIER_LIMITS[tier].USDT!;
  assert.ok(Number(usdt("unverified").single) < Number(usdt("L1").single));
  assert.ok(Number(usdt("L1").daily) < Number(usdt("L2").daily));

  assert.deepEqual(
    parseTierLimitOverrides("USDT=50/100, ETH=0.1/0.2,DOGE=1/2,BTC=abc/1,SOL=5", ["USDT", "ETH", "BTC", "SOL"]),
    { USDT: { single: "50", daily: "100" }, ETH: { single: "0.1", daily: "0.2" } }
  );

  const table = loadKycTierLimitsFromEnv({ WITHDRAWAL_KYC_LIMITS_L1: "USDT=7/8" });
  assert.deepEqual(table.L1.USDT, { single: "7", daily: "8" });
  assert.deepEqual(table.L1.ETH, DEFAULT_KYC_TIER_LIMITS.L1.ETH);
  assert.deepEqual(table.unverified.USDT, DEFAULT_KYC_TIER_LIMITS.unverified.USDT);
});

test("effective limits take the stricter of platform and tier limits", () => {
  assert.equal(minAmount(undefined, "5", "3.5", undefined), "3.5");
  assert.equal(minAmount(undefined), undefined);

  const strictTier = resolveEffectiveLimits({
    assetCode: "USDT",
    tier: "unverified",
    tierLimits: DEFAULT_KYC_TIER_LIMITS,
    platformSingleLimit: "10000",
    platformDailyLimit: "20000"
  });
  assert.equal(strictTier.singleLimit, "1000");
  assert.equal(strictTier.dailyLimit, "2000");

  const strictPlatform = resolveEffectiveLimits({
    assetCode: "USDT",
    tier: "L2",
    tierLimits: DEFAULT_KYC_TIER_LIMITS,
    platformSingleLimit: "10000",
    platformDailyLimit: "20000"
  });
  assert.equal(strictPlatform.singleLimit, "10000");
  assert.equal(strictPlatform.dailyLimit, "20000");
  assert.equal(strictPlatform.tierLimit?.single, "100000");

  const noTiers = resolveEffectiveLimits({ assetCode: "ETH", tier: "L1" });
  assert.equal(noTiers.singleLimit, undefined);
  assert.equal(noTiers.dailyLimit, undefined);
});

test("daily usage check counts what was already used today", () => {
  assert.deepEqual(
    checkWithdrawalLimits({ amount: "400", usedToday: "1500", singleLimit: "1000", dailyLimit: "2000" }),
    { ok: true, remainingToday: "500" }
  );
  assert.deepEqual(
    checkWithdrawalLimits({ amount: "500.000000000000000001", usedToday: "1500", singleLimit: "1000", dailyLimit: "2000" }),
    { ok: false, code: "DAILY_LIMIT_EXCEEDED", limit: "2000", remainingToday: "500" }
  );
  assert.deepEqual(
    checkWithdrawalLimits({ amount: "1000.1", usedToday: "0", singleLimit: "1000", dailyLimit: "2000" }),
    { ok: false, code: "SINGLE_LIMIT_EXCEEDED", limit: "1000", remainingToday: "2000" }
  );
  assert.deepEqual(checkWithdrawalLimits({ amount: "1", usedToday: "0" }), { ok: true, remainingToday: undefined });
  assert.equal(remainingAmount("2000", "2500"), "0");
  assert.equal(remainingAmount("1", "0.25"), "0.75");

  assert.deepEqual(utcDayWindow(new Date("2026-05-03T23:59:59.000Z")), {
    startAt: "2026-05-03T00:00:00.000Z",
    endAt: "2026-05-04T00:00:00.000Z"
  });
});

test("dual approval state machine needs two different operators above the threshold", () => {
  assert.deepEqual(resolveApprovalPolicy("5000", "5000"), { requiredApprovals: 1, threshold: "5000" });
  assert.deepEqual(resolveApprovalPolicy("5000.01", "5000"), { requiredApprovals: 2, threshold: "5000" });
  assert.deepEqual(resolveApprovalPolicy("999999", undefined), { requiredApprovals: 1, threshold: undefined });

  const dual = { requiredApprovals: 2 as const, threshold: "5000" };
  const first = applyApproval({ policy: dual, existing: [], operatorId: "ops-a", approvedAt: "t1", note: "ok" });
  assert.equal(first.kind, "pending_second_approval");
  if (first.kind !== "pending_second_approval") {
    return;
  }
  assert.deepEqual(first.approvals, [{ operatorId: "ops-a", approvedAt: "t1", note: "ok" }]);

  const same = applyApproval({ policy: dual, existing: first.approvals, operatorId: " ops-a ", approvedAt: "t2" });
  assert.equal(same.kind, "error");
  assert.equal(same.kind === "error" ? same.code : "", "SAME_APPROVER");

  const anonymous = applyApproval({ policy: dual, existing: [], operatorId: undefined, approvedAt: "t2" });
  assert.equal(anonymous.kind === "error" ? anonymous.code : "", "APPROVER_REQUIRED");

  const second = applyApproval({ policy: dual, existing: first.approvals, operatorId: "ops-b", approvedAt: "t3" });
  assert.equal(second.kind, "approved");
  assert.deepEqual(
    second.kind === "approved" ? second.approvals.map((approval) => approval.operatorId) : [],
    ["ops-a", "ops-b"]
  );

  const single = applyApproval({ policy: { requiredApprovals: 1 }, existing: [], operatorId: undefined, approvedAt: "t1" });
  assert.equal(single.kind, "approved");
});

test("approval metadata round-trips and falls back for legacy withdrawals", () => {
  const metadata = {
    approvalPolicy: { requiredApprovals: 2, threshold: "2" },
    approvals: [{ operatorId: "ops-a", approvedAt: "t1" }, { bogus: true }, "x"]
  };
  assert.deepEqual(readApprovals(metadata), [{ operatorId: "ops-a", approvedAt: "t1", note: undefined }]);
  assert.deepEqual(readApprovalPolicy(metadata, { requiredApprovals: 1 }), { requiredApprovals: 2, threshold: "2" });
  assert.deepEqual(readApprovalPolicy({}, { requiredApprovals: 1 }), { requiredApprovals: 1 });
  assert.deepEqual(readApprovals({}), []);
});

test("security cooldown uses the most recent change and explains remaining time", () => {
  const now = new Date("2026-05-03T10:00:00.000Z");
  const disabled = evaluateCooldown({
    now,
    cooldownSeconds: 0,
    changes: [{ kind: "withdrawal_address_added", at: "2026-05-03T09:59:59.000Z" }]
  });
  assert.equal(disabled.active, false);

  const active = evaluateCooldown({
    now,
    cooldownSeconds: 120,
    changes: [
      { kind: "withdrawal_address_added", at: "2026-05-03T09:58:30.000Z" },
      { kind: "two_factor_changed", at: "2026-05-03T09:59:00.000Z" }
    ]
  });
  assert.equal(active.active, true);
  assert.equal(active.reason, "two_factor_changed");
  assert.equal(active.remainingSeconds, 60);
  assert.equal(active.until, "2026-05-03T10:01:00.000Z");
  const message = describeCooldown(active);
  assert.match(message, /two-factor authentication change/);
  assert.match(message, /1m 0s remaining/);
  assert.match(message, /remainingSeconds=60/);

  const expired = evaluateCooldown({
    now,
    cooldownSeconds: 60,
    changes: [{ kind: "withdrawal_address_added", at: "2026-05-03T09:58:00.000Z" }]
  });
  assert.equal(expired.active, false);
  assert.equal(expired.remainingSeconds, 0);

  assert.equal(evaluateCooldown({ now, cooldownSeconds: 60, changes: [] }).active, false);
  assert.equal(formatDuration(86400), "24h 0m");
  assert.equal(formatDuration(59.2), "1m 0s");
});
