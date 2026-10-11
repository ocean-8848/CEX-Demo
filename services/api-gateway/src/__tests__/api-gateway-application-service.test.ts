import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import type { AccountType } from "@web3-cex/domain";

import { ApiGatewayApplicationService } from "../application/api-gateway-application-service.js";
import type {
  IdentityGatewayClient,
  LedgerGatewayClient,
  OrderGatewayClient,
  RateLimiter,
  WalletGatewayClient
} from "../domain/types.js";
import { InMemoryRateLimiter } from "../infrastructure/in-memory-rate-limiter.js";
import { createApiKeySignature } from "../http/api-key-signature.js";

test("session-authenticated balance query is scoped to the current user", async () => {
  const identityClient: IdentityGatewayClient = {
    async registerCustomer() {
      return {};
    },
    async createCustomerSession() {
      throw new Error("not used");
    },
    async introspectCustomerSession() {
      return {
        sessionId: "session-1",
        userId: "user-1",
        email: "user@example.com",
        displayName: "User",
        status: "active",
        userType: "customer",
        scope: "customer_web",
        roles: [],
        permissions: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        expiresAt: "2026-03-09T00:00:00.000Z",
        lastSeenAt: "2026-03-08T00:00:00.000Z",
        active: true
      };
    },
    async revokeCustomerSession() {
      return {
        revoked: true,
        revokedAt: "2026-03-08T00:00:00.000Z"
      };
    },
    async createApiKey() {
      throw new Error("not used");
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      return {};
    },
    async getTwoFactorStatus() {
      throw new Error("not used");
    },
    async enrollTwoFactor() {
      throw new Error("not used");
    },
    async enableTwoFactor() {
      throw new Error("not used");
    },
    async disableTwoFactor() {
      throw new Error("not used");
    },
    async regenerateRecoveryCodes() {
      throw new Error("not used");
    },
    async getKycProfile() {
      throw new Error("not used");
    },
    async submitKycRequest() {
      throw new Error("not used");
    },
    async verifyApiKeySignature() {
      throw new Error("not used");
    }
  };
  const walletClient: WalletGatewayClient = {
    async countUnreadWalletNotifications() {
      throw new Error("not used");
    },
    async markWalletNotificationsRead() {
      throw new Error("not used");
    },
    async getWithdrawalLimits() {
      throw new Error("not used");
    },
    async createDepositAddress() {
      throw new Error("not used");
    },
    async listDepositAddresses() {
      throw new Error("not used");
    },
    async listDeposits() {
      throw new Error("not used");
    },
    async getDeposit() {
      throw new Error("not used");
    },
    async listWithdrawals() {
      throw new Error("not used");
    },
    async getWithdrawal() {
      throw new Error("not used");
    },
    async validateWithdrawal() {
      throw new Error("not used");
    },
    async requestWithdrawal() {
      throw new Error("not used");
    },
    async listWithdrawalAddressBookEntries() {
      throw new Error("not used");
    },
    async createWithdrawalAddressBookEntry() {
      throw new Error("not used");
    },
    async listWalletNotifications() {
      throw new Error("not used");
    }
  };
  let receivedQuery: Record<string, unknown> | undefined;
  const ledgerClient: LedgerGatewayClient = {
    async listJournalsWithEntries() {
      return [];
    },
    async getAccountStatement() {
      throw new Error("not used");
    },
    async getAccount(accountId: string) {
      return {
        accountId,
        userId: "user-1",
        accountType: "spot" as AccountType,
        status: "active",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z"
      };
    },
    async createAccount() {
      throw new Error("not used");
    },
    async listBalances(query) {
      receivedQuery = query;
      return {
        items: [],
        total: 0,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0
      };
    }
  };
  const rateLimiter: RateLimiter = new InMemoryRateLimiter();
  const orderClient: OrderGatewayClient = {
    async getTrade() {
      throw new Error("not used");
    },
    async createOrder() {
      throw new Error("not used");
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    async getOrder() {
      throw new Error("not used");
    },
    async listOrders() {
      return [];
    },
    async listTrades() {
      return [];
    }
  };
  const service = new ApiGatewayApplicationService(
    identityClient,
    walletClient,
    ledgerClient,
    orderClient,
    rateLimiter
  );

  const principal = await service.authenticateCustomerSession("token-1");
  await service.listBalances(principal, {
    accountId: "account-1",
    assetCode: "USDT"
  });

  assert.deepEqual(receivedQuery, {
    userId: "user-1",
    accountId: "account-1",
    assetCode: "USDT",
    accountType: undefined,
    accountStatus: undefined,
    limit: undefined,
    offset: undefined
  });
});

test("api key authentication verifies signature and returns principal", async () => {
  const identityClient: IdentityGatewayClient = {
    async registerCustomer() {
      return {};
    },
    async createCustomerSession() {
      throw new Error("not used");
    },
    async introspectCustomerSession() {
      throw new Error("not used");
    },
    async revokeCustomerSession() {
      throw new Error("not used");
    },
    async createApiKey() {
      throw new Error("not used");
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      return {};
    },
    async getTwoFactorStatus() {
      throw new Error("not used");
    },
    async enrollTwoFactor() {
      throw new Error("not used");
    },
    async enableTwoFactor() {
      throw new Error("not used");
    },
    async disableTwoFactor() {
      throw new Error("not used");
    },
    async regenerateRecoveryCodes() {
      throw new Error("not used");
    },
    async getKycProfile() {
      throw new Error("not used");
    },
    async submitKycRequest() {
      throw new Error("not used");
    },
    async verifyApiKeySignature(command) {
      // Stand-in for identity: it alone knows the secret behind keyId.
      const expected = createHmac("sha256", "sk_demo_secret").update(command.canonicalRequest).digest("hex");
      if (command.keyId !== "ak_demo" || command.signature !== expected) {
        throw new Error("API key signature is invalid");
      }
      return {
        apiKeyId: "api-key-1",
        userId: "user-2",
        email: "customer@example.com",
        displayName: "Customer",
        userStatus: "active",
        userType: "customer",
        label: "bot",
        keyId: "ak_demo",
        keyPrefix: "ak_demo",
        scopes: ["read", "trade"],
        apiKeyStatus: "active",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        active: true
      };
    }
  };
  const walletClient = {} as WalletGatewayClient;
  const ledgerClient = {} as LedgerGatewayClient;
  const orderClient = {} as OrderGatewayClient;
  const service = new ApiGatewayApplicationService(
    identityClient,
    walletClient,
    ledgerClient,
    orderClient,
    new InMemoryRateLimiter(),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z")
    }
  );

  const timestamp = String(new Date("2026-03-08T00:00:00.000Z").getTime());
  const request = {
    method: "GET",
    url: "/api/v1/gateway/balances",
    timestamp,
    nonce: "nonce-0001"
  };
  const signature = createApiKeySignature({ secret: "sk_demo_secret", ...request });

  const principal = await service.authenticateApiKey({ apiKey: "ak_demo", signature, ...request });

  assert.equal(principal.authType, "api_key");
  assert.equal(principal.userId, "user-2");
  assert.equal(principal.apiKeyId, "api-key-1");
  assert.deepEqual(principal.apiKeyScopes, ["read", "trade"]);

  // Same nonce again is a replay, even with a valid signature.
  await assert.rejects(
    () => service.authenticateApiKey({ apiKey: "ak_demo", signature, ...request }),
    /nonce was already used/
  );

  // Tampering with the URL breaks the signature identity recomputes.
  await assert.rejects(
    () =>
      service.authenticateApiKey({
        apiKey: "ak_demo",
        signature,
        ...request,
        nonce: "nonce-0002",
        url: "/api/v1/gateway/orders"
      }),
    /signature is invalid/
  );

  service.assertApiKeyScope(principal, "trade");
  assert.throws(() => service.assertApiKeyScope(principal, "withdraw"), /lacks the "withdraw" scope/);
});

