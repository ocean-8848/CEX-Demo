import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { FaultLabApplicationService } from "../application/fault-lab-application-service.js";
import { OpsControlsApplicationService } from "../application/ops-controls-application-service.js";
import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import type { OpsActionAuditLogQuery } from "../domain/action-audit.js";
import type {
  OpsApproveWithdrawalCommand,
  OpsBalanceQuery,
  OpsBatchApproveWithdrawalsCommand,
  OpsBusinessTraceQuery,
  OpsBatchClosePendingDepositsCommand,
  OpsBatchRejectWithdrawalsCommand,
  OpsBatchReplayPendingDepositsCommand,
  OpsClosePendingDepositCommand,
  OpsDepositQuery,
  OpsExecutionHistoryDiffQuery,
  OpsExecutionScheduleQuery,
  OpsFreezeUserCommand,
  OpsKycRequestQuery,
  OpsReviewKycRequestCommand,
  OpsSetKycTierCommand,
  OpsIndexerBacklogRepairCommand,
  OpsIndexerPendingDepositQuery,
  OpsIndexerReplayCommand,
  OpsLedgerDrainOutboxCommand,
  OpsLedgerReconciliationQuery,
  OpsLedgerReplayQuery,
  OpsLoginCommand,
  OpsNotificationQuery,
  OpsProcessRecoveryJobsCommand,
  OpsRunExecutionSchedulesCommand,
  OpsSpotOrderQuery,
  OpsSpotRecoveryJobQuery,
  OpsSpotTradeQuery,
  OpsTradeRuntimeReportQuery,
  OpsTradeRuntimeDrilldownQuery,
  OpsTradeRuntimeAlertDeliveryCommand,
  OpsTradeOpsQuery,
  OpsTradeSettlementQuery,
  OpsTradeSettlementRecoveryJobQuery,
  OpsRejectWithdrawalCommand,
  OpsReplayPendingDepositCommand,
  OpsReviewQueueQuery,
  OpsSessionInfo,
  OpsSetMarketStatusCommand,
  OpsUserQuery,
  OpsWalletNotificationDeliveryCommand,
  OpsWalletStaleWithdrawalRepairCommand,
  OpsWithdrawalAddressBookQuery,
  OpsWithdrawalAuditLogQuery,
  OpsWithdrawalQuery
} from "../domain/clients.js";
import { HttpAlertSinkClient } from "../infrastructure/http-alert-sink-client.js";
import { HttpControlSwitchClient, HttpReconciliationClient } from "../infrastructure/http-controls-clients.js";
import { HttpCustodyOpsClient } from "../infrastructure/http-custody-ops-client.js";
import { HttpFaultLabClient } from "../infrastructure/http-fault-lab-client.js";
import { HttpIdentityOpsClient } from "../infrastructure/http-identity-ops-client.js";
import { HttpIndexerOpsClient } from "../infrastructure/http-indexer-ops-client.js";
import { HttpLedgerOpsClient } from "../infrastructure/http-ledger-ops-client.js";
import { HttpOrderOpsClient } from "../infrastructure/http-order-ops-client.js";
import { HttpRiskMarketClient } from "../infrastructure/http-risk-market-client.js";
import { HttpSettlementOpsClient } from "../infrastructure/http-settlement-ops-client.js";
import { HttpWalletOpsClient } from "../infrastructure/http-wallet-ops-client.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";
import { PostgresOpsActionAuditRepository } from "../infrastructure/postgres-ops-action-audit-repository.js";
import { createOpsConsolePool } from "../infrastructure/postgres.js";

