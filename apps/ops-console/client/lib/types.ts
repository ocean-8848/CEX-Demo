// Shapes returned by the ops-console BFF. Fields are optional unless the UI
// cannot work without them; the BFF aggregates many services.

export interface OpsSession {
  sessionId?: string;
  userId: string;
  email?: string;
  displayName?: string;
  roles?: string[];
  permissions?: string[];
  expiresAt?: string;
}

export interface OpsLoginResult extends OpsSession {
  token: string;
}

export interface UserRecord {
  userId: string;
  email?: string;
  displayName?: string;
  status?: string;
  userType?: string;
  roles?: string[];
  twoFactorEnabled?: boolean;
  /** M4-4: unverified / L1 / L2 */
  kycTier?: string;
  kycTierUpdatedAt?: string;
  createdAt?: string;
}

export interface KycRequestRecord {
  requestId: string;
  userId: string;
  requestedTier: string;
  fullName?: string;
  idNumberMasked?: string;
  status: "pending" | "approved" | "rejected";
  approvedTier?: string;
  reviewedBy?: string;
  reviewNote?: string;
  createdAt?: string;
  reviewedAt?: string;
  email?: string;
  displayName?: string;
  currentTier?: string;
}

export interface KycEventRecord {
  eventId: string;
  fromTier: string;
  toTier: string;
  action: "request_approved" | "request_rejected" | "tier_adjusted";
  actorId?: string;
  reason?: string;
  createdAt?: string;
}

export interface KycProfile {
  userId: string;
  tier: string;
  tierUpdatedAt?: string;
  pendingRequest?: KycRequestRecord;
  latestRequest?: KycRequestRecord;
  events?: KycEventRecord[];
}

export interface BalanceRecord {
  accountId: string;
  userId?: string;
  accountType?: string;
  accountStatus?: string;
  assetCode: string;
  available?: string;
  locked?: string;
  total?: string;
  updatedAt?: string;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  toAddress?: string;
  amount?: string;
  fee?: string;
  frozenAmount?: string;
  status?: string;
  reviewStatus?: string;
  txHash?: string;
  requestedAt?: string;
  approvedAt?: string;
  broadcastedAt?: string;
  confirmedAt?: string;
  /** KYT score / level / reasons stored at request time. */
  riskScore?: number;
  riskLevel?: string;
  riskReasons?: Array<{ code: string; score: number; message: string }>;
  metadata?: Record<string, unknown>;
}

export interface WithdrawalAuditLog {
  auditLogId: string;
  withdrawalId?: string;
  operatorId?: string;
  operatorRole?: string;
  action?: string;
  reason?: string;
  note?: string;
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  createdAt?: string;
}

export interface DepositRecord {
  depositId: string;
  userId?: string;
  assetCode?: string;
  network?: string;
  address?: string;
  txHash?: string;
  amount?: string;
  confirmations?: number;
  status?: string;
  detectedAt?: string;
  creditedAt?: string;
}

