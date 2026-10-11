import assert from "node:assert/strict";
import test from "node:test";

import { IdentityApplicationService } from "../application/identity-application-service.js";
import { maskIdNumber, validateKycSubmission } from "../domain/kyc.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT
} from "../domain/recovery-codes.js";
import { InMemoryIdentityRepository } from "../infrastructure/in-memory-identity-repository.js";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const EMAIL = "self-service@example.com";
const PASSWORD = "SelfServicePass123!";

function clock(start: string) {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(seconds: number) {
      current += seconds * 1000;
    }
  };
}

async function setupCustomerWithTwoFactor() {
  const repository = new InMemoryIdentityRepository();
  const time = clock("2026-05-01T08:00:00.000Z");
  const service = new IdentityApplicationService(repository, { now: time.now });
  await service.createUser({ userId: USER_ID, email: EMAIL, password: PASSWORD });

  const enrollment = await service.enrollTwoFactor({ userId: USER_ID });
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
  const enabled = await service.enableTwoFactor({
    userId: USER_ID,
    code: service.generateCurrentTotpCode(enrollment.secret).code
  });
  return { repository, service, time, secret: enrollment.secret, enabled };
}

test("recovery codes are random, normalized and never look like a TOTP code", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}$/);
    assert.equal(looksLikeRecoveryCode(code), true);
  }
  assert.equal(looksLikeRecoveryCode("123456"), false);
  assert.equal(normalizeRecoveryCode(" ABCD EFGH "), "abcd-efgh");
  assert.equal(hashRecoveryCode("u1", "ABCD-EFGH"), hashRecoveryCode("u1", "abcdefgh"));
  assert.notEqual(hashRecoveryCode("u1", "abcd-efgh"), hashRecoveryCode("u2", "abcd-efgh"));
});

test("enabling 2FA returns one-time recovery codes that are stored hashed", async () => {
  const { repository, enabled, service } = await setupCustomerWithTwoFactor();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.recoveryCodes.length, RECOVERY_CODE_COUNT);
  assert.equal(enabled.recoveryCodesRemaining, RECOVERY_CODE_COUNT);
  assert.ok(enabled.changedAt, "enable records changedAt for the withdrawal cooldown");

  const stored = await repository.listRecoveryCodes(USER_ID);
  assert.equal(stored.length, RECOVERY_CODE_COUNT);
  for (const code of enabled.recoveryCodes) {
    assert.ok(!stored.some((entry) => entry.codeHash === code), "raw code must not be stored");
  }

  const status = await service.getTwoFactorStatus(USER_ID);
  assert.equal(status.recoveryCodesRemaining, RECOVERY_CODE_COUNT);
});

test("login accepts a recovery code once instead of the TOTP code", async () => {
  const { enabled, service } = await setupCustomerWithTwoFactor();
  const recoveryCode = enabled.recoveryCodes[0]!;

  await assert.rejects(
    () => service.createCustomerSession({ email: EMAIL, password: PASSWORD }),
    /Two-factor code is required/
  );

  const session = await service.createCustomerSession({
    email: EMAIL,
    password: PASSWORD,
    twoFactorCode: recoveryCode.toUpperCase()
  });
  assert.ok(session.token);

  await assert.rejects(
    () =>
      service.createCustomerSession({ email: EMAIL, password: PASSWORD, twoFactorCode: recoveryCode }),
    (error: unknown) => (error as { code?: string }).code === "TWO_FACTOR_RECOVERY_CODE_INVALID"
  );

  const status = await service.getTwoFactorStatus(USER_ID);
  assert.equal(status.recoveryCodesRemaining, RECOVERY_CODE_COUNT - 1);
});