@Injectable()
export class OpsConsoleHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly applicationService: OpsConsoleApplicationService;
  readonly faultLab: FaultLabApplicationService;
  readonly controls: OpsControlsApplicationService;
  private readonly pool?: Pool;
  private schedulerTimer?: NodeJS.Timeout;

  constructor() {
    const walletBaseUrl = process.env.OPS_WALLET_SERVICE_URL ?? "http://127.0.0.1:3002";
    const custodyBaseUrl = process.env.OPS_CUSTODY_SERVICE_URL ?? "http://127.0.0.1:3004";
    const identityBaseUrl = process.env.OPS_IDENTITY_SERVICE_URL ?? "http://127.0.0.1:3005";
    const ledgerBaseUrl = process.env.OPS_LEDGER_SERVICE_URL ?? "http://127.0.0.1:3001";
    const indexerBaseUrl = process.env.OPS_INDEXER_SERVICE_URL ?? "http://127.0.0.1:3003";
    const orderBaseUrl = process.env.OPS_ORDER_SERVICE_URL ?? "http://127.0.0.1:3009";
    const settlementBaseUrl =
      process.env.OPS_SETTLEMENT_SERVICE_URL ?? "http://127.0.0.1:3010";
    const simulatorBaseUrl =
      process.env.OPS_DEMO_SIMULATOR_URL ?? "http://127.0.0.1:3014";
    const auditStoreMode = process.env.OPS_CONSOLE_AUDIT_STORE ?? "postgres";

    const auditRepository =
      auditStoreMode === "memory"
        ? new InMemoryOpsActionAuditRepository()
        : (() => {
            this.pool = createOpsConsolePool();
            return new PostgresOpsActionAuditRepository(this.pool, this.pool);
          })();

    const orderClient = new HttpOrderOpsClient(orderBaseUrl);
    this.applicationService = new OpsConsoleApplicationService(
      new HttpWalletOpsClient(walletBaseUrl),
      new HttpCustodyOpsClient(custodyBaseUrl),
      new HttpIdentityOpsClient(identityBaseUrl),
      new HttpLedgerOpsClient(ledgerBaseUrl),
      new HttpIndexerOpsClient(indexerBaseUrl),
      orderClient,
      new HttpSettlementOpsClient(settlementBaseUrl),
      auditRepository,
      HttpAlertSinkClient.fromEnvironment(),
      {
        marketClient: new HttpRiskMarketClient(
          process.env.OPS_RISK_SERVICE_URL ?? "http://127.0.0.1:3008"
        )
      }
    );
    const faultLabClient = new HttpFaultLabClient({
      settlementBaseUrl,
      custodyBaseUrl,
      orderBaseUrl,
      indexerBaseUrl,
      simulatorBaseUrl
    });
    const reconciliationClient = new HttpReconciliationClient(ledgerBaseUrl);
    this.faultLab = new FaultLabApplicationService(
      faultLabClient,
      orderClient,
      (options, operation) => this.applicationService.runAuditedAction(options, operation),
      { reconciliationClient }
    );
    // Emergency switches (risk-service), reconciliation job (ledger-service), P1/P2/P3 alerts.
    this.controls = new OpsControlsApplicationService({
      switches: new HttpControlSwitchClient(process.env.OPS_RISK_SERVICE_URL ?? "http://127.0.0.1:3008"),
      reconciliation: reconciliationClient,
      runAudited: (options, operation) => this.applicationService.runAuditedAction(options, operation),
      baseAlerts: () => this.applicationService.getAlertsOverview(),
      settlementReport: () => this.applicationService.getTradeSettlementReport({}),
      settlementConsumer: () => faultLabClient.getSettlementConsumerState()
    });
  }

  getMarketConfig() {
    return this.applicationService.getMarketConfig();
  }

  async listMarkets() {
    return this.applicationService.listMarkets();
  }

  async setMarketStatus(session: OpsSessionInfo, command: OpsSetMarketStatusCommand) {
    return this.applicationService.setMarketStatus(session, command);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.OPS_EXECUTION_SCHEDULER_RUN_FOREVER !== "true") {
      return;
    }

    const intervalMs = Number(process.env.OPS_EXECUTION_SCHEDULER_INTERVAL_MS ?? "60000");
    this.schedulerTimer = setInterval(() => {
      void this.applicationService.runDueExecutionSchedules({
        limit: Number(process.env.OPS_EXECUTION_SCHEDULER_BATCH_SIZE ?? "10")
      });
    }, intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
    await this.pool?.end();
  }

  async login(command: OpsLoginCommand) {
    return this.applicationService.login(command);
  }

  async getCurrentSession(token: string) {
    return this.applicationService.getCurrentSession(token);
  }

  async logout(token: string) {
    return this.applicationService.logout(token);
  }

  async getDashboard(query: {
    network?: string;
    reviewQueueLimit?: number;
    notificationsLimit?: number;
  }) {
    return this.applicationService.getDashboard(query);
  }

  async listWithdrawalReviewQueue(query: OpsReviewQueueQuery) {
    return this.applicationService.listWithdrawalReviewQueue(query);
  }

  async listUsers(query: OpsUserQuery) {
    return this.applicationService.listUsers(query);
  }

  async listModuleNavigation() {
    return this.applicationService.listModuleNavigation();
  }

  async getBusinessTrace(query: OpsBusinessTraceQuery) {
    const trace = await this.applicationService.getBusinessTrace(query);
    // Jaeger UI for the OpenTelemetry trace ids stored on orders / withdrawals.
    const tracingUiUrl =
      process.env.OPS_TRACING_UI_URL?.trim() ||
      (process.env.OTEL_ENABLED === "true" ? "http://127.0.0.1:16686" : undefined);
    return { ...trace, tracingUiUrl };
  }

  async freezeUser(session: OpsSessionInfo, command: OpsFreezeUserCommand) {
    return this.applicationService.freezeUser(session, command);
  }

  async unfreezeUser(session: OpsSessionInfo, userId: string) {
    return this.applicationService.unfreezeUser(session, userId);
  }

  async getUserKycProfile(userId: string) {
    return this.applicationService.getUserKycProfile(userId);
  }

  async listKycRequests(query: OpsKycRequestQuery) {
    return this.applicationService.listKycRequests(query);
  }

  async approveKycRequest(session: OpsSessionInfo, command: OpsReviewKycRequestCommand) {
    return this.applicationService.approveKycRequest(session, command);
  }

  async rejectKycRequest(session: OpsSessionInfo, command: OpsReviewKycRequestCommand) {
    return this.applicationService.rejectKycRequest(session, command);
  }

  async setUserKycTier(session: OpsSessionInfo, command: OpsSetKycTierCommand) {
    return this.applicationService.setUserKycTier(session, command);
  }

  async listBalances(query: OpsBalanceQuery) {
    return this.applicationService.listBalances(query);
  }

  async listDeposits(query: OpsDepositQuery) {
    return this.applicationService.listDeposits(query);
  }

  async listSpotOrders(query: OpsSpotOrderQuery) {
    return this.applicationService.listSpotOrders(query);
  }

  async listSpotTrades(query: OpsSpotTradeQuery) {
    return this.applicationService.listSpotTrades(query);
  }

  async listTradeSettlements(query: OpsTradeSettlementQuery) {
    return this.applicationService.listTradeSettlements(query);
  }

  async getTradeSettlementReport(query: OpsTradeSettlementQuery) {
    return this.applicationService.getTradeSettlementReport(query);
  }

  async listTradeSettlementRecoveryJobs(query: OpsTradeSettlementRecoveryJobQuery) {
    return this.applicationService.listTradeSettlementRecoveryJobs(query);
  }

  async getTradeSettlementRecoveryGovernanceReport() {
    return this.applicationService.getTradeSettlementRecoveryGovernanceReport();
  }

  async listTradeSettlementAutomationExecutions(query: {
    executionType?: string;
    status?: "succeeded" | "failed" | "partial";
    trigger?: "automatic" | "manual" | "template";
    market?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.applicationService.listTradeSettlementAutomationExecutions(query);
  }

  async getTradeOpsOverview(query: OpsTradeOpsQuery) {
    return this.applicationService.getTradeOpsOverview(query);
  }

  async getTradeOpsAnomalies(query: OpsTradeOpsQuery) {
    return this.applicationService.getTradeOpsAnomalies(query);
  }

  async listTradeRecoveryJobs(query: OpsSpotRecoveryJobQuery) {
    return this.applicationService.listTradeRecoveryJobs(query);
  }

  async getTradeRecoveryMetrics() {
    return this.applicationService.getTradeRecoveryMetrics();
  }

  async getTradeRecoveryGovernanceReport() {
    return this.applicationService.getTradeRecoveryGovernanceReport();
  }

  async getTradeDeadLetterReport(query: {
    market?: string;
    limit?: number;
    templateLimit?: number;
  }) {
    return this.applicationService.getTradeDeadLetterReport(query);
  }

  async listTradeAutomationExecutions(query: {
    executionType?: string;
    status?: "succeeded" | "failed" | "partial";
    trigger?: "automatic" | "manual" | "template";
    market?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.applicationService.listTradeAutomationExecutions(query);
  }

  async listTradeDeadLetterJobs(query: OpsSpotRecoveryJobQuery) {
    return this.applicationService.listTradeDeadLetterJobs(query);
  }

  async getTradeRuntimeReport(query: { market: string; historyLimit?: number }) {
    return this.applicationService.getTradeRuntimeReport(query);
  }

  async getTradeRuntimeDrilldown(query: OpsTradeRuntimeDrilldownQuery) {
    return this.applicationService.getTradeRuntimeDrilldown(query);
  }

  async listTradeRuntimeAlertSinks() {
    return this.applicationService.listTradeRuntimeAlertSinks();
  }

  async replayTradeEngineBook(session: OpsSessionInfo, command: OpsTradeOpsQuery) {
    return this.applicationService.replayTradeEngineBook(session, command);
  }

  async replayTradeEventStream(
    session: OpsSessionInfo,
    command: {
      market: string;
      afterStreamEntryId?: string;
      fromStreamEntryId?: string;
      toStreamEntryId?: string;
      executionSequenceFrom?: number;
      limit?: number;
      overlapCount?: number;
      direction?: "forward" | "backward";
      publishToChannel?: boolean;
      processSettlement?: boolean;
      allowGap?: boolean;
    }
  ) {
    return this.applicationService.replayTradeEventStream(session, command);
  }

  async trimTradeEventStream(
    session: OpsSessionInfo,
    command: {
      market?: string;
      strategy?: "auto" | "maxlen" | "minid";
      maxLen?: number;
      retentionMs?: number;
      minStreamEntryId?: string;
      dryRun?: boolean;
      limit?: number;
    }
  ) {
    return this.applicationService.trimTradeEventStream(session, command);
  }

  async maintainTradeEventStream(
    session: OpsSessionInfo,
    command: {
      market?: string;
      dryRun?: boolean;
      force?: boolean;
      limit?: number;
    }
  ) {
    return this.applicationService.maintainTradeEventStream(session, command);
  }

  async selfHealTradeEventBus(
    session: OpsSessionInfo,
    command: {
      market: string;
      historyLimit?: number;
      maxAcceptableLag?: number;
      replayLimit?: number;
      overlapCount?: number;
      publishToChannel?: boolean;
      allowGap?: boolean;
      trim?: boolean;
      deliverAlerts?: boolean;
      sinkId?: string;
    }
  ) {
    return this.applicationService.selfHealTradeEventBus(session, command);
  }

  async processTradeEventSubscriptionCycle(
    session: OpsSessionInfo,
    command: {
      market?: string;
      allowGap?: boolean;
      afterStreamEntryId?: string;
      limit?: number;
      overlapCount?: number;
    }
  ) {
    return this.applicationService.processTradeEventSubscriptionCycle(session, command);
  }

  async processTradeRecoveryJobs(
    session: OpsSessionInfo,
    command: OpsProcessRecoveryJobsCommand
  ) {
    return this.applicationService.processTradeRecoveryJobs(session, command);
  }

  async recoverTradeRecoveryJob(session: OpsSessionInfo, jobId: string) {
    return this.applicationService.recoverTradeRecoveryJob(session, jobId);
  }

  async requeueTradeDeadLetterJob(session: OpsSessionInfo, jobId: string) {
    return this.applicationService.requeueTradeDeadLetterJob(session, jobId);
  }

  async batchRequeueTradeDeadLetterJobs(
    session: OpsSessionInfo,
    command: { market?: string; limit?: number }
  ) {
    return this.applicationService.batchRequeueTradeDeadLetterJobs(session, command);
  }

  async processTradeSettlementRecoveryJobs(
    session: OpsSessionInfo,
    command: OpsProcessRecoveryJobsCommand
  ) {
    return this.applicationService.processTradeSettlementRecoveryJobs(session, command);
  }

  async recoverTradeSettlement(session: OpsSessionInfo, tradeId: string) {
    return this.applicationService.recoverTradeSettlement(session, tradeId);
  }

  async listExecutionTemplates() {
    return this.applicationService.listExecutionTemplates();
  }

  async listExecutionHistory(query: {
    templateId?: string;
    targetId?: string;
    status?: "succeeded" | "failed";
    limit?: number;
    offset?: number;
  }) {
    return this.applicationService.listExecutionHistory(query);
  }

  async getExecutionHistoryDiff(query: OpsExecutionHistoryDiffQuery) {
    return this.applicationService.getExecutionHistoryDiff(query);
  }

  async listExecutionSchedules(query: OpsExecutionScheduleQuery) {
    return this.applicationService.listExecutionSchedules(query);
  }

  async runDueExecutionSchedules(
    session: OpsSessionInfo,
    command: OpsRunExecutionSchedulesCommand
  ) {
    return this.applicationService.runDueExecutionSchedules(command, session);
  }

  async executeExecutionTemplate(
    session: OpsSessionInfo,
    templateId: string,
    payload: Record<string, unknown>
  ) {
    return this.applicationService.executeExecutionTemplate(session, templateId, payload);
  }

  async listWithdrawals(query: OpsWithdrawalQuery) {
    return this.applicationService.listWithdrawals(query);
  }

  async getWithdrawalDetail(withdrawalId: string, query: OpsWithdrawalAuditLogQuery) {
    return this.applicationService.getWithdrawalDetail(withdrawalId, query);
  }

  async approveWithdrawal(session: OpsSessionInfo, command: OpsApproveWithdrawalCommand) {
    return this.applicationService.approveWithdrawal(session, command);
  }

  async rejectWithdrawal(session: OpsSessionInfo, command: OpsRejectWithdrawalCommand) {
    return this.applicationService.rejectWithdrawal(session, command);
  }

  async batchApproveWithdrawals(
    session: OpsSessionInfo,
    command: OpsBatchApproveWithdrawalsCommand
  ) {
    return this.applicationService.batchApproveWithdrawals(session, command);
  }

  async batchRejectWithdrawals(
    session: OpsSessionInfo,
    command: OpsBatchRejectWithdrawalsCommand
  ) {
    return this.applicationService.batchRejectWithdrawals(session, command);
  }

  async listWithdrawalAuditLogs(withdrawalId: string, query: OpsWithdrawalAuditLogQuery) {
    return this.applicationService.listWithdrawalAuditLogs(withdrawalId, query);
  }

  async searchWithdrawalAuditLogs(query: OpsWithdrawalAuditLogQuery) {
    return this.applicationService.searchWithdrawalAuditLogs(query);
  }

  async listActionAuditLogs(query: OpsActionAuditLogQuery) {
    return this.applicationService.listActionAuditLogs(query);
  }

  async listWithdrawalAddressBook(query: OpsWithdrawalAddressBookQuery) {
    return this.applicationService.listWithdrawalAddressBook(query);
  }

  async whitelistWithdrawalAddress(session: OpsSessionInfo, addressBookId: string) {
    return this.applicationService.whitelistWithdrawalAddress(session, addressBookId);
  }

  async unwhitelistWithdrawalAddress(session: OpsSessionInfo, addressBookId: string) {
    return this.applicationService.unwhitelistWithdrawalAddress(session, addressBookId);
  }

  async listNotifications(query: OpsNotificationQuery) {
    return this.applicationService.listNotifications(query);
  }

  async getCustodyProviderHealth() {
    return this.applicationService.getCustodyProviderHealth();
  }

  async runCustodyProviderHealthChecks(session: OpsSessionInfo) {
    return this.applicationService.runCustodyProviderHealthChecks(session);
  }

  async getCustodyOpsOverview() {
    return this.applicationService.getCustodyOpsOverview();
  }

  async getLedgerReconciliationReport(query: OpsLedgerReconciliationQuery) {
    return this.applicationService.getLedgerReconciliationReport(query);
  }

  async getLedgerReplayReport(query: OpsLedgerReplayQuery) {
    return this.applicationService.getLedgerReplayReport(query);
  }

  async getLedgerOpsOverview() {
    return this.applicationService.getLedgerOpsOverview();
  }

  async drainLedgerOutbox(session: OpsSessionInfo, command: OpsLedgerDrainOutboxCommand) {
    return this.applicationService.drainLedgerOutbox(session, command);
  }

  async getIndexerOpsOverview() {
    return this.applicationService.getIndexerOpsOverview();
  }

  async replayIndexer(session: OpsSessionInfo, command: OpsIndexerReplayCommand) {
    return this.applicationService.replayIndexer(session, command);
  }

  async repairIndexerBacklog(
    session: OpsSessionInfo,
    command: OpsIndexerBacklogRepairCommand
  ) {
    return this.applicationService.repairIndexerBacklog(session, command);
  }

  async listIndexerPendingDeposits(query: OpsIndexerPendingDepositQuery) {
    return this.applicationService.listIndexerPendingDeposits(query);
  }

  async replayIndexerPendingDeposit(
    session: OpsSessionInfo,
    command: OpsReplayPendingDepositCommand
  ) {
    return this.applicationService.replayIndexerPendingDeposit(session, command);
  }

  async closeIndexerPendingDeposit(
    session: OpsSessionInfo,
    command: OpsClosePendingDepositCommand
  ) {
    return this.applicationService.closeIndexerPendingDeposit(session, command);
  }

  async batchReplayIndexerPendingDeposits(
    session: OpsSessionInfo,
    command: OpsBatchReplayPendingDepositsCommand
  ) {
    return this.applicationService.batchReplayIndexerPendingDeposits(session, command);
  }

  async batchCloseIndexerPendingDeposits(
    session: OpsSessionInfo,
    command: OpsBatchClosePendingDepositsCommand
  ) {
    return this.applicationService.batchCloseIndexerPendingDeposits(session, command);
  }

  async deliverNotifications(
    session: OpsSessionInfo,
    command: OpsWalletNotificationDeliveryCommand
  ) {
    return this.applicationService.deliverNotifications(session, command);
  }

  async reconcileStaleWithdrawals(
    session: OpsSessionInfo,
    command: OpsWalletStaleWithdrawalRepairCommand
  ) {
    return this.applicationService.reconcileStaleWithdrawals(session, command);
  }

  async getAlertsOverview() {
    // Same payload as before plus a P1/P2/P3 level per alert (see domain/alert-severity.ts).
    return this.controls.getAlertsOverview();
  }

  async exportTradeRuntimeAlerts(query: OpsTradeRuntimeReportQuery) {
    return this.applicationService.exportTradeRuntimeAlerts(query);
  }

  async deliverTradeRuntimeAlerts(
    session: OpsSessionInfo,
    command: OpsTradeRuntimeAlertDeliveryCommand
  ) {
    return this.applicationService.deliverTradeRuntimeAlerts(session, command);
  }
}
