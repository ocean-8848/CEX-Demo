import assert from "node:assert/strict";
import test from "node:test";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import { WalletError } from "../domain/errors.js";
import type { IdentityClient } from "../domain/identity-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import type { WithdrawalValidationRules } from "../domain/types.js";
import {
  DEFAULT_WITHDRAWAL_RISK_RULES,
  parseAddressRiskLabels,
  riskLevelForScore,
  scoreWithdrawalRisk,
  type AddressBlacklistEntry
} from "../domain/withdrawal-risk.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";
import { loadWithdrawalRiskRulesFromEnv } from "../infrastructure/withdrawal-validation-rules.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DEMO_WHITELISTED = "0x1234567890abcdef1234567890abcdef12345678";
const MIXER = "0xdeadbeef00000000000000000000000000000001";
const FRESH = "0x9999999999999999999999999999999999999999";
const SANCTIONED = "0xbad0000000000000000000000000000000000001";

const blacklistEntry: AddressBlacklistEntry = {
  entryId: "bl-1",
  network: "ethereum",
  address: SANCTIONED,
  category: "sanctioned",
  reason: "demo",
  source: "seed",
  status: "active",
  createdAt: NOW.toISOString()
};

// ---------------------------------------------------------------------------
// Pure scorer rules
// ---------------------------------------------------------------------------

test("scorer: blacklisted address is blocked regardless of anything else", () => {
  const result = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "10",
    blacklistEntry,
    whitelisted: true,
    priorSuccessfulWithdrawals: 5,
    now: NOW
  });
  assert.equal(result.level, "blocked");
  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons.map((reason) => reason.code), ["BLACKLISTED_ADDRESS"]);
  assert.equal(result.requiresDualApproval, false);
});

test("scorer: demo mixer label is high and needs dual approval", () => {
  const result = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "10",
    label: DEFAULT_WITHDRAWAL_RISK_RULES.labels.find((label) => label.address === MIXER),
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    now: NOW
  });
  assert.equal(result.level, "high");
  assert.equal(result.requiresDualApproval, true);
  assert.ok(result.reasons.some((reason) => reason.code === "LABELLED_HIGH_RISK_ADDRESS"));
});

test("scorer: whitelisted address scores low even for a large first withdrawal", () => {
  const result = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "9000",
    whitelisted: true,
    priorSuccessfulWithdrawals: 0,
    addressBookCreatedAt: NOW.toISOString(),
    now: NOW
  });
  assert.equal(result.level, "low");
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons.map((reason) => reason.code), ["WHITELISTED_ADDRESS"]);
});

test("scorer: known address (earlier successful withdrawal) scores low", () => {
  const result = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "9000",
    whitelisted: false,
    priorSuccessfulWithdrawals: 2,
    now: NOW
  });
  assert.equal(result.level, "low");
  assert.deepEqual(result.reasons.map((reason) => reason.code), ["KNOWN_ADDRESS"]);
});

test("scorer: first-time address alone is low, above the large amount it is medium", () => {
  const small = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "100",
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    now: NOW
  });
  assert.equal(small.level, "low");
  assert.equal(small.score, 10);

  const large = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "1000.01",
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    now: NOW
  });
  assert.equal(large.level, "medium");
  assert.ok(large.reasons.some((reason) => reason.code === "FIRST_TIME_LARGE_AMOUNT"));
});

test("scorer: new address within the window is medium; plus a large amount it is high", () => {
  const recent = new Date(NOW.getTime() - 3600 * 1000).toISOString();
  const medium = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "100",
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    addressBookCreatedAt: recent,
    now: NOW
  });
  assert.equal(medium.level, "medium");
  assert.ok(medium.reasons.some((reason) => reason.code === "NEW_ADDRESS_COOLDOWN"));

  const high = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "5000",
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    addressBookCreatedAt: recent,
    now: NOW
  });
  assert.equal(high.level, "high");
  assert.equal(high.requiresDualApproval, true);

  const old = scoreWithdrawalRisk({
    assetCode: "USDT",
    amount: "100",
    whitelisted: false,
    priorSuccessfulWithdrawals: 0,
    addressBookCreatedAt: new Date(NOW.getTime() - 2 * 86400 * 1000).toISOString(),
    now: NOW
  });
  assert.equal(old.level, "low");
});

