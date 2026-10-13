// Wire types for the gateway / market-data / demo-simulator APIs as seen by the browser.
// Every field coming from a service is optional unless the UI genuinely cannot work without it.

export interface MarketDefinition {
  market: string;
  baseAsset: string;
  quoteAsset: string;
  minQuantity: string;
  quantityStep: string;
  priceStep: string;
  maxPriceDeviationRatio: string;
  takerFeeRate: string;
  makerFeeRate: string;
  /** listed | halted (delisted markets are not sent to the browser). */
  status?: string;
}

/** Asset metadata from config/markets.json (served by the trader-web BFF). */
export interface AssetDefinition {
  code: string;
  name: string;
  decimals: number;
  displayDecimals: number;
  networks: string[];
  withdrawalFee: string;
  faucet?: { maxAmount: string; presets: string[] };
}

export interface TraderWebRuntimeConfig {
  appTitle: string;
  gatewayWsUrl: string;
  marketDataWsUrl: string;
  gatewayHttpBasePath: string;
  marketDataHttpBasePath: string;
  demoHttpBasePath: string;
  markets: MarketDefinition[];
  defaultMarket: string;
  assets: AssetDefinition[];
  demo: {
    enabled: boolean;
    account?: { email: string; password: string };
  };
  tracingUiUrl?: string;
  privateWsPath?: string;
  opsConsoleUrl?: string;
}

export interface SessionInfo {
  sessionId?: string;
  userId: string;
  email?: string;
  displayName?: string;
  status?: string;
  userType?: string;
  roles?: string[];
  permissions?: string[];
  createdAt?: string;
  expiresAt?: string;
  lastSeenAt?: string;
}

export interface LoginResult extends SessionInfo {
  token: string;
}

/** Returned with a new session by identity-service (login security). */
export interface SessionDevice {
  deviceId: string;
  deviceLabel: string;
  isNewDevice: boolean;
}

export type ApiKeyScope = "read" | "trade" | "withdraw";

export interface ApiKeyRecord {
  apiKeyId: string;
  label?: string;
  /** Public id sent as X-API-Key; missing on legacy keys. */
  keyId?: string;
  keyPrefix?: string;
  scopes?: ApiKeyScope[];
  status?: string;
  createdAt?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  /** Only present in the create response. */
  secret?: string;
}

export interface MarketTicker {
  market: string;
  lastPrice?: string;
  openPrice24h?: string;
  priceChange24h?: string;
  highPrice24h?: string;
  lowPrice24h?: string;
  volume24h?: string;
  quoteVolume24h?: string;
  tradeCount24h?: number;
  updatedAt?: string;
}

export interface DepthLevel {
  price: string;
  quantity: string;
  orderCount?: number;
}

export interface DepthSnapshot {
  market?: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  updatedAt?: string;
}

export interface Kline {
  market: string;
  interval: string;
  openTime: string;
  closeTime: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  baseVolume: string;
  quoteVolume: string;
  tradeCount: number;
}

