import type {
  AccountType,
  AssetCode,
  Network,
  OrderSide,
  OrderStatus,
  OrderType,
  SpotMarket,
  StpMode,
  TimeInForce
} from "@web3-cex/domain";

export type GatewayAuthMode = "public" | "session" | "session_or_api_key";
export type GatewayAuthType = "session" | "api_key";
export type ApiKeyScope = "read" | "trade" | "withdraw";
export type IdentityUserStatus = "active" | "suspended" | "disabled";
export type IdentityUserType = "customer" | "ops";

export interface CustomerSessionInfo {
  sessionId: string;
  userId: string;
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  userType: IdentityUserType;
  scope: "customer_web";
  roles: string[];
  permissions: string[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  active: boolean;
}

export interface ApiKeyAuthInfo {
  apiKeyId: string;
  userId: string;
  email?: string;
  displayName?: string;
  userStatus: IdentityUserStatus;
  userType: IdentityUserType;
  label: string;
  keyId?: string;
  keyPrefix: string;
  scopes?: ApiKeyScope[];
  apiKeyStatus: "active" | "revoked";
  createdBy?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface GatewayPrincipal {
  authType: GatewayAuthType;
  userId: string;
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  userType: IdentityUserType;
  sessionId?: string;
  apiKeyId?: string;
  apiKeyLabel?: string;
  apiKeyKeyPrefix?: string;
  /** Only set for API key principals; sessions can do everything the UI can. */
  apiKeyScopes?: ApiKeyScope[];
  scope?: "customer_web";
  roles: string[];
  permissions: string[];
  createdAt: string;
  expiresAt?: string;
  lastSeenAt?: string;
  active: boolean;
}

export interface GatewayLedgerAccount {
  accountId: string;
  userId?: string;
  accountType: AccountType;
  status: "active" | "suspended" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface GatewayOrderRecord {
  orderId: string;
  idempotencyKey: string;
  traceId: string;
  userId: string;
  accountId: string;
  market: SpotMarket;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price: string;
  quantity: string;
  filledQuantity: string;
  restingQuantity: string;
  status: OrderStatus;
  lockAssetCode: string;
  lockAmount: string;
  rejectedReason?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  postOnly?: boolean;
  stpMode?: StpMode;
  triggerPrice?: string;
  triggeredAt?: string;
}

export interface GatewayTradeRecord {
  tradeId: string;
  market: SpotMarket;
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  buyerOrderId: string;
  sellerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  settlementId: string;
  executedAt: string;
}

export type GatewayJournalDirection = "debit" | "credit";

export interface GatewayJournalEntry {
  accountId: string;
  assetCode: string;
  direction: GatewayJournalDirection;
  amount: string;
  referenceType: string;
  referenceId: string;
}

/** A ledger journal with its entries, as returned by GET /ledger/journals/:id. */
export interface GatewayLedgerJournal {
  journalId: string;
  businessType: string;
  businessId: string;
  idempotencyKey?: string;
  traceId?: string;
  description?: string;
  entries: GatewayJournalEntry[];
  createdAt: string;
}

export interface GatewayJournalQuery {
  businessId?: string;
  businessType?: string;
  limit?: number;
  offset?: number;
}

export interface IdentityGatewayClient {
  registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<Record<string, unknown>>;
  createCustomerSession(command: {
    email: string;
    password: string;
    twoFactorCode?: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<CustomerSessionInfo & { token: string }>;
  introspectCustomerSession(token: string): Promise<CustomerSessionInfo>;
  revokeCustomerSession(token: string): Promise<{ revoked: true; revokedAt: string }>;
  createApiKey(
    userId: string,
    command: {
      label: string;
      scopes?: string[];
      expiresAt?: string;
      createdBy?: string;
    }
  ): Promise<Record<string, unknown>>;
  listApiKeys(userId: string): Promise<Record<string, unknown>[]>;
  revokeApiKey(userId: string, apiKeyId: string): Promise<Record<string, unknown>>;
  verifyApiKeySignature(command: {
    keyId: string;
    canonicalRequest: string;
    signature: string;
  }): Promise<ApiKeyAuthInfo>;
  /** M4-1 self-service 2FA (identity owns the secret and recovery codes). */
  getTwoFactorStatus(userId: string): Promise<Record<string, unknown>>;
  enrollTwoFactor(userId: string): Promise<Record<string, unknown>>;
  enableTwoFactor(userId: string, code: string): Promise<Record<string, unknown>>;
  disableTwoFactor(userId: string, code: string): Promise<Record<string, unknown>>;
  regenerateRecoveryCodes(userId: string, code: string): Promise<Record<string, unknown>>;
  /** M4-4 KYC tier and requests. */
  getKycProfile(userId: string): Promise<Record<string, unknown>>;
  submitKycRequest(
    userId: string,
    command: { requestedTier: string; fullName: string; idNumber: string }
  ): Promise<Record<string, unknown>>;
  /** Login history, devices and device revocation (optional for test fakes). */
  listLoginEvents?(
    userId: string,
    query: { limit?: number; offset?: number }
  ): Promise<Record<string, unknown>>;
  listDevices?(userId: string): Promise<Record<string, unknown>>;
  revokeDevice?(userId: string, deviceId: string): Promise<Record<string, unknown>>;
}

export interface WalletGatewayClient {
  /** M4-4 / M5-2: tier limits, today's usage and security cooldown. */
  getWithdrawalLimits(userId: string): Promise<Record<string, unknown>>;
  createDepositAddress(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: AssetCode;
    network: Network;
  }): Promise<Record<string, unknown>>;
  listDepositAddresses(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: AssetCode;
    network?: Network;
    status?: "active" | "disabled";
    address?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  listDeposits(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: AssetCode;
    network?: Network;
    status?: string;
    txHash?: string;
    address?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  getDeposit(depositId: string): Promise<Record<string, unknown>>;
  listWithdrawals(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: AssetCode;
    network?: Network;
    status?: string;
    reviewStatus?: string;
    txHash?: string;
    toAddress?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  getWithdrawal(withdrawalId: string): Promise<Record<string, unknown>>;
  validateWithdrawal(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: AssetCode;
    network: Network;
    toAddress: string;
    amount: string;
    fee: string;
    twoFactorCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  requestWithdrawal(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: AssetCode;
    network: Network;
    toAddress: string;
    amount: string;
    fee: string;
    twoFactorCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  listWithdrawalAddressBookEntries(query: {
    userId: string;
    network?: Network;
    address?: string;
    isWhitelisted?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  createWithdrawalAddressBookEntry(command: {
    userId: string;
    network: Network;
    address: string;
    label: string;
    isWhitelisted?: boolean;
  }): Promise<Record<string, unknown>>;
  listWalletNotifications(query: {
    userId: string;
    withdrawalId?: string;
    depositId?: string;
    eventType?: string;
    status?: string;
    channel?: string;
    readState?: "read" | "unread";
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  countUnreadWalletNotifications(userId: string): Promise<{ unreadCount: number }>;
  /** Omitting notificationIds marks every unread notification of the user. */
  markWalletNotificationsRead(command: {
    userId: string;
    notificationIds?: string[];
  }): Promise<{ updated: number; readAt: string; unreadCount: number }>;
}

export type GatewayStatementCategory = "deposit" | "withdrawal" | "trade" | "adjustment" | "fee";

export interface GatewayAccountStatementQuery {
  assetCode?: string;
  category?: GatewayStatementCategory;
  businessType?: string;
  includeLockEvents?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface GatewayAccountStatement extends PagedResult<Record<string, unknown>> {
  accountId: string;
  balanceDerivable: Record<string, boolean>;
}

export interface LedgerGatewayClient {
  getAccount(accountId: string): Promise<GatewayLedgerAccount>;
  /** Idempotent: the ledger upserts by accountId. */
  createAccount(command: {
    accountId: string;
    userId: string;
    accountType: AccountType;
  }): Promise<GatewayLedgerAccount>;
  listBalances(query: {
    userId: string;
    accountId?: string;
    assetCode?: AssetCode;
    accountType?: AccountType;
    accountStatus?: GatewayLedgerAccount["status"];
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>>;
  /**
   * Lists journals matching the query and loads each one with its entries.
   * Reusable building block for trade journal views and asset statements.
   */
  listJournalsWithEntries(query: GatewayJournalQuery): Promise<GatewayLedgerJournal[]>;
  /** Customer statement (资金流水) of one ledger account. */
  getAccountStatement(
    accountId: string,
    query: GatewayAccountStatementQuery
  ): Promise<GatewayAccountStatement>;
}

export interface OrderGatewayClient {
  createOrder(command: {
    userId: string;
    accountId: string;
    market: SpotMarket;
    side: OrderSide;
    type: OrderType;
    timeInForce?: TimeInForce;
    price?: string;
    quantity: string;
    idempotencyKey: string;
    traceId?: string;
    postOnly?: boolean;
    stpMode?: StpMode;
    triggerPrice?: string;
  }): Promise<GatewayOrderRecord>;
  cancelOrder(command: {
    orderId: string;
    userId: string;
  }): Promise<GatewayOrderRecord>;
  getOrder(orderId: string): Promise<GatewayOrderRecord>;
  listOrders(query: {
    userId: string;
    accountId?: string;
    market?: SpotMarket;
    status?: OrderStatus;
    limit?: number;
    offset?: number;
  }): Promise<GatewayOrderRecord[]>;
  listTrades(query: {
    userId: string;
    market?: SpotMarket;
    orderId?: string;
    limit?: number;
    offset?: number;
  }): Promise<GatewayTradeRecord[]>;
  getTrade(tradeId: string): Promise<GatewayTradeRecord>;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface NonceStore {
  /** Returns false when the key was already claimed inside the TTL. */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

export interface RateLimiter {
  consume(input: {
    key: string;
    limit: number;
    windowMs: number;
    now?: Date;
  }): Promise<RateLimitDecision>;
}

export interface IdempotencyReplay {
  outcome: "acquired" | "replay" | "conflict" | "in_flight";
  statusCode?: number;
  responseBody?: string;
}

export interface IdempotencyStore {
  begin(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    ttlMs: number;
    now?: Date;
  }): Promise<IdempotencyReplay>;
  complete(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    statusCode: number;
    responseBody: string;
    ttlMs: number;
    now?: Date;
  }): Promise<void>;
  abort(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<void>;
}