test("scorer: disabled rules return low without reasons", () => {
  const result = scoreWithdrawalRisk(
    { assetCode: "USDT", amount: "1", blacklistEntry, whitelisted: false, priorSuccessfulWithdrawals: 0, now: NOW },
    { ...DEFAULT_WITHDRAWAL_RISK_RULES, enabled: false }
  );
  assert.equal(result.level, "low");
  assert.equal(result.reasons.length, 0);
});

test("scorer: level thresholds and env parsing", () => {
  assert.equal(riskLevelForScore(29), "low");
  assert.equal(riskLevelForScore(30), "medium");
  assert.equal(riskLevelForScore(60), "high");
  const labels = parseAddressRiskLabels(`${FRESH.toUpperCase().replace("0X", "0x")}=darknet,bad=nope,0xabc=unknown`);
  assert.deepEqual(labels.map((label) => [label.address, label.label]), [[FRESH, "darknet"]]);
  const rules = loadWithdrawalRiskRulesFromEnv({ WITHDRAWAL_RISK_ENABLED: "false", WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET: "USDT=50" });
  assert.equal(rules.enabled, false);
  assert.deepEqual(rules.largeAmountByAsset, { USDT: "50" });
});

// ---------------------------------------------------------------------------
// Application service: request-time KYT, blacklist management, auto-reject
// ---------------------------------------------------------------------------

function createHarness(rules: WithdrawalValidationRules = {}) {
  let idCounter = 0;
  const ledger = { frozen: [] as string[], released: [] as string[] };
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("unexpected");
    },
    async freezeBalance(command) {
      ledger.frozen.push(command.referenceId);
      return { lockId: "lock" };
    },
    async releaseBalance(command) {
      ledger.released.push(command.referenceId);
      return { lockId: "lock" };
    },
    async consumeBalance() {
      return { lockId: "lock" };
    }
  };
  const service = new WalletApplicationService(
    repository,
    ledgerClient,
    {
      async createTransfer(command) {
        return { providerName: "mock", custodyRequestId: `c-${command.withdrawalId}`, txHash: `0x${"b".repeat(64)}` };
      }
    },
    { now: () => NOW, createId: () => `id-${++idCounter}`, withdrawalValidationRules: rules }
  );
  return { service, repository, ledger };
}

function request(toAddress: string, amount = "100", userId = "user-1") {
  return {
    userId,
    ledgerAccountId: `ledger-${userId}`,
    assetCode: "USDT" as const,
    network: "ethereum" as const,
    toAddress,
    amount,
    fee: "1"
  };
}

async function seedBlacklist(repository: InMemoryWalletRepository) {
  await repository.saveAddressBlacklistEntry(blacklistEntry);
}

test("request: the demo whitelisted address scores low and keeps single approval", async () => {
  const { service, repository } = createHarness({ dualApprovalThresholdByAsset: { USDT: "5000" } });
  repository.addWhitelistedAddress("user-1", "ethereum", DEMO_WHITELISTED);
  const record = await service.requestWithdrawal(request(DEMO_WHITELISTED, "100"));
  assert.equal(record.riskLevel, "low");
  assert.equal(record.riskScore, 0);
  assert.equal((record.metadata.approvalPolicy as { requiredApprovals: number }).requiredApprovals, 1);
  const approved = await service.approveWithdrawal({ withdrawalId: record.withdrawalId, reviewedBy: "ops-1" });
  assert.equal(approved.status, "broadcasted");
});

test("validate: blacklisted address is refused with WITHDRAWAL_ADDRESS_BLOCKED and nothing is stored", async () => {
  const { service, repository, ledger } = createHarness();
  await seedBlacklist(repository);
  await assert.rejects(
    service.validateWithdrawalRequest(request(SANCTIONED.toUpperCase().replace("0X", "0x"))),
    (error: unknown) => error instanceof WalletError && error.code === "WITHDRAWAL_ADDRESS_BLOCKED"
  );
  assert.equal((await repository.listWithdrawals({})).total, 0);
  assert.equal(ledger.frozen.length, 0);
});