export interface BalanceRecord {
  accountId: string;
  accountType?: string;
  assetCode: string;
  available?: string;
  locked?: string;
  total?: string;
  updatedAt?: string;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market" | "stop_limit" | "stop_market";
/** Self-trade prevention mode (matching engine). */
export type StpMode = "expire_taker" | "expire_maker" | "expire_both";
export type TimeInForce = "gtc" | "ioc" | "fok";

export interface OrderRecord {
  orderId: string;
  accountId?: string;
  market?: string;
  side?: OrderSide;
  type?: OrderType;
  timeInForce?: TimeInForce;
  price?: string;
  quantity?: string;
  filledQuantity?: string;
  restingQuantity?: string;
  status?: string;
  rejectedReason?: string;
  lockAssetCode?: string;
  lockAmount?: string;
  createdAt?: string;
  updatedAt?: string;
  postOnly?: boolean;
  stpMode?: StpMode;
  /** Stop orders: waits in pending_trigger until the last price crosses it. */
  triggerPrice?: string;
  triggeredAt?: string;
}

export interface TradeRecord {
  tradeId: string;
  market?: string;
  price?: string;
  quantity?: string;
  makerOrderId?: string;
  takerOrderId?: string;
  buyerOrderId?: string;
  sellerOrderId?: string;
  buyerUserId?: string;
  sellerUserId?: string;
  sellerFeeRate?: string;
  buyerFeeRate?: string;
  /** Public trades from market-data carry the taker side. */
  side?: OrderSide;
  takerSide?: OrderSide;
  executedAt?: string;
  executionSequence?: number;
  settlementId?: string;
}

export interface DepositAddressRecord {
  walletAddressId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  address?: string;
  status?: string;
  createdAt?: string;
}

export interface DepositRecord {
  depositId: string;
  assetCode?: string;
  network?: string;
  address?: string;
  amount?: string;
  confirmations?: number;
  status?: string;
  txHash?: string;
  detectedAt?: string;
  creditedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  assetCode?: string;
  network?: string;
  toAddress?: string;
  amount?: string;
  fee?: string;
  status?: string;
  reviewStatus?: string;
  txHash?: string;
  requestedAt?: string;
  approvedAt?: string;
  broadcastedAt?: string;
  confirmedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** KYT level fixed at request time: low / medium / high / blocked. */
  riskLevel?: string;
}

export interface AddressBookEntry {
  addressBookId: string;
  network?: string;
  address: string;
  label?: string;
  isWhitelisted?: boolean;
  createdAt?: string;
}

/** M4-1: identity-service 2FA status (via GET /auth/two-factor). */
export interface TwoFactorStatus {
  enabled: boolean;
  pendingEnrollment: boolean;
  issuer?: string;
  label?: string;
  enabledAt?: string;
  changedAt?: string;
  recoveryCodesRemaining?: number;
  /** Only in the enable / regenerate response — shown once. */
  recoveryCodes?: string[];
}

export interface TwoFactorEnrollment {
  secret: string;
  otpauthUri: string;
  issuer?: string;
  label?: string;
}

export type KycTier = "unverified" | "L1" | "L2";

export interface KycRequest {
  requestId: string;
  requestedTier: "L1" | "L2";
  fullName?: string;
  idNumberMasked?: string;
  status: "pending" | "approved" | "rejected";
  approvedTier?: "L1" | "L2";
  reviewNote?: string;
  createdAt?: string;
  reviewedAt?: string;
}

/** M4-4: GET /auth/kyc */
export interface KycProfile {
  tier: KycTier;
  tierUpdatedAt?: string;
  pendingRequest?: KycRequest;
  latestRequest?: KycRequest;
}

export interface WithdrawalAssetLimit {
  assetCode: string;
  singleLimit?: string;
  dailyLimit?: string;
  tierSingleLimit?: string;
  tierDailyLimit?: string;
  usedToday: string;
  remainingToday?: string;
  dualApprovalThreshold?: string;
}

/** M4-4 / M5-2: GET /withdrawals/limits */
export interface WithdrawalLimits {
  kycTier?: KycTier;
  kycEnforced?: boolean;
  requireTwoFactor?: boolean;
  twoFactorEnabled?: boolean;
  requireWhitelist?: boolean;
  dayWindow?: { startAt: string; endAt: string };
  cooldown?: {
    active: boolean;
    cooldownSeconds: number;
    remainingSeconds: number;
    reason?: "withdrawal_address_added" | "two_factor_changed";
    until?: string;
  };
  assets: WithdrawalAssetLimit[];
}

export interface NotificationRecord {
  notificationId?: string;
  eventType?: string;
  /** Delivery status (pending / delivered / failed), not the read marker. */
  status?: string;
  withdrawalId?: string;
  depositId?: string;
  subject?: string;
  body?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  /** Customer read marker persisted by wallet-service; absent = unread. */
  readAt?: string;
}

export interface AccountEventRecord {
  entityType?: string;
  entityId?: string;
  eventKey?: string;
  eventType?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface FaucetReceipt {
  txHash: string;
  assetCode: string;
  amount: string;
  address: string;
  observationId: string;
  confirmations: number;
  requiredConfirmations: number;
  estimatedSeconds: number;
}

export interface FaucetStatus {
  observationId: string;
  txHash: string;
  assetCode: string;
  amount: string;
  status: string;
  confirmations: number;
  requiredConfirmations: number;
}

export interface SimulatorStatus {
  chain: {
    network: string;
    blockHeight: number;
    blockTimeMs: number;
    requiredConfirmations: number;
  };
  makers: {
    enabled: boolean;
    paused?: boolean;
    markets: Array<{ market: string; mid: string }>;
  };
  faucet: {
    limits: Record<string, number>;
  };
}

export type PrivateChannel =
  | "orders"
  | "trades"
  | "balances"
  | "notifications"
  | "deposits"
  | "withdrawals"
  | "account_events";

export interface PublicRealtimeMessage {
  type: "ready" | "snapshot" | "event" | "error";
  channel?: "ticker" | "depth" | "trades";
  market?: string;
  item?: MarketTicker | DepthSnapshot;
  items?: TradeRecord[];
  message?: string;
}

export interface PrivateRealtimeMessage {
  type: "authenticated" | "snapshot" | "event" | "error" | "resumed" | "resync_required";
  channel?: PrivateChannel;
  items?: unknown[];
  sequence?: number;
  message?: string;
}

/** identity-service login event (账户 → 登录记录). */
export interface LoginEventRecord {
  eventId: string;
  scope?: string;
  deviceId: string;
  deviceLabel?: string;
  ipAddress?: string;
  userAgent?: string;
  outcome: "success" | "failure" | "locked";
  failureCode?: string;
  isNewDevice?: boolean;
  createdAt: string;
}

/** identity-service device registry entry (账户 → 设备管理). */
export interface UserDeviceRecord {
  deviceId: string;
  deviceLabel?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIpAddress?: string;
  loginCount?: number;
  flaggedNew?: boolean;
  revokedAt?: string;
  activeSessionCount?: number;
}
