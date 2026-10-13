import type {
  SpotMarket,
  TradeEventConsumerCheckpoint,
  TradeEventVersionGate,
  TradeExecutedEventSchema,
  TradingEvent
} from "@web3-cex/domain";
import type { SettlementTradeEventStreamHead } from "./order-event-client.js";

export interface SettleTradeCommand {
  tradeId: string;
  market: SpotMarket;
  price: string;
  quantity: string;
  buyerOrderId: string;
  sellerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  /** Fee rate charged to the seller, in the quote asset it receives. */
  sellerFeeRate: string;
  /** Fee rate charged to the buyer, in the base asset it receives (absent on old events). */
  buyerFeeRate?: string;
  /** VIP tier the seller rate came from (order-service, A7). */
  sellerFeeTier?: string;
  /** VIP tier the buyer rate came from (order-service, A7). */
  buyerFeeTier?: string;
  executionId?: string;
  executionBatchId?: string;
  executionSequence?: number;
  executionBatchSequence?: number;
  replayCursor?: string;
  protocolVersion?: string;
  traceId?: string;
}

export interface TradeSettlement {
  settlementId: string;
  tradeId: string;
  market: SpotMarket;
  price: string;
  quantity: string;
  quoteAmount: string;
  /** Seller fee, in the quote asset. */
  feeAmount: string;
  /** Buyer fee, in the base asset. */
  buyerFeeAmount: string;
  /** Rate the seller fee was computed with (absent on rows before fee tiers). */
  sellerFeeRate?: string;
  /** Rate the buyer fee was computed with (absent on rows before fee tiers). */
  buyerFeeRate?: string;
  sellerFeeTier?: string;
  buyerFeeTier?: string;
  buyerOrderId: string;
  sellerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  executionId?: string;
  executionBatchId?: string;
  executionSequence?: number;
  executionBatchSequence?: number;
  replayCursor?: string;
  protocolVersion?: string;
  buyerSettlementJournalId?: string;
  sellerSettlementJournalId?: string;
  status: "pending_recovery" | "settled" | "failed";
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  settledAt?: string;
}

export interface ListTradeSettlementsQuery {
  userId?: string;
  market?: SpotMarket;
  orderId?: string;
  status?: TradeSettlement["status"];
  limit?: number;
  offset?: number;
}

export interface TradeSettlementSummaryRow {
  market: SpotMarket;
  settlementCount: number;
  settledCount: number;
  pendingRecoveryCount: number;
  failedCount: number;
  quantity: string;
  quoteAmount: string;
  feeAmount: string;
  /** Buyer fees in this market's base asset. */
  baseFeeAmount: string;
}

export interface TradeSettlementReport {
  generatedAt: string;
  filter: ListTradeSettlementsQuery;
  source: "materialized_summary" | "raw_settlements";
  summaryUpdatedAt?: string;
  totals: {
    settlementCount: number;
    settledCount: number;
    pendingRecoveryCount: number;
    failedCount: number;
    quantity: string;
    quoteAmount: string;
    feeAmount: string;
  };
  markets: TradeSettlementSummaryRow[];
}

export interface TradeSettlementSummaryRollup {
  scopeType:
    | "global"
    | "market"
    | "user"
    | "user_market"
    | "order"
    | "order_market";
  scopeKey: string;
  market?: SpotMarket;
  status: TradeSettlement["status"];
  settlementCount: number;
  quantity: string;
  quoteAmount: string;
  feeAmount: string;
  baseFeeAmount: string;
  updatedAt: string;
}

export type SettlementRecoveryStage = "settle_trade";
export type SettlementRecoveryStatus = "pending" | "processing" | "completed" | "failed";

export interface SettlementRecoveryJob {
  jobId: string;
  tradeId: string;
  market: SpotMarket;
  stage: SettlementRecoveryStage;
  status: SettlementRecoveryStatus;
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
  lastDurationMs?: number;
  lastResult?: "completed" | "failed";
}

export interface ListSettlementRecoveryJobsQuery {
  tradeId?: string;
  market?: SpotMarket;
  status?: SettlementRecoveryStatus;
  limit?: number;
  offset?: number;
}

export interface ClaimSettlementRecoveryJobsCommand {
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  limit: number;
}

export interface ClaimSettlementRecoveryJobCommand {
  tradeId: string;
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  allowedStatuses: SettlementRecoveryStatus[];
}