test("disabling 2FA requires a valid current code and clears recovery codes", async () => {
  const { repository, service, time, secret } = await setupCustomerWithTwoFactor();
  time.advance(60);

  await assert.rejects(
    () => service.disableTwoFactor({ userId: USER_ID, code: "000000" }),
    (error: unknown) => (error as { code?: string }).code === "TWO_FACTOR_INVALID_CODE"
  );
  await assert.rejects(
    () => service.disableTwoFactor({ userId: USER_ID, code: "" }),
    (error: unknown) => (error as { code?: string }).code === "TWO_FACTOR_INVALID_CODE"
  );

  const disabled = await service.disableTwoFactor({
    userId: USER_ID,
    code: service.generateCurrentTotpCode(secret).code
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.recoveryCodesRemaining, 0);
  assert.equal(disabled.changedAt, time.now().toISOString());
  assert.equal((await repository.listRecoveryCodes(USER_ID)).length, 0);

  // After disabling, login no longer asks for a code and a new enrollment works.
  const session = await service.createCustomerSession({ email: EMAIL, password: PASSWORD });
  assert.ok(session.token);
  await assert.rejects(
    () => service.disableTwoFactor({ userId: USER_ID, code: "123456" }),
    /not enabled/
  );
});

test("disabling 2FA also accepts an unused recovery code", async () => {
  const { enabled, service } = await setupCustomerWithTwoFactor();
  const disabled = await service.disableTwoFactor({
    userId: USER_ID,
    code: enabled.recoveryCodes[3]!
  });
  assert.equal(disabled.enabled, false);
});

test("regenerating recovery codes invalidates the old set", async () => {
  const { enabled, service, time, secret } = await setupCustomerWithTwoFactor();
  time.advance(60);
  const regenerated = await service.regenerateRecoveryCodes({
    userId: USER_ID,
    code: service.generateCurrentTotpCode(secret).code
  });
  assert.equal(regenerated.recoveryCodes.length, RECOVERY_CODE_COUNT);
  assert.notDeepEqual(regenerated.recoveryCodes, enabled.recoveryCodes);

  await assert.rejects(
    () =>
      service.createCustomerSession({
        email: EMAIL,
        password: PASSWORD,
        twoFactorCode: enabled.recoveryCodes[0]!
      }),
    /Recovery code is invalid/
  );
});

test("KYC submission validation masks the demo ID number", () => {
  const ok = validateKycSubmission("unverified", {
    requestedTier: "L1",
    fullName: "  Demo Trader ",
    idNumber: "DEMO 1234 5678"
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.fullName, "Demo Trader");
    assert.equal(ok.value.idNumberMasked, "********5678");
  }

  assert.equal(validateKycSubmission("L1", { requestedTier: "L1", fullName: "Ab", idNumber: "123456" }).ok, false);
  assert.equal(validateKycSubmission("unverified", { requestedTier: "L3", fullName: "Ab", idNumber: "123456" }).ok, false);
  assert.equal(validateKycSubmission("unverified", { requestedTier: "L2", fullName: "A", idNumber: "123456" }).ok, false);
  assert.equal(validateKycSubmission("unverified", { requestedTier: "L2", fullName: "Ab", idNumber: "12-34" }).ok, false);
  assert.equal(maskIdNumber("1234"), "**1234");
});

test("KYC request lifecycle: submit, single pending, approve, reject and manual adjust are audited", async () => {
  const repository = new InMemoryIdentityRepository();
  const time = clock("2026-05-02T08:00:00.000Z");
  const service = new IdentityApplicationService(repository, { now: time.now });
  await service.createUser({ userId: USER_ID, email: EMAIL, password: PASSWORD });

  const initial = await service.getKycProfile(USER_ID);
  assert.equal(initial.tier, "unverified");

  const request = await service.submitKycRequest({
    userId: USER_ID,
    requestedTier: "L2",
    fullName: "Demo Trader",
    idNumber: "A1234567"
  });
  assert.equal(request.status, "pending");
  assert.equal(request.idNumberMasked, "****4567");

  await assert.rejects(
    () =>
      service.submitKycRequest({
        userId: USER_ID,
        requestedTier: "L1",
        fullName: "Demo Trader",
        idNumber: "A1234567"
      }),
    (error: unknown) => (error as { code?: string }).code === "KYC_REQUEST_PENDING"
  );

  const pendingList = await service.listKycRequests({ status: "pending" });
  assert.equal(pendingList.total, 1);
  assert.equal(pendingList.items[0]?.email, EMAIL);

  // Reviewer grants L1 even though L2 was requested.
  time.advance(30);
  const approved = await service.approveKycRequest({
    requestId: request.requestId,
    reviewedBy: "ops-1",
    tier: "L1",
    note: "demo docs ok for L1"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedTier, "L1");
  assert.equal((await service.getUser(USER_ID)).kycTier, "L1");

  await assert.rejects(
    () => service.rejectKycRequest({ requestId: request.requestId, reviewedBy: "ops-2" }),
    (error: unknown) => (error as { code?: string }).code === "KYC_REQUEST_ALREADY_REVIEWED"
  );

  const second = await service.submitKycRequest({
    userId: USER_ID,
    requestedTier: "L2",
    fullName: "Demo Trader",
    idNumber: "A1234567"
  });
  await service.rejectKycRequest({ requestId: second.requestId, reviewedBy: "ops-2", note: "blurry" });

  const adjusted = await service.setKycTier({
    userId: USER_ID,
    tier: "unverified",
    actorId: "ops-1",
    reason: "risk review"
  });
  assert.equal(adjusted.tier, "unverified");
  assert.deepEqual(
    adjusted.events.map((event) => event.action).sort(),
    ["request_approved", "request_rejected", "tier_adjusted"]
  );
  const adjustEvent = adjusted.events.find((event) => event.action === "tier_adjusted");
  assert.equal(adjustEvent?.fromTier, "L1");
  assert.equal(adjustEvent?.toTier, "unverified");
  assert.equal(adjustEvent?.actorId, "ops-1");

  await assert.rejects(
    () => service.setKycTier({ userId: USER_ID, tier: "L9" }),
    (error: unknown) => (error as { code?: string }).code === "KYC_REQUEST_INVALID"
  );
});

test("ops users cannot submit KYC", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository);
  await service.createUser({
    userId: "44444444-4444-4444-8444-444444444444",
    email: "ops@example.com",
    userType: "ops",
    roles: ["ops_admin"]
  });
  await assert.rejects(
    () =>
      service.submitKycRequest({
        userId: "44444444-4444-4444-8444-444444444444",
        requestedTier: "L1",
        fullName: "Ops Person",
        idNumber: "A1234567"
      }),
    (error: unknown) => (error as { code?: string }).code === "KYC_NOT_ALLOWED"
  );
});
