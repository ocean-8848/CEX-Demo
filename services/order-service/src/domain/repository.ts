import type { SpotMarket } from "@web3-cex/domain";

import type {
  ClaimSpotOrderRecoveryJobCommand,
  MarketExecutionCursor,
  ClaimSpotOrderRecoveryJobsCommand,
  ListSpotOrderAutomationExecutionsQuery,
  ListSpotOrderRecoveryJobsQuery,
  ListSpotOrdersQuery,
  ListSpotTradesQuery,
  RenewSpotOrderRecoveryLeaseCommand,
  SpotOrderAutomationExecution,
  SpotOrderRecord,
  SpotOrderRecoveryMetrics,
  SpotOrderRecoveryJob,
  SpotTradeRecord,
  UpdateSpotTradeSettlementCommand
} from "./types.js";

export interface OrderRepository {
  withTransaction<T>(operation: (repository: OrderRepository) => Promise<T>): Promise<T>;
  findOrderById(orderId: string): Promise<SpotOrderRecord | null>;
  findOrderByIdempotencyKey(idempotencyKey: string): Promise<SpotOrderRecord | null>;
  saveOrder(order: SpotOrderRecord): Promise<void>;
  listOrders(query: ListSpotOrdersQuery): Promise<SpotOrderRecord[]>;
  saveTrade(trade: SpotTradeRecord): Promise<void>;
  findTradeById(tradeId: string): Promise<SpotTradeRecord | null>;
  listTrades(query: ListSpotTradesQuery): Promise<SpotTradeRecord[]>;
  getExecutionCursor(market: SpotMarket): Promise<MarketExecutionCursor>;
  updateTradeSettlement(command: UpdateSpotTradeSettlementCommand): Promise<SpotTradeRecord | null>;
  saveRecoveryJob(job: SpotOrderRecoveryJob): Promise<void>;
  findRecoveryJobById(jobId: string): Promise<SpotOrderRecoveryJob | null>;
  listRecoveryJobs(query: ListSpotOrderRecoveryJobsQuery): Promise<SpotOrderRecoveryJob[]>;
  claimRecoveryJobs(command: ClaimSpotOrderRecoveryJobsCommand): Promise<SpotOrderRecoveryJob[]>;
  claimRecoveryJob(command: ClaimSpotOrderRecoveryJobCommand): Promise<SpotOrderRecoveryJob | null>;
  renewRecoveryJobLease(
    command: RenewSpotOrderRecoveryLeaseCommand
  ): Promise<SpotOrderRecoveryJob | null>;
  getRecoveryMetrics(now: string): Promise<SpotOrderRecoveryMetrics>;
  saveAutomationExecution(execution: SpotOrderAutomationExecution): Promise<void>;
  listAutomationExecutions(
    query: ListSpotOrderAutomationExecutionsQuery
  ): Promise<SpotOrderAutomationExecution[]>;
}
