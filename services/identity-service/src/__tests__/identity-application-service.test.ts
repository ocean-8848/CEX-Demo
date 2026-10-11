import assert from "node:assert/strict";
import test from "node:test";

import { IdentityApplicationService } from "../application/identity-application-service.js";
import { signCanonicalRequest } from "../domain/api-key-secret.js";
import { InMemoryIdentityRepository } from "../infrastructure/in-memory-identity-repository.js";

test("2FA enroll, enable and verify works with real TOTP codes", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-07T12:00:00.000Z")
  });

  await service.createUser({
    userId: "11111111-1111-4111-8111-111111111111",
    email: "user@example.com"
  });

  const enrollment = await service.enrollTwoFactor({
    userId: "11111111-1111-4111-8111-111111111111"
  });

  const enableCode = service.generateCurrentTotpCode(enrollment.secret).code;
  const enabled = await service.enableTwoFactor({
    userId: "11111111-1111-4111-8111-111111111111",
    code: enableCode
  });

  assert.equal(enabled.enabled, true);

  const verificationService = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-07T12:00:30.000Z")
  });
  const verifyCode = verificationService.generateCurrentTotpCode(enrollment.secret).code;
  const verified = await verificationService.verifyTwoFactor({
    userId: "11111111-1111-4111-8111-111111111111",
    code: verifyCode,
    purpose: "withdrawal"
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.purpose, "withdrawal");
});

test("2FA verify rejects reused codes", async () => {
  const repository = new InMemoryIdentityRepository();
  const enableService = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-07T12:05:00.000Z")
  });

  await enableService.createUser({
    userId: "22222222-2222-4222-8222-222222222222"
  });

  const enrollment = await enableService.enrollTwoFactor({
    userId: "22222222-2222-4222-8222-222222222222"
  });

  await enableService.enableTwoFactor({
    userId: "22222222-2222-4222-8222-222222222222",
    code: enableService.generateCurrentTotpCode(enrollment.secret).code
  });

  const verifyService = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-07T12:05:30.000Z")
  });
  const verifyCode = verifyService.generateCurrentTotpCode(enrollment.secret).code;

  await verifyService.verifyTwoFactor({
    userId: "22222222-2222-4222-8222-222222222222",
    code: verifyCode
  });

  await assert.rejects(
    () =>
      verifyService.verifyTwoFactor({
        userId: "22222222-2222-4222-8222-222222222222",
        code: verifyCode
      }),
    /already been used/
  );
});

test("ops session login requires password and 2FA and exposes permissions", async () => {
  const repository = new InMemoryIdentityRepository();
  const enrollService = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T04:00:00.000Z")
  });

  await enrollService.createUser({
    userId: "33333333-3333-4333-8333-333333333333",
    email: "ops@example.com",
    displayName: "Ops Admin",
    userType: "ops",
    password: "Secr3t!Passw0rd",
    roles: ["ops_admin"]
  });

  const enrollment = await enrollService.enrollTwoFactor({
    userId: "33333333-3333-4333-8333-333333333333"
  });

  await enrollService.enableTwoFactor({
    userId: "33333333-3333-4333-8333-333333333333",
    code: enrollService.generateCurrentTotpCode(enrollment.secret).code
  });

  const loginService = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T04:01:00.000Z")
  });
  const twoFactorCode = loginService.generateCurrentTotpCode(enrollment.secret).code;

  const session = await loginService.createOpsSession({
    email: "ops@example.com",
    password: "Secr3t!Passw0rd",
    twoFactorCode
  });

  assert.ok(session.token.length > 10);
  assert.equal(session.email, "ops@example.com");
  assert.equal(session.roles[0], "ops_admin");
  assert.equal(session.permissions.includes("ops.withdrawals.review"), true);

  const introspected = await loginService.introspectOpsSession(session.token);
  assert.equal(introspected.active, true);
  assert.equal(introspected.userId, "33333333-3333-4333-8333-333333333333");
});

