import { createHash } from "node:crypto";

import type {
  AccountType,
  AssetCode,
  Network,
  OrderStatus,
  OrderType,
  SpotMarket,
  StpMode,
  TimeInForce
} from "@web3-cex/domain";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { RedisClientType } from "redis";

import { ApiGatewayApplicationService } from "../application/api-gateway-application-service.js";
import type {
  ApiKeyScope,
  GatewayAccountStatementQuery,
  GatewayPrincipal,
  IdempotencyStore,
  RateLimiter
} from "../domain/types.js";
import { InMemoryNonceStore, RedisNonceStore } from "../infrastructure/api-key-nonce-store.js";
import { ConsoleGatewayAuditLogger } from "../infrastructure/console-gateway-audit-logger.js";
import { createGatewayRedisClient } from "../infrastructure/gateway-redis.js";
import { HttpIdentityClient } from "../infrastructure/http-identity-client.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { HttpOrderClient } from "../infrastructure/http-order-client.js";
import { HttpWalletClient } from "../infrastructure/http-wallet-client.js";
import { InMemoryIdempotencyStore } from "../infrastructure/in-memory-idempotency-store.js";
import { InMemoryRateLimiter } from "../infrastructure/in-memory-rate-limiter.js";
import { RedisIdempotencyStore } from "../infrastructure/redis-idempotency-store.js";
import { RedisRateLimiter } from "../infrastructure/redis-rate-limiter.js";

