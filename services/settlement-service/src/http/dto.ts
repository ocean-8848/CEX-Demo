import type { SpotMarket } from "@web3-cex/domain";
import type {
  SettlementAutomationExecutionStatus,
  SettlementAutomationExecutionType,
  SettlementAutomationTrigger,
  SettlementRecoveryStatus,
  TradeSettlement
} from "../domain/types.js";

export interface SettleTradeRequestDto {
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
  sellerFeeRate: string;
  buyerFeeRate?: string;
  sellerFeeTier?: string;
  buyerFeeTier?: string;
  traceId?: string;
}

export interface ListSettlementsQueryDto {
  userId?: string;
  market?: SpotMarket;
  orderId?: string;
  status?: TradeSettlement["status"];
  limit?: string;
  offset?: string;
}

export interface SettlementRecoveryJobsQueryDto {
  tradeId?: string;
  market?: SpotMarket;
  status?: SettlementRecoveryStatus;
  limit?: string;
  offset?: string;
}

export interface ProcessSettlementRecoveryJobsRequestDto {
  limit?: string;
}

export interface SettlementAutomationExecutionsQueryDto {
  executionType?: SettlementAutomationExecutionType;
  status?: SettlementAutomationExecutionStatus;
  trigger?: SettlementAutomationTrigger;
  market?: SpotMarket;
  limit?: string;
  offset?: string;
}

export interface TradeEventBusCheckpointsQueryDto {
  consumerId?: string;
  market?: SpotMarket;
  limit?: string;
  offset?: string;
}

export interface ConsumeTradeExecutionEventRequestDto {
  consumerId: string;
  event: Record<string, unknown>;
  allowGap?: boolean;
}

export interface ReplayTradeExecutionEventsRequestDto {
  consumerId: string;
  events: Record<string, unknown>[];
  allowGap?: boolean;
}

export interface ProcessTradeEventSubscriptionRequestDto {
  market?: SpotMarket;
  allowGap?: boolean;
  afterStreamEntryId?: string;
  limit?: string;
  overlapCount?: string;
}

export interface PauseSettlementConsumerRequestDto {
  durationSeconds?: number | string;
  reason?: string;
  requestedBy?: string;
}