test("createOrder validates account ownership and forwards the customer user id", async () => {
  let receivedCommand: Record<string, unknown> | undefined;
  const identityClient = {} as IdentityGatewayClient;
  const walletClient = {} as WalletGatewayClient;
  const ledgerClient: LedgerGatewayClient = {
    async listJournalsWithEntries() {
      return [];
    },
    async getAccountStatement() {
      throw new Error("not used");
    },
    async getAccount(accountId: string) {
      return {
        accountId,
        userId: "user-9",
        accountType: "spot",
        status: "active",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z"
      };
    },
    async createAccount() {
      throw new Error("not used");
    },
    async listBalances() {
      return {
        items: [],
        total: 0,
        limit: 50,
        offset: 0
      };
    }
  };
  const orderClient: OrderGatewayClient = {
    async getTrade() {
      throw new Error("not used");
    },
    async createOrder(command) {
      receivedCommand = command;
      return {
        orderId: "order-1",
        idempotencyKey: command.idempotencyKey,
        traceId: command.traceId ?? "trace-1",
        userId: command.userId,
        accountId: command.accountId,
        market: command.market,
        side: command.side,
        type: command.type,
        timeInForce: command.timeInForce ?? "gtc",
        price: command.price ?? "0",
        quantity: command.quantity,
        filledQuantity: "0",
        restingQuantity: command.quantity,
        status: "accepted",
        lockAssetCode: "USDT",
        lockAmount: "50000",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z"
      };
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    async getOrder() {
      throw new Error("not used");
    },
    async listOrders() {
      return [];
    },
    async listTrades() {
      return [];
    }
  };
  const service = new ApiGatewayApplicationService(
    identityClient,
    walletClient,
    ledgerClient,
    orderClient,
    new InMemoryRateLimiter()
  );

  const principal = {
    authType: "session" as const,
    sessionId: "session-9",
    userId: "user-9",
    email: "user9@example.com",
    status: "active" as const,
    userType: "customer" as const,
    roles: [],
    permissions: [],
    createdAt: "2026-03-08T00:00:00.000Z",
    expiresAt: "2026-03-09T00:00:00.000Z",
    lastSeenAt: "2026-03-08T00:00:00.000Z",
    active: true
  };

  await service.createOrder(principal, {
    accountId: "account-9",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "50000",
    quantity: "1",
    idempotencyKey: "idem-order-1"
  });

  assert.deepEqual(receivedCommand, {
    userId: "user-9",
    accountId: "account-9",
    market: "BTC-USDT",
    side: "buy",
    type: "limit",
    timeInForce: "gtc",
    price: "50000",
    quantity: "1",
    idempotencyKey: "idem-order-1"
  });
});

test("registerCustomer provisions a stable spot account and reuses existing ones", async () => {
  const created: Array<Record<string, unknown>> = [];
  let existingBalances: Array<Record<string, unknown>> = [];
  const identityClient = {
    async registerCustomer(command: { email: string }) {
      return { userId: "user-new", email: command.email };
    }
  } as unknown as IdentityGatewayClient;
  const ledgerClient: LedgerGatewayClient = {
    async listJournalsWithEntries() {
      return [];
    },
    async getAccountStatement() {
      throw new Error("not used");
    },
    async getAccount() {
      throw new Error("not used");
    },
    async createAccount(command) {
      created.push(command);
      return {
        ...command,
        status: "active",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z"
      };
    },
    async listBalances() {
      return { items: existingBalances, total: existingBalances.length, limit: 1, offset: 0 };
    }
  };
  const service = new ApiGatewayApplicationService(
    identityClient,
    {} as WalletGatewayClient,
    ledgerClient,
    {} as OrderGatewayClient,
    new InMemoryRateLimiter()
  );

  const registered = await service.registerCustomer({ email: "new@example.com", password: "Passw0rd!" });
  const again = await service.ensureSpotAccount("user-new");

  assert.equal(created.length, 2);
  assert.equal(created[0]?.accountId, created[1]?.accountId, "account id must be deterministic");
  assert.match(String(registered.spotAccountId), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(again.accountId, registered.spotAccountId);

  existingBalances = [{ accountId: "legacy-account", assetCode: "USDT" }];
  const legacy = await service.ensureSpotAccount("user-new");
  assert.equal(legacy.accountId, "legacy-account");
  assert.equal(created.length, 2, "users with balances keep their existing account");
});

test("self-service 2FA and KYC routes are session-only and scoped to the caller", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const identityClient = {
    async enrollTwoFactor(userId: string) {
      calls.push(["enroll", userId]);
      return { otpauthUri: "otpauth://totp/x" };
    },
    async disableTwoFactor(userId: string, code: string) {
      calls.push(["disable", userId, code]);
      return { enabled: false };
    },
    async submitKycRequest(userId: string, command: Record<string, unknown>) {
      calls.push(["kyc", userId, command]);
      return { status: "pending" };
    }
  } as unknown as IdentityGatewayClient;
  const walletClient = {
    async getWithdrawalLimits(userId: string) {
      calls.push(["limits", userId]);
      return { userId };
    }
  } as unknown as WalletGatewayClient;
  const service = new ApiGatewayApplicationService(
    identityClient,
    walletClient,
    {} as LedgerGatewayClient,
    {} as OrderGatewayClient,
    new InMemoryRateLimiter()
  );
  const session = {
    authType: "session" as const,
    userId: "user-2fa",
    status: "active" as const,
    userType: "customer" as const,
    roles: [],
    permissions: [],
    createdAt: "2026-03-08T00:00:00.000Z",
    active: true
  };
  const apiKey = { ...session, authType: "api_key" as const, apiKeyScopes: ["read" as const] };

  await service.enrollTwoFactor(session);
  await service.disableTwoFactor(session, " 123456 ");
  await service.submitKycRequest(session, { requestedTier: "L1", fullName: "Demo", idNumber: "A123456" });
  await service.getWithdrawalLimits(apiKey);

  await assert.rejects(() => service.enrollTwoFactor(apiKey), /session/i);
  await assert.rejects(
    () => service.disableTwoFactor(session, ""),
    (error: unknown) => (error as { code?: string }).code === "TWO_FACTOR_CODE_REQUIRED"
  );

  assert.deepEqual(calls, [
    ["enroll", "user-2fa"],
    ["disable", "user-2fa", "123456"],
    ["kyc", "user-2fa", { requestedTier: "L1", fullName: "Demo", idNumber: "A123456" }],
    ["limits", "user-2fa"]
  ]);
});