test("request: blacklisted address records an auto-rejected withdrawal, freezes nothing and notifies", async () => {
  const { service, repository, ledger } = createHarness();
  await seedBlacklist(repository);
  await assert.rejects(
    service.requestWithdrawal(request(SANCTIONED)),
    (error: unknown) => error instanceof WalletError && error.code === "WITHDRAWAL_ADDRESS_BLOCKED"
  );
  const [blocked] = (await repository.listWithdrawals({ riskLevel: "blocked" })).items;
  assert.ok(blocked);
  assert.equal(blocked.status, "rejected");
  assert.equal(blocked.frozenAmount, "0");
  assert.equal(ledger.frozen.length, 0);
  const audit = (await repository.listWithdrawalAuditLogs({ withdrawalId: blocked.withdrawalId })).items;
  assert.equal(audit[0]?.operatorId, "system:kyt");
  const notifications = (await repository.listWalletNotifications({ userId: "user-1" })).items;
  assert.equal(notifications[0]?.eventType, "withdrawal.rejected");
  assert.match(notifications[0]?.body ?? "", /blacklist/);
});

test("request: mixer-labelled address is high and needs two different approvers even for a small amount", async () => {
  const { service } = createHarness({ dualApprovalThresholdByAsset: { USDT: "5000" } });
  const record = await service.requestWithdrawal(request(MIXER, "20"));
  assert.equal(record.riskLevel, "high");
  assert.deepEqual(record.metadata.approvalPolicy, { requiredApprovals: 2, threshold: "5000", reason: "risk_high" });
  const first = await service.approveWithdrawal({ withdrawalId: record.withdrawalId, reviewedBy: "ops-1" });
  assert.equal(first.reviewStatus, "pending_second_approval");
  const second = await service.approveWithdrawal({ withdrawalId: record.withdrawalId, reviewedBy: "ops-2" });
  assert.equal(second.status, "broadcasted");
});

test("risk filter: listWithdrawals filters by stored risk level", async () => {
  const { service } = createHarness();
  await service.requestWithdrawal(request(MIXER, "20"));
  await service.requestWithdrawal(request(FRESH, "20"));
  assert.equal((await service.listWithdrawals({ riskLevel: "high" })).total, 1);
  assert.equal((await service.listWithdrawals({ riskLevel: "low" })).total, 1);
});

test("blacklist: adding an address auto-rejects pending withdrawals, releases funds and notifies", async () => {
  const { service, repository, ledger } = createHarness();
  const pending = await service.requestWithdrawal(request(FRESH, "50", "user-2"));
  assert.deepEqual(ledger.frozen, [pending.withdrawalId]);

  const result = await service.addAddressBlacklistEntry({
    network: "ethereum",
    address: FRESH,
    category: "scam",
    reason: "reported phishing",
    createdBy: "ops-1"
  });
  assert.deepEqual(result.autoRejectedWithdrawalIds, [pending.withdrawalId]);
  assert.deepEqual(ledger.released, [pending.withdrawalId]);
  const after = await repository.findWithdrawalById(pending.withdrawalId);
  assert.equal(after?.status, "rejected");
  assert.equal(after?.riskLevel, "blocked");
  const notifications = (await repository.listWalletNotifications({ userId: "user-2" })).items;
  assert.ok(notifications.some((item) => item.eventType === "withdrawal.rejected"));

  await assert.rejects(
    service.addAddressBlacklistEntry({ network: "ethereum", address: FRESH, category: "scam", reason: "dup" }),
    (error: unknown) => error instanceof WalletError && error.code === "INVALID_BLACKLIST_ENTRY"
  );
});