@Injectable()
export class ApiGatewayHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly applicationService: ApiGatewayApplicationService;
  private readonly rateLimiter: RateLimiter;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly auditLogger = new ConsoleGatewayAuditLogger();
  private readonly idempotencyTtlMs: number;
  private readonly redisClient?: RedisClientType;

  constructor() {
    const redisUrl = process.env.GATEWAY_REDIS_URL ?? "redis://127.0.0.1:6379";
    const redisPrefix = process.env.GATEWAY_REDIS_PREFIX ?? "web3-cex:gateway";
    const rateLimitStore = process.env.GATEWAY_RATE_LIMIT_STORE ?? "redis";
    const idempotencyStoreMode = process.env.GATEWAY_IDEMPOTENCY_STORE ?? rateLimitStore;

    if (rateLimitStore === "redis" || idempotencyStoreMode === "redis") {
      this.redisClient = createGatewayRedisClient(redisUrl);
    }

    this.rateLimiter =
      rateLimitStore === "redis" && this.redisClient
        ? new RedisRateLimiter(this.redisClient, redisPrefix)
        : new InMemoryRateLimiter();
    this.idempotencyStore =
      idempotencyStoreMode === "redis" && this.redisClient
        ? new RedisIdempotencyStore(this.redisClient, redisPrefix)
        : new InMemoryIdempotencyStore();
    this.idempotencyTtlMs = Number(
      process.env.GATEWAY_IDEMPOTENCY_TTL_MS ?? String(60 * 60 * 1000)
    );

    this.applicationService = new ApiGatewayApplicationService(
      new HttpIdentityClient(
        process.env.GATEWAY_IDENTITY_SERVICE_URL ?? "http://127.0.0.1:3005"
      ),
      new HttpWalletClient(
        process.env.GATEWAY_WALLET_SERVICE_URL ?? "http://127.0.0.1:3002"
      ),
      new HttpLedgerClient(
        process.env.GATEWAY_LEDGER_SERVICE_URL ?? "http://127.0.0.1:3001"
      ),
      new HttpOrderClient(
        process.env.GATEWAY_ORDER_SERVICE_URL ?? "http://127.0.0.1:3009"
      ),
      this.rateLimiter,
      {
        apiKeyMaxDriftMs: Number(process.env.GATEWAY_API_KEY_MAX_DRIFT_MS ?? "300000"),
        rateLimitWindowMs: Number(process.env.GATEWAY_RATE_LIMIT_WINDOW_MS ?? "60000"),
        publicRateLimitMax: Number(process.env.GATEWAY_RATE_LIMIT_PUBLIC_MAX ?? "30"),
        authenticatedRateLimitMax: Number(
          process.env.GATEWAY_RATE_LIMIT_AUTHENTICATED_MAX ?? "120"
        ),
        nonceStore: this.redisClient
          ? new RedisNonceStore(this.redisClient, redisPrefix)
          : new InMemoryNonceStore()
      }
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.redisClient && !this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
  }

  async registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }) {
    return this.applicationService.registerCustomer(command);
  }

  async createCustomerSession(command: {
    email: string;
    password: string;
    twoFactorCode?: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
  }) {
    return this.applicationService.createCustomerSession(command);
  }

  async authenticateCustomerSession(token: string) {
    return this.applicationService.authenticateCustomerSession(token);
  }

  assertApiKeyScope(principal: GatewayPrincipal, scope: ApiKeyScope) {
    this.applicationService.assertApiKeyScope(principal, scope);
  }

  async authenticateApiKey(params: {
    apiKey: string;
    timestamp: string;
    nonce: string;
    signature: string;
    method: string;
    url: string;
    rawBody?: Buffer | string;
  }) {
    return this.applicationService.authenticateApiKey(params);
  }

  async logoutCustomerSession(token: string) {
    return this.applicationService.logoutCustomerSession(token);
  }

  async createApiKey(
    principal: GatewayPrincipal,
    command: { label: string; scopes?: string[]; expiresAt?: string }
  ) {
    return this.applicationService.createApiKey(principal, command);
  }

  async listApiKeys(principal: GatewayPrincipal) {
    return this.applicationService.listApiKeys(principal);
  }

  async revokeApiKey(principal: GatewayPrincipal, apiKeyId: string) {
    return this.applicationService.revokeApiKey(principal, apiKeyId);
  }

  async getTwoFactorStatus(principal: GatewayPrincipal) {
    return this.applicationService.getTwoFactorStatus(principal);
  }

  async enrollTwoFactor(principal: GatewayPrincipal) {
    return this.applicationService.enrollTwoFactor(principal);
  }

  async enableTwoFactor(principal: GatewayPrincipal, code: unknown) {
    return this.applicationService.enableTwoFactor(principal, code);
  }

  async disableTwoFactor(principal: GatewayPrincipal, code: unknown) {
    return this.applicationService.disableTwoFactor(principal, code);
  }

  async regenerateRecoveryCodes(principal: GatewayPrincipal, code: unknown) {
    return this.applicationService.regenerateRecoveryCodes(principal, code);
  }

  async listLoginEvents(principal: GatewayPrincipal, query: { limit?: number; offset?: number }) {
    return this.applicationService.listLoginEvents(principal, query);
  }

  async listDevices(principal: GatewayPrincipal) {
    return this.applicationService.listDevices(principal);
  }

  async revokeDevice(principal: GatewayPrincipal, deviceId: string) {
    return this.applicationService.revokeDevice(principal, deviceId);
  }

  async getKycProfile(principal: GatewayPrincipal) {
    return this.applicationService.getKycProfile(principal);
  }

  async submitKycRequest(
    principal: GatewayPrincipal,
    command: { requestedTier?: string; fullName?: string; idNumber?: string }
  ) {
    return this.applicationService.submitKycRequest(principal, command);
  }

  async getProofOfReserves(principal: GatewayPrincipal) {
    return this.applicationService.getProofOfReserves(principal);
  }

  async getWithdrawalLimits(principal: GatewayPrincipal) {
    return this.applicationService.getWithdrawalLimits(principal);
  }

  async ensureSpotAccount(principal: GatewayPrincipal) {
    return this.applicationService.ensureSpotAccount(principal.userId);
  }

  async listBalances(
    principal: GatewayPrincipal,
    query: {
      accountId?: string;
      assetCode?: AssetCode;
      accountType?: AccountType;
      accountStatus?: "active" | "suspended" | "closed";
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listBalances(principal, query);
  }

  async createDepositAddress(
    principal: GatewayPrincipal,
    command: {
      ledgerAccountId: string;
      assetCode: AssetCode;
      network: Network;
    }
  ) {
    return this.applicationService.createDepositAddress(principal, command);
  }

  async listDepositAddresses(
    principal: GatewayPrincipal,
    query: {
      ledgerAccountId?: string;
      assetCode?: AssetCode;
      network?: Network;
      status?: "active" | "disabled";
      address?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listDepositAddresses(principal, query);
  }

  async listDeposits(
    principal: GatewayPrincipal,
    query: {
      ledgerAccountId?: string;
      assetCode?: AssetCode;
      network?: Network;
      status?: string;
      txHash?: string;
      address?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listDeposits(principal, query);
  }

  async getDeposit(principal: GatewayPrincipal, depositId: string) {
    return this.applicationService.getDeposit(principal, depositId);
  }

  async listWithdrawals(
    principal: GatewayPrincipal,
    query: {
      ledgerAccountId?: string;
      assetCode?: AssetCode;
      network?: Network;
      status?: string;
      reviewStatus?: string;
      txHash?: string;
      toAddress?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listWithdrawals(principal, query);
  }

  async getWithdrawal(principal: GatewayPrincipal, withdrawalId: string) {
    return this.applicationService.getWithdrawal(principal, withdrawalId);
  }

  async validateWithdrawal(
    principal: GatewayPrincipal,
    command: {
      ledgerAccountId: string;
      assetCode: AssetCode;
      network: Network;
      toAddress: string;
      amount: string;
      fee: string;
      twoFactorCode?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    return this.applicationService.validateWithdrawal(principal, command);
  }

  async requestWithdrawal(
    principal: GatewayPrincipal,
    command: {
      ledgerAccountId: string;
      assetCode: AssetCode;
      network: Network;
      toAddress: string;
      amount: string;
      fee: string;
      twoFactorCode?: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    return this.applicationService.requestWithdrawal(principal, command);
  }

  async listWithdrawalAddressBook(
    principal: GatewayPrincipal,
    query: {
      network?: Network;
      address?: string;
      isWhitelisted?: boolean;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listWithdrawalAddressBook(principal, query);
  }

  async createWithdrawalAddressBookEntry(
    principal: GatewayPrincipal,
    command: {
      network: Network;
      address: string;
      label: string;
      isWhitelisted?: boolean;
    }
  ) {
    return this.applicationService.createWithdrawalAddressBookEntry(principal, command);
  }

  async listWalletNotifications(
    principal: GatewayPrincipal,
    query: {
      withdrawalId?: string;
      depositId?: string;
      eventType?: string;
      status?: string;
      channel?: string;
      readState?: "read" | "unread";
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listWalletNotifications(principal, query);
  }

  async countUnreadWalletNotifications(principal: GatewayPrincipal) {
    return this.applicationService.countUnreadWalletNotifications(principal);
  }

  async markWalletNotificationRead(principal: GatewayPrincipal, notificationId: string) {
    return this.applicationService.markWalletNotificationRead(principal, notificationId);
  }

  async markAllWalletNotificationsRead(principal: GatewayPrincipal) {
    return this.applicationService.markAllWalletNotificationsRead(principal);
  }

  async getLedgerStatement(principal: GatewayPrincipal, query: GatewayAccountStatementQuery) {
    return this.applicationService.getLedgerStatement(principal, query);
  }

  async createOrder(
    principal: GatewayPrincipal,
    command: {
      accountId: string;
      market: SpotMarket;
      side: "buy" | "sell";
      type: OrderType;
      timeInForce?: TimeInForce;
      price?: string;
      quantity: string;
      idempotencyKey: string;
      traceId?: string;
      postOnly?: boolean;
      stpMode?: StpMode;
      triggerPrice?: string;
    }
  ) {
    return this.applicationService.createOrder(principal, command);
  }

  async cancelOrder(principal: GatewayPrincipal, orderId: string) {
    return this.applicationService.cancelOrder(principal, orderId);
  }

  async getOrder(principal: GatewayPrincipal, orderId: string) {
    return this.applicationService.getOrder(principal, orderId);
  }

  async listOrders(
    principal: GatewayPrincipal,
    query: {
      accountId?: string;
      market?: SpotMarket;
      status?: OrderStatus;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listOrders(principal, query);
  }

  async listTrades(
    principal: GatewayPrincipal,
    query: {
      market?: SpotMarket;
      orderId?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    return this.applicationService.listTrades(principal, query);
  }

  async getTradeJournals(principal: GatewayPrincipal, tradeId: string) {
    return this.applicationService.getTradeJournals(principal, tradeId);
  }

  async consumeRateLimit(params: { principal?: GatewayPrincipal; ipAddress: string }) {
    return this.applicationService.consumeRateLimit(params);
  }

  async beginIdempotentRequest(params: {
    principal?: GatewayPrincipal;
    ipAddress: string;
    method: string;
    url: string;
    rawBody?: Buffer | string;
    idempotencyKey: string;
  }) {
    return this.idempotencyStore.begin({
      scopeKey: this.buildIdempotencyScope(params.principal, params.ipAddress),
      idempotencyKey: params.idempotencyKey,
      requestFingerprint: buildRequestFingerprint(params.method, params.url, params.rawBody),
      ttlMs: this.idempotencyTtlMs
    });
  }

  async completeIdempotentRequest(params: {
    principal?: GatewayPrincipal;
    ipAddress: string;
    method: string;
    url: string;
    rawBody?: Buffer | string;
    idempotencyKey: string;
    statusCode: number;
    responseBody: string;
  }) {
    await this.idempotencyStore.complete({
      scopeKey: this.buildIdempotencyScope(params.principal, params.ipAddress),
      idempotencyKey: params.idempotencyKey,
      requestFingerprint: buildRequestFingerprint(params.method, params.url, params.rawBody),
      ttlMs: this.idempotencyTtlMs,
      statusCode: params.statusCode,
      responseBody: params.responseBody
    });
  }

  async abortIdempotentRequest(params: {
    principal?: GatewayPrincipal;
    ipAddress: string;
    method: string;
    url: string;
    rawBody?: Buffer | string;
    idempotencyKey: string;
  }) {
    await this.idempotencyStore.abort({
      scopeKey: this.buildIdempotencyScope(params.principal, params.ipAddress),
      idempotencyKey: params.idempotencyKey,
      requestFingerprint: buildRequestFingerprint(params.method, params.url, params.rawBody)
    });
  }

  logAudit(entry: Record<string, unknown>): void {
    this.auditLogger.log(entry);
  }

  private buildIdempotencyScope(
    principal: GatewayPrincipal | undefined,
    ipAddress: string
  ): string {
    if (!principal) {
      return `public:${ipAddress}`;
    }

    const actorId =
      principal.apiKeyId ?? principal.sessionId ?? principal.userId;
    return `${principal.authType}:${principal.userId}:${actorId}`;
  }
}

function buildRequestFingerprint(
  method: string,
  url: string,
  rawBody?: Buffer | string
): string {
  const body =
    typeof rawBody === "string" ? rawBody : rawBody?.toString("utf8") ?? "";

  return createHash("sha256")
    .update(method.toUpperCase())
    .update("\n")
    .update(url)
    .update("\n")
    .update(body)
    .digest("hex");
}