export interface RenewSettlementRecoveryLeaseCommand {
  tradeId: string;
  workerId: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface SettlementRecoveryMetrics {
  generatedAt: string;
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  leasedJobs: number;
  expiredLeaseJobs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  lastCompletedAt?: string;
  lastFailedAt?: string;
}

export interface SettlementRecoveryLeaseWorkerSummary {
  workerId: string;
  leasedJobs: number;
  expiredJobs: number;
  markets: SpotMarket[];
  lastHeartbeatAt?: string;
  nextLeaseExpiryAt?: string;
}

export interface SettlementRecoveryGovernanceReport {
  generatedAt: string;
  metrics: SettlementRecoveryMetrics;
  activeWorkers: SettlementRecoveryLeaseWorkerSummary[];
  expiredLeases: Array<{
    jobId: string;
    tradeId: string;
    market: SpotMarket;
    leaseOwner?: string;
    leaseHeartbeatAt?: string;
    leaseExpiresAt?: string;
    attemptCount: number;
    lastError?: string;
  }>;
  orphanedLeases: Array<{
    jobId: string;
    tradeId: string;
    market: SpotMarket;
    leaseOwner?: string;
    leaseHeartbeatAt?: string;
    leaseExpiresAt?: string;
    attemptCount: number;
    lastError?: string;
  }>;
}

export type SettlementAutomationExecutionType =
  | "recovery_cycle"
  | "manual_replay"
  | "event_subscription_cycle";
export type SettlementAutomationExecutionStatus = "succeeded" | "failed" | "partial";
export type SettlementAutomationTrigger = "automatic" | "manual" | "template";

export interface SettlementAutomationExecution {
  executionId: string;
  executionType: SettlementAutomationExecutionType;
  status: SettlementAutomationExecutionStatus;
  trigger: SettlementAutomationTrigger;
  market?: SpotMarket;
  workerId?: string;
  targetId?: string;
  summary: Record<string, unknown>;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ListSettlementAutomationExecutionsQuery {
  executionType?: SettlementAutomationExecutionType;
  status?: SettlementAutomationExecutionStatus;
  trigger?: SettlementAutomationTrigger;
  market?: SpotMarket;
  limit?: number;
  offset?: number;
}

export interface ListTradeEventConsumerCheckpointsQuery {
  consumerId?: string;
  market?: SpotMarket;
  limit?: number;
  offset?: number;
}

export interface ConsumeTradeExecutionEventCommand {
  consumerId: string;
  event: TradingEvent;
  allowGap?: boolean;
  streamEntryId?: string;
  streamPublishedAt?: string;
}

export interface ConsumeTradeExecutionEventResult {
  consumerId: string;
  market: SpotMarket;
  tradeId: string;
  settlementId?: string;
  executionSequence: number;
  replayCursor: string;
  protocolVersion: string;
  streamEntryId?: string;
  /**
   * - applied: settled now
   * - duplicate: already seen (at or before the checkpoint)
   * - deferred: settlement failed and was handed to a recovery job; the
   *   checkpoint still advances so one bad trade cannot block the market.
   */
  action: "applied" | "duplicate" | "deferred";
  error?: string;
  checkpoint: TradeEventConsumerCheckpoint;
}

export interface ReplayTradeExecutionEventsCommand {
  consumerId: string;
  events: TradingEvent[];
  allowGap?: boolean;
}

export interface ReplayTradeExecutionEventsResult {
  consumerId: string;
  processedCount: number;
  appliedCount: number;
  duplicateCount: number;
  lastCheckpoint?: TradeEventConsumerCheckpoint;
  results: ConsumeTradeExecutionEventResult[];
}

export interface SettlementEventSubscriberReport {
  enabled: boolean;
  mode: "redis_stream" | "disabled";
  consumerId: string;
  batchSize: number;
  overlapCount: number;
  pollIntervalMs: number;
  markets: SpotMarket[];
  latestCycle?: SettlementAutomationExecution;
  /** Fault-lab pause switch state (absent when the subscriber has none). */
  pause?: SettlementConsumerPauseState;
}

/** Fault-lab pause switch for the trade event consumer. */
export interface SettlementConsumerPauseState {
  enabled: boolean;
  paused: boolean;
  pausedAt?: string;
  expiresAt?: string;
  reason?: string;
  requestedBy?: string;
  skippedCycleCount: number;
  lastResumedAt?: string;
  lastResumeTrigger?: "manual" | "expired";
  maxDurationMs: number;
  defaultDurationMs: number;
}

export interface TradeSettlementEventBusReport {
  generatedAt: string;
  versionGate: TradeEventVersionGate;
  schemas: TradeExecutedEventSchema[];
  checkpoints: TradeEventConsumerCheckpoint[];
  streamHeads?: SettlementTradeEventStreamHead[];
  checkpointLag?: Array<
    TradeEventConsumerCheckpoint & {
      latestExecutionSequence?: number;
      executionSequenceLag?: number;
      latestReplayCursor?: string;
      streamUpToDate?: boolean;
    }
  >;
  subscriber?: SettlementEventSubscriberReport;
}
