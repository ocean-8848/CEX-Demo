import assert from "node:assert/strict";
import test from "node:test";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { IdentityClient } from "../domain/identity-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import type { WithdrawalValidationRules } from "../domain/types.js";
import { DEFAULT_KYC_TIER_LIMITS } from "../domain/withdrawal-policy.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

const USER = "user-sec-1";
const ACCOUNT = "ledger-sec-1";
const ADDRESS = "0x7777777777777777777777777777777777777777";

function createHarness(options: {
  rules?: WithdrawalValidationRules;
  twoFactorEnabled?: boolean;
  twoFactorChangedAt?: string;
  kycTier?: string;
  start?: string;
}) {
  let nowMs = new Date(options.start ?? "2026-05-03T10:00:00.000Z").getTime();
  let idCounter = 0;
  const identity = {
    twoFactorEnabled: options.twoFactorEnabled ?? false,
    twoFactorChangedAt: options.twoFactorChangedAt,
    kycTier: options.kycTier ?? "unverified",
    verifiedCodes: [] as string[]
  };
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("unexpected");
    },
    async freezeBalance() {
      return { lockId: "lock" };
    },
    async releaseBalance() {
      return { lockId: "lock" };
    },
    async consumeBalance() {
      return { lockId: "lock" };
    }
  };
  const custodyCalls: string[] = [];
  const custodyClient: CustodyClient = {
    async createTransfer(command) {
      custodyCalls.push(command.withdrawalId);
      return {
        providerName: "mock-custody",
        custodyRequestId: `custody-${command.withdrawalId}`,
        txHash: `0x${"a".repeat(63)}${custodyCalls.length}`
      };
    }
  };
  const identityClient: IdentityClient = {
    async getTwoFactorStatus(userId) {
      return {
        userId,
        enabled: identity.twoFactorEnabled,
        pendingEnrollment: false,
        changedAt: identity.twoFactorChangedAt
      };
    },
    async verifyTwoFactor(command) {
      identity.verifiedCodes.push(command.code);
      return { verifiedAt: new Date(nowMs).toISOString(), purpose: command.purpose };
    },
    async getKycProfile(userId) {
      return { userId, tier: identity.kycTier };
    }
  };

  const service = new WalletApplicationService(
    repository,
    ledgerClient,
    custodyClient,
    {
      now: () => new Date(nowMs),
      createId: () => `withdrawal-${++idCounter}`,
      withdrawalValidationRules: options.rules ?? {}
    },
    identityClient
  );

  return {
    service,
    repository,
    identity,
    custodyCalls,
    advance(seconds: number) {
      nowMs += seconds * 1000;
    }
  };
}