test("user search filters by role and user type", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T05:00:00.000Z")
  });

  await service.createUser({
    userId: "44444444-4444-4444-8444-444444444444",
    email: "reviewer@example.com",
    userType: "ops",
    password: "ReviewerPass1!",
    roles: ["ops_reviewer"]
  });

  await service.createUser({
    userId: "55555555-5555-4555-8555-555555555555",
    email: "customer@example.com",
    userType: "customer"
  });

  const result = await service.listUsers({
    userType: "ops",
    role: "ops_reviewer",
    limit: 10,
    offset: 0
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.email, "reviewer@example.com");
});

test("customer register, login, freeze and unfreeze work", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T06:00:00.000Z")
  });

  const customer = await service.registerCustomer({
    email: "customer-login@example.com",
    password: "CustomerPass1!",
    displayName: "Customer Login"
  });

  const session = await service.createCustomerSession({
    email: "customer-login@example.com",
    password: "CustomerPass1!"
  });

  assert.equal(session.scope, "customer_web");
  assert.equal(session.userId, customer.userId);

  await service.freezeUser({
    userId: customer.userId,
    reason: "risk review"
  });

  await assert.rejects(
    () =>
      service.createCustomerSession({
        email: "customer-login@example.com",
        password: "CustomerPass1!"
      }),
    /not active/
  );

  const unfrozen = await service.unfreezeUser({
    userId: customer.userId
  });

  assert.equal(unfrozen.status, "active");
});

test("api keys can be created, listed and revoked", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T07:00:00.000Z")
  });

  const customer = await service.registerCustomer({
    email: "apikey@example.com",
    password: "CustomerPass1!"
  });

  const created = await service.createApiKey({
    userId: customer.userId,
    label: "trading-bot"
  });

  assert.ok(created.secret.startsWith("sk_"));
  assert.ok(created.keyId?.startsWith("ak_"));
  assert.deepEqual(created.scopes, ["read", "trade"]);
  assert.equal(created.active, true);

  const listedBeforeRevoke = await service.listApiKeys(customer.userId);
  assert.equal(listedBeforeRevoke.length, 1);
  assert.equal(listedBeforeRevoke[0]?.status, "active");

  const revoked = await service.revokeApiKey(created.apiKeyId);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.active, false);
});

test("api key signatures are verified by identity with the stored secret", async () => {
  const repository = new InMemoryIdentityRepository();
  const service = new IdentityApplicationService(repository, {
    now: () => new Date("2026-03-08T07:30:00.000Z")
  });

  const customer = await service.registerCustomer({
    email: "introspect@example.com",
    password: "CustomerPass1!"
  });
  const apiKey = await service.createApiKey({
    userId: customer.userId,
    label: "gateway-client",
    scopes: ["withdraw"]
  });
  assert.deepEqual(apiKey.scopes, ["read", "withdraw"]);

  const canonicalRequest = "GET\n/api/v1/gateway/balances\n1741418000000\nnonce-1\ne3b0";
  const signature = signCanonicalRequest(apiKey.secret, canonicalRequest);

  const authInfo = await service.verifyApiKeySignature({
    keyId: apiKey.keyId!,
    canonicalRequest,
    signature
  });
  assert.equal(authInfo.userId, customer.userId);
  assert.equal(authInfo.apiKeyStatus, "active");
  assert.deepEqual(authInfo.scopes, ["read", "withdraw"]);
  assert.equal("secretCiphertext" in authInfo, false);

  await assert.rejects(
    () =>
      service.verifyApiKeySignature({
        keyId: apiKey.keyId!,
        canonicalRequest: canonicalRequest.replace("balances", "orders"),
        signature
      }),
    /signature is invalid/
  );
  await assert.rejects(
    () => service.createApiKey({ userId: customer.userId, label: "bad", scopes: ["admin"] }),
    /Unknown API key scope/
  );

  await service.freezeUser({
    userId: customer.userId,
    reason: "manual review"
  });

  await assert.rejects(
    () => service.verifyApiKeySignature({ keyId: apiKey.keyId!, canonicalRequest, signature }),
    /not active/
  );
});
