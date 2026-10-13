import type {
  OrderSide,
  OrderStatus,
  OrderType,
  SpotMarket,
  StpMode,
  TimeInForce
} from "@web3-cex/domain";

export interface CreateSpotOrderCommand {
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
  /** Maker-only limit order (rejected instead of taking liquidity). */
  postOnly?: boolean;
  /** Self-trade prevention mode; the engine defaults to expire_taker. */
  stpMode?: StpMode;
  /** Required for stop_limit / stop_market. */
  triggerPrice?: string;
}

export interface CancelSpotOrderCommand {
  orderId: string;
  userId: string;
}

export interface SpotOrderRecord {
  orderId: string;
  idempotencyKey: string;
  traceId: string;
  /** OpenTelemetry trace of the create request (Jaeger link); absent when tracing is off. */
  otelTraceId?: string;
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
  /** Stop orders: last-price trigger; the order waits in pending_trigger. */
  triggerPrice?: string;
  /** When a stop order was handed to the matching engine. */
  triggeredAt?: string;
}

export type SpotOrderRecoveryStage = "persist_matched_outcome";
export type SpotOrderRecoveryStatus = "pending" | "processing" | "completed" | "failed";

export interface SpotOrderRecoveryJob {
  jobId: string;
  orderId: string;
  market: SpotMarket;
  stage: SpotOrderRecoveryStage;
  status: SpotOrderRecoveryStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError?: string;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastClaimedAt?: string;
  leaseHeartbeatAt?: string;
  deadLetteredAt?: string;
  lastDurationMs?: number;
  lastResult?: "completed" | "failed" | "dead_lettered";
}

export interface SpotTradeRecord {
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
  sellerFeeRate: string;
  buyerFeeRate: string;
  executionId: string;
  executionBatchId: string;
  executionSequence: number;
  executionBatchSequence: number;
  replayCursor: string;
  protocolVersion: string;
  settlementId: string;
  executedAt: string;
  settlementUpdatedAt?: string;
}

export interface UpdateSpotTradeSettlementCommand {
  tradeId: string;
  settlementId: string;
  settlementUpdatedAt: string;
}

