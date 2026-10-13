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

import { ApiGatewayError } from "../domain/errors.js";
import { normalizeOrderOptions } from "./order-options.js";
import type {
  ApiKeyScope,
  GatewayAccountStatementQuery,
  GatewayPrincipal,
  GatewayStatementCategory,
  NonceStore,
  IdentityGatewayClient,
  LedgerGatewayClient,
  OrderGatewayClient,
  RateLimiter,
  WalletGatewayClient
} from "../domain/types.js";
import {
  buildTradeJournalView,
  buildTradeMaskingContext,
  listUnclassifiedAccountIds,
  selectTradeJournals,
  type JournalAccountInfo,
  type TradeJournalView
} from "../domain/journal-view.js";
import { buildApiKeyCanonicalRequest } from "../http/api-key-signature.js";
import { InMemoryNonceStore } from "../infrastructure/api-key-nonce-store.js";

const STATEMENT_CATEGORIES: GatewayStatementCategory[] = [
  "deposit",
  "withdrawal",
  "trade",
  "adjustment",
  "fee"
];

interface ServiceOptions {
  now?: () => Date;
  apiKeyMaxDriftMs?: number;
  rateLimitWindowMs?: number;
  publicRateLimitMax?: number;
  authenticatedRateLimitMax?: number;
  nonceStore?: NonceStore;
}

export class ApiGatewayApplicationService {
  private readonly now: () => Date;
  private readonly apiKeyMaxDriftMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly publicRateLimitMax: number;
  private readonly authenticatedRateLimitMax: number;
  private readonly nonceStore: NonceStore;

  constructor(
    private readonly identityClient: IdentityGatewayClient,
    private readonly walletClient: WalletGatewayClient,
    private readonly ledgerClient: LedgerGatewayClient,
    private readonly orderClient: OrderGatewayClient,
    private readonly rateLimiter: RateLimiter,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.apiKeyMaxDriftMs = options.apiKeyMaxDriftMs ?? 5 * 60 * 1000;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
    this.publicRateLimitMax = options.publicRateLimitMax ?? 30;
    this.authenticatedRateLimitMax = options.authenticatedRateLimitMax ?? 120;
    this.nonceStore = options.nonceStore ?? new InMemoryNonceStore();
  }