function withdrawal(amount: string, extra: Record<string, unknown> = {}) {
  return {
    userId: USER,
    ledgerAccountId: ACCOUNT,
    assetCode: "USDT" as const,
    network: "ethereum" as const,
    toAddress: ADDRESS,
    amount,
    fee: "1",
    ...extra
  };
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

test("WITHDRAWAL_REQUIRE_2FA rejects users without 2FA with a clear code", async () => {
  const { service } = createHarness({ rules: { requireTwoFactor: true }, twoFactorEnabled: false });
  await assert.rejects(
    () => service.validateWithdrawalRequest(withdrawal("10")),
    (error: unknown) =>
      codeOf(error) === "WITHDRAWAL_2FA_NOT_ENABLED" && /account page/.test((error as Error).message)
  );
});

test("a user who enabled 2FA must send a code even when the platform flag is off", async () => {
  const { service, identity } = createHarness({ rules: {}, twoFactorEnabled: true });

  const validation = await service.validateWithdrawalRequest(withdrawal("10"));
  assert.equal(validation.appliedRules.requireTwoFactor, true);

  await assert.rejects(
    () => service.requestWithdrawal(withdrawal("10")),
    (error: unknown) => codeOf(error) === "WITHDRAWAL_2FA_REQUIRED"
  );
  const created = await service.requestWithdrawal(withdrawal("10", { twoFactorCode: "654321" }));
  assert.equal(created.status, "requested");
  assert.deepEqual(identity.verifiedCodes, ["654321"]);

  identity.twoFactorEnabled = false;
  const withoutTwoFactor = await service.requestWithdrawal(withdrawal("10"));
  assert.equal(withoutTwoFactor.metadata.validation && (withoutTwoFactor.metadata.validation as Record<string, unknown>).requireTwoFactor, false);
});

test("a rejected request does not consume the 2FA code", async () => {
  const { service, identity } = createHarness({
    rules: { kycTierLimits: DEFAULT_KYC_TIER_LIMITS },
    twoFactorEnabled: true
  });
  await assert.rejects(
    () => service.requestWithdrawal(withdrawal("1000.5", { twoFactorCode: "111111" })),
    (error: unknown) => codeOf(error) === "WITHDRAWAL_SINGLE_LIMIT_EXCEEDED"
  );
  assert.deepEqual(identity.verifiedCodes, []);
});

test("KYC tier limits are enforced per asset with today's usage", async () => {
  const harness = createHarness({
    rules: { kycTierLimits: DEFAULT_KYC_TIER_LIMITS, singleLimitByAsset: { USDT: "10000" } },
    kycTier: "unverified"
  });
  const { service, identity } = harness;

  await assert.rejects(
    () => service.validateWithdrawalRequest(withdrawal("1000.01")),
    (error: unknown) =>
      codeOf(error) === "WITHDRAWAL_SINGLE_LIMIT_EXCEEDED" && /KYC tier unverified/.test((error as Error).message)
  );

  await service.requestWithdrawal(withdrawal("900"));
  await service.requestWithdrawal(withdrawal("900"));
  await assert.rejects(
    () => service.validateWithdrawalRequest(withdrawal("300")),
    (error: unknown) =>
      codeOf(error) === "WITHDRAWAL_DAILY_LIMIT_EXCEEDED" && /remaining 200/.test((error as Error).message)
  );

  const limits = await service.getWithdrawalLimits(USER);
  assert.equal(limits.kycTier, "unverified");
  assert.equal(limits.kycEnforced, true);
  const usdt = limits.assets.find((asset) => asset.assetCode === "USDT");
  assert.equal(usdt?.usedToday, "1800");
  assert.equal(usdt?.remainingToday, "200");
  assert.equal(usdt?.singleLimit, "1000");
  assert.equal(usdt?.dailyLimit, "2000");

  // Upgrading to L1 lifts the limits immediately.
  identity.kycTier = "L1";
  const upgraded = await service.validateWithdrawalRequest(withdrawal("5000"));
  assert.equal(upgraded.appliedRules.kycTier, "L1");
  assert.equal(upgraded.appliedRules.singleLimit, "10000");
  assert.equal(upgraded.appliedRules.dailyUsedAmount, "1800");

  // Usage resets on the next UTC day.
  identity.kycTier = "unverified";
  harness.advance(24 * 60 * 60);
  const nextDay = await service.validateWithdrawalRequest(withdrawal("1000"));
  assert.equal(nextDay.appliedRules.dailyUsedAmount, "0");
});

test("security cooldown blocks withdrawals after adding an address or changing 2FA", async () => {
  const harness = createHarness({
    rules: { securityCooldownSeconds: 120 },
    twoFactorEnabled: false
  });
  const { service, identity } = harness;

  await service.createWithdrawalAddressBookEntry({
    userId: USER,
    network: "ethereum",
    address: ADDRESS,
    label: "new"
  });

  await assert.rejects(
    () => service.validateWithdrawalRequest(withdrawal("10")),
    (error: unknown) =>
      codeOf(error) === "WITHDRAWAL_SECURITY_COOLDOWN" &&
      /adding a new withdrawal address/.test((error as Error).message) &&
      /remainingSeconds=120/.test((error as Error).message)
  );

  harness.advance(119);
  const limits = await service.getWithdrawalLimits(USER);
  assert.equal(limits.cooldown.active, true);
  assert.equal(limits.cooldown.remainingSeconds, 1);

  harness.advance(1);
  await service.validateWithdrawalRequest(withdrawal("10"));

  // Re-saving the same address does not restart the cooldown.
  await service.createWithdrawalAddressBookEntry({
    userId: USER,
    network: "ethereum",
    address: ADDRESS,
    label: "renamed"
  });
  await service.validateWithdrawalRequest(withdrawal("10"));

  // A 2FA change (enable or disable) restarts it.
  identity.twoFactorChangedAt = new Date(Date.parse("2026-05-03T10:02:00.000Z") - 30_000).toISOString();
  await assert.rejects(
    () => service.validateWithdrawalRequest(withdrawal("10")),
    (error: unknown) =>
      codeOf(error) === "WITHDRAWAL_SECURITY_COOLDOWN" && /two-factor/.test((error as Error).message)
  );
});

test("large withdrawals need two different approvers before broadcast", async () => {
  const { service, repository, custodyCalls } = createHarness({
    rules: { dualApprovalThresholdByAsset: { USDT: "5000" } }
  });

  const small = await service.requestWithdrawal(withdrawal("5000"));
  assert.deepEqual(small.metadata.approvalPolicy, { requiredApprovals: 1, threshold: "5000" });
  const smallApproved = await service.approveWithdrawal({ withdrawalId: small.withdrawalId, reviewedBy: "ops-a" });
  assert.equal(smallApproved.status, "broadcasted");

  const large = await service.requestWithdrawal(withdrawal("5000.5"));
  assert.deepEqual(large.metadata.approvalPolicy, { requiredApprovals: 2, threshold: "5000" });

  await assert.rejects(
    () => service.approveWithdrawal({ withdrawalId: large.withdrawalId }),
    (error: unknown) => codeOf(error) === "WITHDRAWAL_APPROVER_REQUIRED"
  );

  const first = await service.approveWithdrawal({
    withdrawalId: large.withdrawalId,
    reviewedBy: "ops-a",
    note: "looks fine"
  });
  assert.equal(first.status, "under_review");
  assert.equal(first.reviewStatus, "pending_second_approval");
  assert.equal(custodyCalls.length, 1, "no broadcast after the first approval");

  const queue = await service.listWithdrawalReviewQueue({});
  assert.deepEqual(queue.items.map((item) => item.withdrawalId), [large.withdrawalId]);

  await assert.rejects(
    () => service.approveWithdrawal({ withdrawalId: large.withdrawalId, reviewedBy: "ops-a" }),
    (error: unknown) => codeOf(error) === "WITHDRAWAL_SAME_APPROVER"
  );

  const second = await service.approveWithdrawal({ withdrawalId: large.withdrawalId, reviewedBy: "ops-b" });
  assert.equal(second.status, "broadcasted");
  assert.equal(second.reviewStatus, "approved");
  assert.deepEqual(
    (second.metadata.approvals as Array<{ operatorId: string }>).map((approval) => approval.operatorId),
    ["ops-a", "ops-b"]
  );
  assert.equal(custodyCalls.length, 2);

  const audit = await repository.listWithdrawalAuditLogs({ withdrawalId: large.withdrawalId, limit: 20, offset: 0 });
  const actions = audit.items
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.action.localeCompare(right.action))
    .map((log) => `${log.action}:${log.operatorId ?? "-"}`);
  assert.ok(actions.includes("first_approved:ops-a"));
  assert.ok(actions.includes("approved:ops-b"));
  assert.ok(actions.some((entry) => entry.startsWith("broadcasted")));
});

test("a withdrawal waiting for its second approval can still be rejected", async () => {
  const { service } = createHarness({ rules: { dualApprovalThresholdByAsset: { USDT: "100" } } });
  const large = await service.requestWithdrawal(withdrawal("150"));
  await service.approveWithdrawal({ withdrawalId: large.withdrawalId, reviewedBy: "ops-a" });
  const rejected = await service.rejectWithdrawal({
    withdrawalId: large.withdrawalId,
    reviewedBy: "ops-b",
    reason: "second reviewer disagrees"
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewStatus, "rejected");
});