export interface ListSpotOrdersQuery {
  userId?: string;
  accountId?: string;
  market?: SpotMarket;
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export interface ListSpotTradesQuery {
  userId?: string;
  market?: SpotMarket;
  orderId?: string;
  executionBatchId?: string;
  executionSequenceFrom?: number;
  executionSequenceTo?: number;
  limit?: number;
  offset?: number;
}

export interface ListSpotOrderRecoveryJobsQuery {
  orderId?: string;
  market?: SpotMarket;
  status?: SpotOrderRecoveryStatus;
  deadLettered?: boolean;
  limit?: number;
  offset?: number;
}

export interface ClaimSpotOrderRecoveryJobsCommand {
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  limit: number;
}

export interface ClaimSpotOrderRecoveryJobCommand {
  jobId: string;
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  allowedStatuses: SpotOrderRecoveryStatus[];
}

export interface RenewSpotOrderRecoveryLeaseCommand {
  jobId: string;
  workerId: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface SpotOrderRecoveryMetrics {
  generatedAt: string;
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  deadLetteredJobs: number;
  leasedJobs: number;
  expiredLeaseJobs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  lastCompletedAt?: string;
  lastFailedAt?: string;
}

export interface SpotOrderRecoveryLeaseWorkerSummary {
  workerId: string;
  leasedJobs: number;
  expiredJobs: number;
  markets: SpotMarket[];
  lastHeartbeatAt?: string;
  nextLeaseExpiryAt?: string;
}

export interface SpotOrderRecoveryGovernanceReport {
  generatedAt: string;
  metrics: SpotOrderRecoveryMetrics;
  activeWorkers: SpotOrderRecoveryLeaseWorkerSummary[];
  expiredLeases: Array<{
    jobId: string;
    orderId: string;
    market: SpotMarket;
    leaseOwner?: string;
    leaseHeartbeatAt?: string;
    leaseExpiresAt?: string;
    attemptCount: number;
    lastError?: string;
  }>;
  orphanedLeases: Array<{
    jobId: string;
    orderId: string;
    market: SpotMarket;
    leaseOwner?: string;
    leaseHeartbeatAt?: string;
    leaseExpiresAt?: string;
    attemptCount: number;
    lastError?: string;
  }>;
  deadLetterBacklog: {
    totalJobs: number;
    oldestDeadLetteredAt?: string;
    byMarket: Array<{
      market: SpotMarket;
      jobCount: number;
    }>;
  };
}

export interface SpotOrderRecoveryDeadLetterBatchTemplate {
  templateId: string;
  description: string;
  endpoint: string;
  method: "POST";
  payload: Record<string, unknown>;
}

export interface SpotOrderRecoveryDeadLetterReport {
  generatedAt: string;
  totalJobs: number;
  entries: Array<{
    market: SpotMarket;
    stage: SpotOrderRecoveryStage;
    errorKey: string;
    jobCount: number;
    maxAttemptCount: number;
    oldestDeadLetteredAt?: string;
    mostRecentDeadLetteredAt?: string;
    sampleJobIds: string[];
  }>;
  templates: SpotOrderRecoveryDeadLetterBatchTemplate[];
}

export interface MatchingSubmitResult {
  outcome: "resting" | "matched" | "cancelled";
  orderId: string;
  takerStatus?: "resting" | "filled" | "cancelled";
  takerRemainingQuantity?: string;
  reason?: string;
  protocolVersion?: string;
  trades: Array<{
    makerOrderId: string;
    takerOrderId: string;
    price: string;
    quantity: string;
    executedAt: string;
    executionId: string;
    executionBatchId: string;
    executionSequence: number;
    executionBatchSequence: number;
    replayCursor: string;
    protocolVersion: string;
    makerCreatedAt?: string;
    takerCreatedAt?: string;
    makerRemainingQuantity: string;
  }>;
  /** Own resting orders removed by self-trade prevention (expire_maker / expire_both). */
  expiredMakers?: Array<{
    orderId: string;
    quantity: string;
    reason: string;
  }>;
}

export interface MatchingBookSnapshotOrder {
  orderId: string;
  /** Owner account id (absent for orders seeded without one). */
  ownerId?: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  createdAt: string;
}

export interface MatchingBookSnapshot {
  market: SpotMarket;
  bids: MatchingBookSnapshotOrder[];
  asks: MatchingBookSnapshotOrder[];
  /** Next sequence numbers the engine will assign (absent on older engines). */
  nextExecutionSequence?: number;
  nextBatchSequence?: number;
}

/** Highest execution / batch sequence already persisted for a market. */
export interface MarketExecutionCursor {
  executionSequence: number;
  batchSequence: number;
}

export type SpotOrderAutomationExecutionType =
  | "recovery_cycle"
  | "compensation_replay"
  | "manual_engine_replay"
  | "event_stream_maintenance_cycle";
export type SpotOrderAutomationExecutionStatus = "succeeded" | "failed" | "partial";
export type SpotOrderAutomationTrigger = "automatic" | "manual" | "template";

export interface SpotOrderAutomationExecution {
  executionId: string;
  executionType: SpotOrderAutomationExecutionType;
  status: SpotOrderAutomationExecutionStatus;
  trigger: SpotOrderAutomationTrigger;
  market?: SpotMarket;
  workerId?: string;
  targetId?: string;
  summary: Record<string, unknown>;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ListSpotOrderAutomationExecutionsQuery {
  executionType?: SpotOrderAutomationExecutionType;
  status?: SpotOrderAutomationExecutionStatus;
  trigger?: SpotOrderAutomationTrigger;
  market?: SpotMarket;
  limit?: number;
  offset?: number;
}
