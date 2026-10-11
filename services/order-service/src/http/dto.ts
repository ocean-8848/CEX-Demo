import type { OrderStatus, OrderType, SpotMarket, TimeInForce } from "@web3-cex/domain";
import type {
  SpotOrderAutomationExecutionStatus,
  SpotOrderAutomationExecutionType,
  SpotOrderAutomationTrigger,
  SpotOrderRecoveryStatus
} from "../domain/types.js";

export interface CreateSpotOrderRequestDto {
  userId: string;
  accountId: string;
  market: SpotMarket;
  side: "buy" | "sell";
  type: OrderType;
  timeInForce?: TimeInForce;
  price?: string;
  quantity: string;
  idempotencyKey: string;
  traceId?: string;
}

export interface CancelSpotOrderRequestDto {
  userId: string;
}

export interface ListSpotOrdersQueryDto {
  userId?: string;
  accountId?: string;
  market?: SpotMarket;
  status?: OrderStatus;
  limit?: string;
  offset?: string;
}

export interface ListSpotTradesQueryDto {
  userId?: string;
  market?: SpotMarket;
  orderId?: string;
  executionBatchId?: string;
  executionSequenceFrom?: string;
  executionSequenceTo?: string;
  limit?: string;
  offset?: string;
}

export interface AcknowledgeTradeSettlementRequestDto {
  settlementId: string;
}

export interface OrderOpsQueryDto {
  market: SpotMarket;
}

export interface OrderRecoveryJobsQueryDto {
  orderId?: string;
  market?: SpotMarket;
  status?: SpotOrderRecoveryStatus;
  deadLettered?: string;
  limit?: string;
  offset?: string;
}

export interface ProcessRecoveryJobsRequestDto {
  limit?: string;
}

export interface RequeueDeadLetterJobsRequestDto {
  market?: SpotMarket;
  limit?: string;
}

export interface DeadLetterReportQueryDto {
  market?: SpotMarket;
  limit?: string;
  templateLimit?: string;
}

export interface DeadLetterBatchTemplateQueryDto {
  market?: SpotMarket;
  limit?: string;
}

export interface OrderAutomationExecutionsQueryDto {
  executionType?: SpotOrderAutomationExecutionType;
  status?: SpotOrderAutomationExecutionStatus;
  trigger?: SpotOrderAutomationTrigger;
  market?: SpotMarket;
  limit?: string;
  offset?: string;
}

export interface OrderEventStreamQueryDto {
  market?: SpotMarket;
  afterStreamEntryId?: string;
  fromStreamEntryId?: string;
  toStreamEntryId?: string;
  executionSequenceFrom?: string;
  limit?: string;
  overlapCount?: string;
  direction?: "forward" | "backward";
}

export interface ReplayOrderEventStreamRequestDto {
  market: SpotMarket;
  afterStreamEntryId?: string;
  fromStreamEntryId?: string;
  toStreamEntryId?: string;
  executionSequenceFrom?: number;
  limit?: number;
  overlapCount?: number;
  direction?: "forward" | "backward";
  publishToChannel?: boolean;
}

export interface TrimOrderEventStreamRequestDto {
  market?: SpotMarket;
  strategy?: "auto" | "maxlen" | "minid";
  maxLen?: number;
  retentionMs?: number;
  minStreamEntryId?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface MaintainOrderEventStreamRequestDto {
  market?: SpotMarket;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
}