export interface DepositObservation {
  observationId: string;
  network?: string;
  assetCode?: string;
  address?: string;
  txHash?: string;
  amount?: string;
  confirmations?: number;
  blockNumber?: number;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrderRecord {
  orderId: string;
  userId?: string;
  accountId?: string;
  market?: string;
  side?: string;
  type?: string;
  timeInForce?: string;
  price?: string;
  quantity?: string;
  filledQuantity?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  rejectedReason?: string;
  postOnly?: boolean;
  stpMode?: string;
  triggerPrice?: string;
  triggeredAt?: string;
}

export interface TradeRecord {
  tradeId: string;
  market?: string;
  price?: string;
  quantity?: string;
  buyerUserId?: string;
  sellerUserId?: string;
  buyerOrderId?: string;
  sellerOrderId?: string;
  settlementId?: string;
  executedAt?: string;
}

export interface SettlementRecord {
  settlementId: string;
  tradeId: string;
  market?: string;
  price?: string;
  quantity?: string;
  quoteAmount?: string;
  /** Seller fee in quote. */
  feeAmount?: string;
  /** Buyer fee in base. */
  buyerFeeAmount?: string;
  status?: string;
  attemptCount?: number;
  lastError?: string;
  createdAt?: string;
  settledAt?: string;
}

export interface NotificationRecord {
  notificationId: string;
  userId?: string;
  withdrawalId?: string;
  eventType?: string;
  status?: string;
  subject?: string;
  body?: string;
  createdAt?: string;
}

export interface ActionAuditLog {
  auditLogId: string;
  operatorEmail?: string;
  operatorUserId?: string;
  permission?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  batchId?: string;
  status?: string;
  errorMessage?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface AlertSource {
  source: string;
  status: string;
  alerts: string[];
  summary?: Record<string, unknown>;
}

export interface AlertsReport {
  generatedAt?: string;
  status: string;
  alertCount: number;
  sources: AlertSource[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface DashboardReport {
  generatedAt?: string;
  withdrawalReviewQueue?: Paged<WithdrawalRecord>;
  pendingNotifications?: Paged<NotificationRecord>;
  custody?: Record<string, unknown>;
}

export interface SettlementReport {
  generatedAt?: string;
  totals?: {
    settlementCount?: number;
    settledCount?: number;
    pendingRecoveryCount?: number;
    failedCount?: number;
    quantity?: string;
    quoteAmount?: string;
    feeAmount?: string;
  };
  markets?: Array<{
    market: string;
    settlementCount?: number;
    settledCount?: number;
    pendingRecoveryCount?: number;
    failedCount?: number;
    quantity?: string;
    quoteAmount?: string;
    feeAmount?: string;
    baseFeeAmount?: string;
  }>;
}

export interface LedgerOverview {
  status?: string;
  alerts?: string[];
  outbox?: { pendingCount?: number; retryingCount?: number; deadLetteredCount?: number; oldestPendingAgeSeconds?: number };
  locks?: { activeCount?: number; staleCount?: number; oldestActiveAgeSeconds?: number; staleThresholdMinutes?: number };
  reconciliation?: { scannedCount?: number; mismatchCount?: number; negativeAvailableCount?: number; negativeLockedCount?: number };
}

export interface ReconciliationItem {
  accountId: string;
  assetCode: string;
  accountType?: string;
  entryCount?: number;
  lockCount?: number;
  journalNet?: string;
  activeLocked?: string;
  expectedAvailable?: string;
  expectedLocked?: string;
  snapshotAvailable?: string;
  snapshotLocked?: string;
  snapshotTotal?: string;
  expectedTotal?: string;
  status?: string;
  matched?: boolean;
}

export interface ReconciliationReport {
  generatedAt?: string;
  scannedCount?: number;
  matchedCount?: number;
  mismatchCount?: number;
  items?: ReconciliationItem[];
}

export interface ModuleDescriptor {
  moduleId: string;
  title: string;
  domain?: string;
  summary?: string;
}

export interface TraceStep {
  moduleId: string;
  title: string;
  lines: string[];
}

export interface BusinessTrace {
  generatedAt?: string;
  query?: Record<string, unknown>;
  root?: { kind?: string; id?: string; label?: string; explanation?: string };
  inferred?: Record<string, string>;
  entities?: Record<string, unknown>;
  related?: Record<string, unknown>;
  steps?: TraceStep[];
  /** Jaeger UI base URL; set when the stack runs with tracing on. */
  tracingUiUrl?: string;
}

export interface CustodyRoute {
  providerName: string;
  network: string;
  priority?: number;
  healthStatus?: string;
  circuitState?: string;
  consecutiveFailures?: number;
  broadcastSuccessCount?: number;
  broadcastFailureCount?: number;
  lastHealthCheckedAt?: string;
}

export interface RecoveryJob {
  jobId: string;
  orderId?: string;
  tradeId?: string;
  market?: string;
  stage?: string;
  status?: string;
  attemptCount?: number;
  lastError?: string;
  nextAttemptAt?: string;
  updatedAt?: string;
}

export interface ExecutionTemplate {
  templateId: string;
  name: string;
  description?: string;
  permission?: string;
  action?: string;
  defaults?: Record<string, unknown>;
}

export interface ExecutionSchedule {
  scheduleId: string;
  templateId: string;
  templateName?: string;
  market?: string;
  intervalMinutes?: number;
  dueAt?: string;
  lastRunAt?: string;
  status?: string;
}

/** `/market-config`: markets + assets from config/markets.json. */
export interface MarketConfig {
  defaultMarket: string;
  markets: Array<{ market: string; baseAsset: string; quoteAsset: string; configuredStatus: string }>;
  assets: Array<{ code: string; name: string; decimals: number; networks: string[] }>;
}

export interface MarketStatusOverride {
  market: string;
  status: string;
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface ManagedMarket {
  market: string;
  baseAsset: string;
  quoteAsset: string;
  configuredStatus: string;
  status: string;
  override: MarketStatusOverride | null;
  priceStep: string;
  quantityStep: string;
  minQuantity: string;
  makerFeeRate: string;
  takerFeeRate: string;
  maxPriceDeviationRatio: string;
  referencePrice: string;
  simulatorEnabled: boolean;
}

/** `/markets`: 市场管理 view (effective status from risk-service). */
export interface MarketsReport {
  generatedAt: string;
  defaultMarket: string;
  statusSource: "risk-service" | "config";
  statusError: string | null;
  markets: ManagedMarket[];
}