  async registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }) {
    const user = await this.identityClient.registerCustomer(command);
    // Every customer needs a spot ledger account before they can deposit or trade.
    if (typeof user.userId === "string") {
      const account = await this.ensureSpotAccount(user.userId);
      return { ...user, spotAccountId: account.accountId };
    }
    return user;
  }

  /**
   * Returns the customer's spot account, creating one on first use. Users that
   * already hold balances keep their existing account; otherwise a stable
   * account id is derived from the user id so retries never create duplicates.
   */
  async ensureSpotAccount(userId: string): Promise<{ accountId: string; accountType: "spot" }> {
    const existing = await this.ledgerClient.listBalances({
      userId,
      accountType: "spot",
      limit: 1,
      offset: 0
    });
    const existingAccountId = existing.items[0]?.accountId;
    if (typeof existingAccountId === "string" && existingAccountId) {
      return { accountId: existingAccountId, accountType: "spot" };
    }

    const account = await this.ledgerClient.createAccount({
      accountId: deriveStableUuid(`customer-spot-account:${userId}`),
      userId,
      accountType: "spot"
    });
    if (account.userId && account.userId !== userId) {
      throw new ApiGatewayError("FORBIDDEN", 403, "Spot account belongs to another user");
    }
    return { accountId: account.accountId, accountType: "spot" };
  }

  async createCustomerSession(command: {
    email: string;
    password: string;
    twoFactorCode?: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
  }) {
    return this.identityClient.createCustomerSession(command);
  }

  async authenticateCustomerSession(token: string): Promise<GatewayPrincipal> {
    if (!token.trim()) {
      throw new ApiGatewayError("UNAUTHORIZED", 401, "Customer session token is required");
    }

    const session = await this.identityClient.introspectCustomerSession(token.trim());
    if (session.userType !== "customer") {
      throw new ApiGatewayError("FORBIDDEN", 403, "Only customer sessions are allowed");
    }

    return {
      authType: "session",
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      status: session.status,
      userType: session.userType,
      scope: session.scope,
      roles: session.roles,
      permissions: session.permissions,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      active: session.active
    };
  }

  async authenticateApiKey(params: {
    apiKey: string;
    timestamp: string;
    nonce: string;
    signature: string;
    method: string;
    url: string;
    rawBody?: Buffer | string;
  }): Promise<GatewayPrincipal> {
    const keyId = params.apiKey.trim();
    if (!keyId) {
      throw new ApiGatewayError("UNAUTHORIZED", 401, "API key is required");
    }

    const nonce = params.nonce.trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
      throw new ApiGatewayError(
        "INVALID_API_KEY_NONCE",
        401,
        "X-API-Nonce must be 8-64 characters of [A-Za-z0-9_-]"
      );
    }

    const requestTimestamp = Number(params.timestamp);
    if (!Number.isFinite(requestTimestamp)) {
      throw new ApiGatewayError(
        "INVALID_API_KEY_TIMESTAMP",
        401,
        "API key timestamp must be a unix epoch in milliseconds"
      );
    }

    const driftMs = Math.abs(this.now().getTime() - requestTimestamp);
    if (driftMs > this.apiKeyMaxDriftMs) {
      throw new ApiGatewayError(
        "API_KEY_TIMESTAMP_EXPIRED",
        401,
        "API key timestamp is outside the allowed drift window"
      );
    }

    // The gateway never holds the secret: it rebuilds the canonical request
    // from the raw HTTP request and lets identity recompute the HMAC.
    const authInfo = await this.identityClient.verifyApiKeySignature({
      keyId,
      canonicalRequest: buildApiKeyCanonicalRequest({
        method: params.method,
        url: params.url,
        timestamp: params.timestamp,
        nonce,
        rawBody: params.rawBody
      }),
      signature: params.signature
    });
    if (authInfo.userType !== "customer") {
      throw new ApiGatewayError("FORBIDDEN", 403, "Only customer API keys are allowed");
    }

    // Claim the nonce only after the signature is valid so a forged request
    // cannot burn nonces. The TTL covers the whole timestamp drift window.
    const fresh = await this.nonceStore.claim(`${keyId}:${nonce}`, this.apiKeyMaxDriftMs * 2);
    if (!fresh) {
      throw new ApiGatewayError("API_KEY_NONCE_REPLAYED", 401, "API key nonce was already used");
    }

    return {
      authType: "api_key",
      apiKeyId: authInfo.apiKeyId,
      apiKeyLabel: authInfo.label,
      apiKeyKeyPrefix: authInfo.keyId ?? authInfo.keyPrefix,
      apiKeyScopes: authInfo.scopes ?? ["read", "trade"],
      userId: authInfo.userId,
      email: authInfo.email,
      displayName: authInfo.displayName,
      status: authInfo.userStatus,
      userType: authInfo.userType,
      roles: [],
      permissions: [],
      createdAt: authInfo.createdAt,
      expiresAt: authInfo.expiresAt,
      lastSeenAt: authInfo.lastUsedAt,
      active: authInfo.active
    };
  }

  /** API keys are scoped; customer sessions are not. */
  assertApiKeyScope(principal: GatewayPrincipal, scope: ApiKeyScope): void {
    if (principal.authType !== "api_key") {
      return;
    }
    if (!(principal.apiKeyScopes ?? []).includes(scope)) {
      throw new ApiGatewayError(
        "API_KEY_SCOPE_DENIED",
        403,
        `API key ${principal.apiKeyKeyPrefix ?? principal.apiKeyId} lacks the "${scope}" scope`
      );
    }
  }

  async logoutCustomerSession(token: string) {
    return this.identityClient.revokeCustomerSession(token.trim());
  }

  async createApiKey(
    principal: GatewayPrincipal,
    command: { label: string; scopes?: string[]; expiresAt?: string }
  ) {
    this.assertCustomerSession(principal);
    return this.identityClient.createApiKey(principal.userId, {
      ...command,
      createdBy: principal.userId
    });
  }

  async listApiKeys(principal: GatewayPrincipal) {
    this.assertCustomerSession(principal);
    return this.identityClient.listApiKeys(principal.userId);
  }

  async revokeApiKey(principal: GatewayPrincipal, apiKeyId: string) {
    this.assertCustomerSession(principal);
    return this.identityClient.revokeApiKey(principal.userId, apiKeyId);
  }

  // M4-1: self-service 2FA. Session-only; identity verifies every code.
  async getTwoFactorStatus(principal: GatewayPrincipal) {
    this.assertCustomerSession(principal);
    return this.identityClient.getTwoFactorStatus(principal.userId);
  }

  async enrollTwoFactor(principal: GatewayPrincipal) {
    this.assertCustomerSession(principal);
    return this.identityClient.enrollTwoFactor(principal.userId);
  }

  async enableTwoFactor(principal: GatewayPrincipal, code: unknown) {
    this.assertCustomerSession(principal);
    return this.identityClient.enableTwoFactor(principal.userId, requireCode(code));
  }

  async disableTwoFactor(principal: GatewayPrincipal, code: unknown) {
    this.assertCustomerSession(principal);
    return this.identityClient.disableTwoFactor(principal.userId, requireCode(code));
  }

  async regenerateRecoveryCodes(principal: GatewayPrincipal, code: unknown) {
    this.assertCustomerSession(principal);
    return this.identityClient.regenerateRecoveryCodes(principal.userId, requireCode(code));
  }

  // M4-4: KYC tier (demo data only).
  async getKycProfile(principal: GatewayPrincipal) {
    this.assertCustomerSession(principal);
    return this.identityClient.getKycProfile(principal.userId);
  }

  async submitKycRequest(
    principal: GatewayPrincipal,
    command: { requestedTier?: string; fullName?: string; idNumber?: string }
  ) {
    this.assertCustomerSession(principal);
    return this.identityClient.submitKycRequest(principal.userId, {
      requestedTier: String(command.requestedTier ?? ""),
      fullName: String(command.fullName ?? ""),
      idNumber: String(command.idNumber ?? "")
    });
  }

  // --- login security (session only) ----------------------------------------

  async listLoginEvents(principal: GatewayPrincipal, query: { limit?: number; offset?: number }) {
    this.assertCustomerSession(principal);
    return this.requireIdentityMethod(this.identityClient.listLoginEvents).call(
      this.identityClient,
      principal.userId,
      query
    );
  }

  async listDevices(principal: GatewayPrincipal) {
    this.assertCustomerSession(principal);
    return this.requireIdentityMethod(this.identityClient.listDevices).call(this.identityClient, principal.userId);
  }

  async revokeDevice(principal: GatewayPrincipal, deviceId: string) {
    this.assertCustomerSession(principal);
    return this.requireIdentityMethod(this.identityClient.revokeDevice).call(
      this.identityClient,
      principal.userId,
      deviceId
    );
  }

  private requireIdentityMethod<T>(method: T | undefined): T {
    if (!method) {
      throw new ApiGatewayError("IDENTITY_UPSTREAM_FAILED", 501, "Identity client does not support login security");
    }
    return method;
  }

  /** Tier, per-asset limits, today's usage and cooldown (session or API key with read). */
  async getWithdrawalLimits(principal: GatewayPrincipal) {
    return this.walletClient.getWithdrawalLimits(principal.userId);
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
    if (query.accountId) {
      await this.assertAccountOwnership(query.accountId, principal.userId);
    }

    return this.ledgerClient.listBalances({
      userId: principal.userId,
      accountId: query.accountId,
      assetCode: query.assetCode,
      accountType: query.accountType,
      accountStatus: query.accountStatus,
      limit: query.limit,
      offset: query.offset
    });
  }

  // --- M4-5 asset statement --------------------------------------------------

  /**
   * 资金流水 of the caller's own spot account. The account id is never taken
   * from the request, so a customer cannot read another account's ledger.
   */
  async getLedgerStatement(principal: GatewayPrincipal, query: GatewayAccountStatementQuery) {
    if (query.category && !STATEMENT_CATEGORIES.includes(query.category)) {
      throw new ApiGatewayError(
        "INVALID_STATEMENT_QUERY",
        400,
        `category must be one of ${STATEMENT_CATEGORIES.join(", ")}`
      );
    }
    for (const [name, value] of [
      ["from", query.from],
      ["to", query.to]
    ] as const) {
      if (value && !Number.isFinite(Date.parse(value))) {
        throw new ApiGatewayError(
          "INVALID_STATEMENT_QUERY",
          400,
          `${name} must be an ISO-8601 timestamp`
        );
      }
    }

    const { accountId } = await this.ensureSpotAccount(principal.userId);
    return this.ledgerClient.getAccountStatement(accountId, {
      assetCode: query.assetCode,
      category: query.category,
      businessType: query.businessType,
      includeLockEvents: query.includeLockEvents,
      from: query.from,
      to: query.to,
      limit: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200),
      offset: Math.max(Math.trunc(query.offset ?? 0), 0)
    });
  }

  async createDepositAddress(
    principal: GatewayPrincipal,
    command: {
      ledgerAccountId: string;
      assetCode: AssetCode;
      network: Network;
    }
  ) {
    await this.assertAccountOwnership(command.ledgerAccountId, principal.userId);
    return this.walletClient.createDepositAddress({
      userId: principal.userId,
      ledgerAccountId: command.ledgerAccountId,
      assetCode: command.assetCode,
      network: command.network
    });
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
    if (query.ledgerAccountId) {
      await this.assertAccountOwnership(query.ledgerAccountId, principal.userId);
    }

    return this.walletClient.listDepositAddresses({
      userId: principal.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      address: query.address,
      limit: query.limit,
      offset: query.offset
    });
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
    if (query.ledgerAccountId) {
      await this.assertAccountOwnership(query.ledgerAccountId, principal.userId);
    }

    return this.walletClient.listDeposits({
      userId: principal.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      txHash: query.txHash,
      address: query.address,
      limit: query.limit,
      offset: query.offset
    });
  }

  async getDeposit(principal: GatewayPrincipal, depositId: string) {
    const deposit = await this.walletClient.getDeposit(depositId);
    this.assertResourceOwnership(deposit, principal.userId, "Deposit", depositId);
    return deposit;
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
    if (query.ledgerAccountId) {
      await this.assertAccountOwnership(query.ledgerAccountId, principal.userId);
    }

    return this.walletClient.listWithdrawals({
      userId: principal.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      reviewStatus: query.reviewStatus,
      txHash: query.txHash,
      toAddress: query.toAddress,
      limit: query.limit,
      offset: query.offset
    });
  }

  async getWithdrawal(principal: GatewayPrincipal, withdrawalId: string) {
    const withdrawal = await this.walletClient.getWithdrawal(withdrawalId);
    this.assertResourceOwnership(withdrawal, principal.userId, "Withdrawal", withdrawalId);
    return withdrawal;
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
    await this.assertAccountOwnership(command.ledgerAccountId, principal.userId);
    return this.walletClient.validateWithdrawal({
      userId: principal.userId,
      ...command
    });
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
    await this.assertAccountOwnership(command.ledgerAccountId, principal.userId);
    return this.walletClient.requestWithdrawal({
      userId: principal.userId,
      ...command
    });
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
    return this.walletClient.listWithdrawalAddressBookEntries({
      userId: principal.userId,
      network: query.network,
      address: query.address,
      isWhitelisted: query.isWhitelisted,
      limit: query.limit,
      offset: query.offset
    });
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
    return this.walletClient.createWithdrawalAddressBookEntry({
      userId: principal.userId,
      ...command
    });
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
    return this.walletClient.listWalletNotifications({
      userId: principal.userId,
      withdrawalId: query.withdrawalId,
      depositId: query.depositId,
      eventType: query.eventType,
      status: query.status,
      channel: query.channel,
      readState: query.readState,
      limit: query.limit,
      offset: query.offset
    });
  }

  // --- M4-2 notification center: customer read markers ---------------------

  async countUnreadWalletNotifications(principal: GatewayPrincipal) {
    return this.walletClient.countUnreadWalletNotifications(principal.userId);
  }

  /** Wallet only touches rows of principal.userId; foreign ids come back as 404. */
  async markWalletNotificationRead(principal: GatewayPrincipal, notificationId: string) {
    if (!notificationId.trim()) {
      throw new ApiGatewayError("INVALID_NOTIFICATION_ID", 400, "notificationId is required");
    }
    return this.walletClient.markWalletNotificationsRead({
      userId: principal.userId,
      notificationIds: [notificationId.trim()]
    });
  }

  async markAllWalletNotificationsRead(principal: GatewayPrincipal) {
    return this.walletClient.markWalletNotificationsRead({ userId: principal.userId });
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
    await this.assertAccountOwnership(command.accountId, principal.userId);
    return this.orderClient.createOrder({
      userId: principal.userId,
      ...normalizeOrderOptions(command)
    });
  }

  async cancelOrder(principal: GatewayPrincipal, orderId: string) {
    const existingOrder = await this.orderClient.getOrder(orderId);
    this.assertResourceOwnership(existingOrder, principal.userId, "Order", orderId);
    return this.orderClient.cancelOrder({
      orderId,
      userId: principal.userId
    });
  }

  async getOrder(principal: GatewayPrincipal, orderId: string) {
    const order = await this.orderClient.getOrder(orderId);
    this.assertResourceOwnership(order, principal.userId, "Order", orderId);
    return order;
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
    if (query.accountId) {
      await this.assertAccountOwnership(query.accountId, principal.userId);
    }

    return this.orderClient.listOrders({
      userId: principal.userId,
      accountId: query.accountId,
      market: query.market,
      status: query.status,
      limit: query.limit,
      offset: query.offset
    });
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
    if (query.orderId) {
      const order = await this.orderClient.getOrder(query.orderId);
      this.assertResourceOwnership(order, principal.userId, "Order", query.orderId);
    }

    return this.orderClient.listTrades({
      userId: principal.userId,
      market: query.market,
      orderId: query.orderId,
      limit: query.limit,
      offset: query.offset
    });
  }

  /**
   * M3-3: every ledger journal a trade produced, masked for the caller. Only
   * the buyer or the seller may read it; the other side shows as 「对手方」.
   */
  async getTradeJournals(principal: GatewayPrincipal, tradeId: string): Promise<TradeJournalView> {
    const trade = await this.orderClient.getTrade(tradeId);
    if (trade.buyerUserId !== principal.userId && trade.sellerUserId !== principal.userId) {
      throw new ApiGatewayError(
        "RESOURCE_FORBIDDEN",
        403,
        `Trade ${tradeId} does not belong to user ${principal.userId}`
      );
    }

    const journals = selectTradeJournals(
      tradeId,
      await this.ledgerClient.listJournalsWithEntries({ businessId: tradeId, limit: 20 })
    );
    const baseContext = buildTradeMaskingContext(trade, principal.userId);
    const directory = new Map<string, JournalAccountInfo>();
    await Promise.all(
      listUnclassifiedAccountIds(journals, baseContext).map(async (accountId) => {
        try {
          const account = await this.ledgerClient.getAccount(accountId);
          directory.set(accountId, { userId: account.userId, accountType: account.accountType });
        } catch {
          // Unknown accounts are still masked ("其他账户"), never exposed.
        }
      })
    );

    return buildTradeJournalView({
      trade,
      viewerUserId: principal.userId,
      journals,
      context: { ...baseContext, accountDirectory: directory }
    });
  }

  async consumeRateLimit(params: {
    principal?: GatewayPrincipal;
    ipAddress: string;
  }) {
    const key = params.principal
      ? `principal:${params.principal.authType}:${params.principal.userId}:${params.principal.apiKeyId ?? params.principal.sessionId ?? "default"}`
      : `ip:${params.ipAddress}`;
    const limit = params.principal
      ? this.authenticatedRateLimitMax
      : this.publicRateLimitMax;

    return this.rateLimiter.consume({
      key,
      limit,
      windowMs: this.rateLimitWindowMs,
      now: this.now()
    });
  }

  private assertCustomerSession(principal: GatewayPrincipal): void {
    if (principal.authType !== "session") {
      throw new ApiGatewayError(
        "SESSION_REQUIRED",
        401,
        "This endpoint requires a customer session"
      );
    }
  }

  private async assertAccountOwnership(accountId: string, userId: string): Promise<void> {
    const account = await this.ledgerClient.getAccount(accountId);
    if (account.userId !== userId) {
      throw new ApiGatewayError(
        "ACCOUNT_FORBIDDEN",
        403,
        `Account ${accountId} does not belong to user ${userId}`
      );
    }

    if (account.status !== "active") {
      throw new ApiGatewayError(
        "ACCOUNT_NOT_ACTIVE",
        409,
        `Account ${accountId} is not active`
      );
    }
  }

  private assertResourceOwnership(
    resource: { userId?: unknown },
    userId: string,
    resourceName: string,
    resourceId: string
  ): void {
    if (resource.userId !== userId) {
      throw new ApiGatewayError(
        "RESOURCE_FORBIDDEN",
        403,
        `${resourceName} ${resourceId} does not belong to user ${userId}`
      );
    }
  }
}

/** Deterministic RFC 4122 style id (version 5 layout) from a SHA-1 of the seed. */
function deriveStableUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function requireCode(code: unknown): string {
  const value = typeof code === "string" ? code.trim() : "";
  if (!value) {
    throw new ApiGatewayError("TWO_FACTOR_CODE_REQUIRED", 400, "A two-factor code is required");
  }
  return value;
}