test("blacklist: validation, removal with reason, and re-allowing the address", async () => {
  const { service, repository } = createHarness();
  await assert.rejects(
    service.addAddressBlacklistEntry({ network: "ethereum", address: FRESH, category: "scam", reason: " " }),
    (error: unknown) => error instanceof WalletError && error.code === "INVALID_BLACKLIST_ENTRY"
  );
  await assert.rejects(
    service.addAddressBlacklistEntry({ network: "ethereum", address: FRESH, category: "nope", reason: "x" }),
    (error: unknown) => error instanceof WalletError && error.code === "INVALID_BLACKLIST_ENTRY"
  );
  const { entry } = await service.addAddressBlacklistEntry({
    network: "ethereum",
    address: FRESH,
    category: "other",
    reason: "temporary hold"
  });
  await assert.rejects(service.validateWithdrawalRequest(request(FRESH)), /blocked/);
  await assert.rejects(
    service.removeAddressBlacklistEntry({ entryId: entry.entryId, reason: "" }),
    (error: unknown) => error instanceof WalletError && error.code === "INVALID_BLACKLIST_ENTRY"
  );
  const removed = await service.removeAddressBlacklistEntry({
    entryId: entry.entryId,
    reason: "false positive",
    removedBy: "ops-2"
  });
  assert.equal(removed.status, "removed");
  assert.equal(removed.removalReason, "false positive");
  const validation = await service.validateWithdrawalRequest(request(FRESH));
  assert.equal(validation.risk?.level, "low");
  assert.equal((await repository.listAddressBlacklist({ status: "removed" })).total, 1);
});

test("approve: a pending withdrawal to a since-blacklisted address is auto-rejected at approval", async () => {
  const { service, repository, ledger } = createHarness();
  const pending = await service.requestWithdrawal(request(FRESH, "50"));
  // Simulate an entry written directly (e.g. by another instance) without the sweep.
  await repository.saveAddressBlacklistEntry({ ...blacklistEntry, entryId: "bl-2", address: FRESH });
  await assert.rejects(
    service.approveWithdrawal({ withdrawalId: pending.withdrawalId, reviewedBy: "ops-1" }),
    (error: unknown) => error instanceof WalletError && error.code === "WITHDRAWAL_ADDRESS_BLOCKED"
  );
  assert.equal((await repository.findWithdrawalById(pending.withdrawalId))?.status, "rejected");
  assert.deepEqual(ledger.released, [pending.withdrawalId]);
});

test("new-device lock: off by default, blocks withdrawals inside the window when enabled", async () => {
  let lastNewDeviceLoginAt: string | undefined = new Date(NOW.getTime() - 600 * 1000).toISOString();
  const identity: IdentityClient = {
    async getTwoFactorStatus(userId) {
      return { userId, enabled: false, pendingEnrollment: false };
    },
    async verifyTwoFactor() {
      return { verifiedAt: NOW.toISOString() };
    },
    async getKycProfile(userId) {
      return { userId, tier: "L2" };
    },
    async getLoginSecuritySummary(userId) {
      return { userId, lastNewDeviceLoginAt };
    }
  };
  const build = (rules: WithdrawalValidationRules) =>
    new WalletApplicationService(
      new InMemoryWalletRepository(),
      {
        async postDepositCredit() {
          throw new Error("unexpected");
        },
        async freezeBalance() {
          return { lockId: "l" };
        },
        async releaseBalance() {
          return { lockId: "l" };
        },
        async consumeBalance() {
          return { lockId: "l" };
        }
      },
      { async createTransfer() { throw new Error("unexpected"); } },
      { now: () => NOW, withdrawalValidationRules: rules },
      identity
    );

  await build({}).validateWithdrawalRequest(request(FRESH));
  const locked = build({ newDeviceLockSeconds: 3600 });
  await assert.rejects(
    locked.validateWithdrawalRequest(request(FRESH)),
    (error: unknown) => error instanceof WalletError && error.code === "WITHDRAWAL_NEW_DEVICE_LOCK"
  );
  const limits = await locked.getWithdrawalLimits("user-1");
  assert.equal(limits.newDeviceLock?.active, true);
  lastNewDeviceLoginAt = new Date(NOW.getTime() - 7200 * 1000).toISOString();
  await locked.validateWithdrawalRequest(request(FRESH));
});

test("security notification: stored in the inbox without a withdrawal or deposit", async () => {
  const { service, repository } = createHarness();
  const notification = await service.createSecurityNotification({
    userId: "user-9",
    eventType: "security.new_device_login",
    subject: "新设备登录",
    body: "Chrome on macOS",
    payload: { deviceId: "dev-1" }
  });
  assert.equal(notification.withdrawalId, undefined);
  assert.equal(await repository.countUnreadWalletNotifications("user-9"), 1);
});
