import type {
  ClaimSettlementRecoveryJobCommand,
  ClaimSettlementRecoveryJobsCommand,
  ListTradeEventConsumerCheckpointsQuery,
  ListSettlementAutomationExecutionsQuery,
  ListSettlementRecoveryJobsQuery,
  ListTradeSettlementsQuery,
  RenewSettlementRecoveryLeaseCommand,
  SettlementAutomationExecution,
  SettlementRecoveryMetrics,
  SettlementRecoveryJob,
  TradeSettlementSummaryRollup,
  TradeSettlement
} from "./types.js";
import type { TradeEventConsumerCheckpoint } from "@web3-cex/domain";

export interface SettlementRepository {
  withTransaction<T>(operation: (repository: SettlementRepository) => Promise<T>): Promise<T>;
  findSettlementByTradeId(tradeId: string): Promise<TradeSettlement | null>;
  saveSettlement(settlement: TradeSettlement): Promise<void>;
  listSettlements(query: ListTradeSettlementsQuery): Promise<TradeSettlement[]>;
  getSettlementSummaryRollups(
    query: Pick<ListTradeSettlementsQuery, "market" | "status" | "userId" | "orderId">
  ): Promise<TradeSettlementSummaryRollup[]>;
  saveRecoveryJob(job: SettlementRecoveryJob): Promise<void>;
  findRecoveryJobByTradeId(tradeId: string): Promise<SettlementRecoveryJob | null>;
  listRecoveryJobs(query: ListSettlementRecoveryJobsQuery): Promise<SettlementRecoveryJob[]>;
  claimRecoveryJobs(
    command: ClaimSettlementRecoveryJobsCommand
  ): Promise<SettlementRecoveryJob[]>;
  claimRecoveryJob(
    command: ClaimSettlementRecoveryJobCommand
  ): Promise<SettlementRecoveryJob | null>;
  renewRecoveryJobLease(
    command: RenewSettlementRecoveryLeaseCommand
  ): Promise<SettlementRecoveryJob | null>;
  getRecoveryMetrics(now: string): Promise<SettlementRecoveryMetrics>;
  saveAutomationExecution(execution: SettlementAutomationExecution): Promise<void>;
  listAutomationExecutions(
    query: ListSettlementAutomationExecutionsQuery
  ): Promise<SettlementAutomationExecution[]>;
  findTradeEventConsumerCheckpoint(
    consumerId: string,
    market: TradeEventConsumerCheckpoint["market"]
  ): Promise<TradeEventConsumerCheckpoint | null>;
  saveTradeEventConsumerCheckpoint(checkpoint: TradeEventConsumerCheckpoint): Promise<void>;
  listTradeEventConsumerCheckpoints(
    query: ListTradeEventConsumerCheckpointsQuery
  ): Promise<TradeEventConsumerCheckpoint[]>;
}
