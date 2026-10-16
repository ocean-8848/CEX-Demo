export interface PagedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpsReviewQueueQuery {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  status?: string;
  txHash?: string;
  toAddress?: string;
  /** KYT risk level: low / medium / high / blocked. */
  riskLevel?: string;
  limit?: number;
  offset?: number;
}

export interface OpsWithdrawalQuery extends OpsReviewQueueQuery {
  reviewStatus?: string;
}

export interface OpsDepositQuery {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  status?: string;
  txHash?: string;
  address?: string;
  limit?: number;
  offset?: number;
}

export interface OpsBalanceQuery {
  userId?: string;
  accountId?: string;
  assetCode?: string;
  accountType?: string;
  accountStatus?: string;
  limit?: number;
  offset?: number;
}

export interface OpsUserQuery {
  userId?: string;
  email?: string;
  status?: string;
  userType?: string;
  role?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OpsWithdrawalAuditLogQuery {
  withdrawalId?: string;
  userId?: string;
  assetCode?: string;
  network?: string;
  status?: string;
  reviewStatus?: string;
  txHash?: string;
  toAddress?: string;
  action?: string;
  operatorId?: string;
  limit?: number;
  offset?: number;
}

export interface OpsLedgerReconciliationQuery {
  accountId?: string;
  assetCode?: string;
  includeMatched?: boolean;
}

export interface OpsLedgerReplayQuery {
  accountId: string;
  assetCode: string;
}

export interface OpsWithdrawalAddressBookQuery {
  userId?: string;
  network?: string;
  address?: string;
  isWhitelisted?: boolean;
  limit?: number;
  offset?: number;
}

export interface OpsBusinessTraceQuery {
  userId?: string;
  accountId?: string;
  orderId?: string;
  tradeId?: string;
  depositId?: string;
  withdrawalId?: string;
  txHash?: string;
  market?: string;
  assetCode?: string;
  limit?: number;
}

export interface OpsNotificationQuery {
  userId?: string;
  withdrawalId?: string;
  eventType?: string;
  status?: string;
  channel?: string;
  limit?: number;
  offset?: number;
}

export interface OpsSpotOrderQuery {
  userId?: string;
  accountId?: string;
  market?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface OpsSpotTradeQuery {
  userId?: string;
  market?: string;
  orderId?: string;
  limit?: number;
  offset?: number;
}

export interface OpsTradeSettlementQuery {
  userId?: string;
  market?: string;
  orderId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface OpsTradeSettlementRecoveryJobQuery {
  tradeId?: string;
  market?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface OpsSpotRecoveryJobQuery {
  orderId?: string;
  market?: string;
  status?: string;
  deadLettered?: boolean;
  limit?: number;
  offset?: number;
}

export interface OpsTradeOpsQuery {
  market: string;
}

export interface OpsTradeDeadLetterReportQuery {
  market?: string;
  limit?: number;
  templateLimit?: number;
}

export interface OpsAutomationExecutionQuery {
  executionType?: string;
  status?: "succeeded" | "failed" | "partial";
  trigger?: "automatic" | "manual" | "template";
  market?: string;
  limit?: number;
  offset?: number;
}

export interface OpsTradeRuntimeReportQuery {
  market: string;
  historyLimit?: number;
}

export interface OpsTradeRuntimeDrilldownQuery extends OpsTradeRuntimeReportQuery {
  streamLimit?: number;
  checkpointLimit?: number;
}

export interface OpsTradeEventBusCheckpointQuery {
  consumerId?: string;
  market?: string;
  limit?: number;
  offset?: number;
}

export interface OpsTradeEventStreamQuery {
  market: string;
  afterStreamEntryId?: string;
  fromStreamEntryId?: string;
  toStreamEntryId?: string;
  executionSequenceFrom?: number;
  limit?: number;
  overlapCount?: number;
  direction?: "forward" | "backward";
}

export interface OpsReplayTradeEventStreamCommand extends OpsTradeEventStreamQuery {
  publishToChannel?: boolean;
  processSettlement?: boolean;
  allowGap?: boolean;
}

export interface OpsTrimTradeEventStreamCommand {
  market?: string;
  strategy?: "auto" | "maxlen" | "minid";
  maxLen?: number;
  retentionMs?: number;
  minStreamEntryId?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface OpsMaintainTradeEventStreamCommand {
  market?: string;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
}

export interface OpsSelfHealTradeEventBusCommand {
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

export interface OpsDeliverTradeRuntimeAlertsCommand {
  market: string;
  historyLimit?: number;
  sinkId?: string;
}

export interface OpsExecutionScheduleQuery {
  scheduleId?: string;
  market?: string;
  dueOnly?: boolean;
  limit?: number;
}

export interface OpsRunExecutionSchedulesCommand {
  scheduleId?: string;
  force?: boolean;
  limit?: number;
}

export interface OpsExecutionHistoryDiffQuery {
  templateId: string;
  targetId?: string;
  limit?: number;
}

export interface OpsTradeRuntimeAlertDeliveryCommand {
  market: string;
  historyLimit?: number;
  sinkId?: string;
}

export interface OpsProcessRecoveryJobsCommand {
  limit?: number;
}

export interface OpsApproveWithdrawalCommand {
  withdrawalId: string;
  reviewedBy: string;
  note?: string;
}

export interface OpsRejectWithdrawalCommand {
  withdrawalId: string;
  reviewedBy: string;
  reason?: string;
}

export interface OpsBatchApproveWithdrawalsCommand {
  withdrawalIds: string[];
  reviewedBy: string;
  note?: string;
}

export interface OpsBatchRejectWithdrawalsCommand {
  withdrawalIds: string[];
  reviewedBy: string;
  reason?: string;
}

export interface OpsLoginCommand {
  email: string;
  password: string;
  twoFactorCode?: string;
}

export interface OpsFreezeUserCommand {
  userId: string;
  reason?: string;
}

/** KYC review queue. */
export interface OpsKycRequestQuery {
  userId?: string;
  status?: "pending" | "approved" | "rejected";
  limit?: number;
  offset?: number;
}

export interface OpsReviewKycRequestCommand {
  requestId: string;
  reviewedBy: string;
  /** approve only: L1 or L2 (defaults to the requested tier). */
  tier?: string;
  note?: string;
}

export interface OpsSetKycTierCommand {
  userId: string;
  tier: string;
  actorId: string;
  reason?: string;
}

export interface OpsLedgerDrainOutboxCommand {
  requeueDeadLetter?: boolean;
  maxCycles?: number;
}

export interface OpsWalletNotificationDeliveryCommand {
  limit?: number;
}

export interface OpsWalletStaleWithdrawalRepairCommand {
  staleMinutes?: number;
  rebroadcastAutoConfirm?: boolean;
  forceConfirmations?: number;
  forceBlockNumber?: number;
  pageSize?: number;
  operatorId?: string;
}

export interface OpsIndexerReplayCommand {
  network: string;
  observationType?: "deposit" | "withdrawal" | "both";
  fromBlock?: number;
  toBlock?: number;
  rpcUrl?: string;
}

export interface OpsIndexerBacklogRepairCommand {
  network: string;
  observationType?: "deposit" | "withdrawal" | "both";
  lookbackBlocks?: number;
  rpcUrl?: string;
}

export interface OpsIndexerPendingDepositQuery {
  network?: string;
  assetCode?: string;
  status?: "pending" | "detected" | "confirming" | "closed" | "credited";
  olderThanSeconds?: number;
  limit?: number;
  offset?: number;
}

export interface OpsReplayPendingDepositCommand {
  observationId: string;
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  operatedBy?: string;
  note?: string;
}

export interface OpsClosePendingDepositCommand {
  observationId: string;
  operatedBy?: string;
  note?: string;
}

export interface OpsBatchReplayPendingDepositsCommand {
  observationIds: string[];
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  operatedBy?: string;
  note?: string;
}

export interface OpsBatchClosePendingDepositsCommand {
  observationIds: string[];
  operatedBy?: string;
  note?: string;
}

export interface OpsSession {
  sessionId: string;
  token: string;
  userId: string;
  email?: string;
  displayName?: string;
  roles: string[];
  permissions: string[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  active: boolean;
}

export interface OpsSessionInfo {
  sessionId: string;
  userId: string;
  email?: string;
  displayName?: string;
  roles: string[];
  permissions: string[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  active: boolean;
  status: string;
}

export interface OpsWalletClient {
  listDeposits(query: OpsDepositQuery): Promise<PagedResponse<Record<string, unknown>>>;
  listWithdrawalReviewQueue(query: OpsReviewQueueQuery): Promise<PagedResponse<Record<string, unknown>>>;
  listWithdrawals(query: OpsWithdrawalQuery): Promise<PagedResponse<Record<string, unknown>>>;
  getWithdrawal(withdrawalId: string): Promise<Record<string, unknown> | null>;
  approveWithdrawal(command: OpsApproveWithdrawalCommand): Promise<Record<string, unknown>>;
  rejectWithdrawal(command: OpsRejectWithdrawalCommand): Promise<Record<string, unknown>>;
  listWithdrawalAuditLogs(
    withdrawalId: string,
    query: OpsWithdrawalAuditLogQuery
  ): Promise<PagedResponse<Record<string, unknown>>>;
  searchWithdrawalAuditLogs(
    query: OpsWithdrawalAuditLogQuery
  ): Promise<PagedResponse<Record<string, unknown>>>;
  listWithdrawalAddressBook(
    query: OpsWithdrawalAddressBookQuery
  ): Promise<PagedResponse<Record<string, unknown>>>;
  whitelistWithdrawalAddress(addressBookId: string): Promise<Record<string, unknown>>;
  unwhitelistWithdrawalAddress(addressBookId: string): Promise<Record<string, unknown>>;
  listNotifications(query: OpsNotificationQuery): Promise<PagedResponse<Record<string, unknown>>>;
  deliverNotifications(
    command: OpsWalletNotificationDeliveryCommand
  ): Promise<Record<string, unknown>>;
  reconcileStaleWithdrawals(
    command: OpsWalletStaleWithdrawalRepairCommand
  ): Promise<Record<string, unknown>>;
}

export interface OpsCustodyClient {
  getProviderHealth(): Promise<Record<string, unknown>[]>;
  runProviderHealthChecks(): Promise<Record<string, unknown>>;
  getOpsOverview(): Promise<Record<string, unknown>>;
  getTransfer(custodyTransferId: string): Promise<Record<string, unknown> | null>;
}

export interface OpsIdentityClient {
  login(command: OpsLoginCommand): Promise<OpsSession>;
  getCurrentSession(token: string): Promise<OpsSessionInfo>;
  logout(token: string): Promise<{ revoked: true; revokedAt: string }>;
  listUsers(query: OpsUserQuery): Promise<PagedResponse<Record<string, unknown>>>;
  freezeUser(command: OpsFreezeUserCommand): Promise<Record<string, unknown>>;
  unfreezeUser(userId: string): Promise<Record<string, unknown>>;
  getKycProfile(userId: string): Promise<Record<string, unknown>>;
  listKycRequests(query: OpsKycRequestQuery): Promise<PagedResponse<Record<string, unknown>>>;
  approveKycRequest(command: OpsReviewKycRequestCommand): Promise<Record<string, unknown>>;
  rejectKycRequest(command: OpsReviewKycRequestCommand): Promise<Record<string, unknown>>;
  setKycTier(command: OpsSetKycTierCommand): Promise<Record<string, unknown>>;
}

export interface OpsLedgerClient {
  listBalances(query: OpsBalanceQuery): Promise<PagedResponse<Record<string, unknown>>>;
  getReconciliationReport(
    query: OpsLedgerReconciliationQuery
  ): Promise<Record<string, unknown>>;
  getReplayReport(query: OpsLedgerReplayQuery): Promise<Record<string, unknown>>;
  getOpsOverview(): Promise<Record<string, unknown>>;
  drainOutbox(command: OpsLedgerDrainOutboxCommand): Promise<Record<string, unknown>>;
}

export interface OpsIndexerClient {
  getOpsOverview(): Promise<Record<string, unknown>>;
  replay(command: OpsIndexerReplayCommand): Promise<Record<string, unknown>>;
  repairBacklog(command: OpsIndexerBacklogRepairCommand): Promise<Record<string, unknown>>;
  listPendingDeposits(
    query: OpsIndexerPendingDepositQuery
  ): Promise<PagedResponse<Record<string, unknown>>>;
  replayPendingDeposit(
    command: OpsReplayPendingDepositCommand
  ): Promise<Record<string, unknown>>;
  closePendingDeposit(command: OpsClosePendingDepositCommand): Promise<Record<string, unknown>>;
}

export interface OpsSetMarketStatusCommand {
  market: string;
  status: "listed" | "halted";
  reason?: string;
}

/** risk-service market status API (config/markets.json defaults + runtime overrides). */
export interface OpsMarketClient {
  listMarkets(): Promise<Record<string, unknown>[]>;
  setMarketStatus(
    command: OpsSetMarketStatusCommand & { operator: string }
  ): Promise<Record<string, unknown>>;
}

export interface OpsAlertSinkClient {
  listTradeRuntimeAlertSinks(): Promise<Record<string, unknown>[]>;
  deliverTradeRuntimeAlerts(command: {
    market: string;
    sinkId?: string;
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]>;
}

export interface OpsOrderClient {
  listSpotOrders(query: OpsSpotOrderQuery): Promise<Record<string, unknown>[]>;
  listSpotTrades(query: OpsSpotTradeQuery): Promise<Record<string, unknown>[]>;
  getTradeEventBusReport(): Promise<Record<string, unknown>>;
  listTradeEventStreamEntries(
    query: OpsTradeEventStreamQuery
  ): Promise<Record<string, unknown>[]>;
  replayTradeEventStream(
    command: OpsReplayTradeEventStreamCommand
  ): Promise<Record<string, unknown>>;
  trimTradeEventStream(
    command: OpsTrimTradeEventStreamCommand
  ): Promise<Record<string, unknown>>;
  maintainTradeEventStream(
    command: OpsMaintainTradeEventStreamCommand
  ): Promise<Record<string, unknown>>;
  getTradeOpsOverview(query: OpsTradeOpsQuery): Promise<Record<string, unknown>>;
  getTradeOpsAnomalies(query: OpsTradeOpsQuery): Promise<Record<string, unknown>[]>;
  replayEngineBook(command: OpsTradeOpsQuery): Promise<Record<string, unknown>>;
  listRecoveryJobs(
    query: OpsSpotRecoveryJobQuery
  ): Promise<Record<string, unknown>[]>;
  getRecoveryMetrics(): Promise<Record<string, unknown>>;
  getRecoveryGovernanceReport(): Promise<Record<string, unknown>>;
  getDeadLetterReport(query: OpsTradeDeadLetterReportQuery): Promise<Record<string, unknown>>;
  listAutomationExecutions(
    query: OpsAutomationExecutionQuery
  ): Promise<Record<string, unknown>[]>;
  listDeadLetterJobs(
    query: OpsSpotRecoveryJobQuery
  ): Promise<Record<string, unknown>[]>;
  processRecoveryJobs(
    command: OpsProcessRecoveryJobsCommand
  ): Promise<Record<string, unknown>>;
  recoverJob(jobId: string): Promise<Record<string, unknown>>;
  requeueDeadLetterJob(jobId: string): Promise<Record<string, unknown>>;
  batchRequeueDeadLetterJobs(command: {
    market?: string;
    limit?: number;
  }): Promise<Record<string, unknown>>;
}

export interface OpsSettlementClient {
  listTradeSettlements(query: OpsTradeSettlementQuery): Promise<Record<string, unknown>[]>;
  getTradeSettlementReport(query: OpsTradeSettlementQuery): Promise<Record<string, unknown>>;
  listTradeSettlementRecoveryJobs(
    query: OpsTradeSettlementRecoveryJobQuery
  ): Promise<Record<string, unknown>[]>;
  getTradeEventBusReport(
    query: OpsTradeEventBusCheckpointQuery
  ): Promise<Record<string, unknown>>;
  listTradeEventConsumerCheckpoints(
    query: OpsTradeEventBusCheckpointQuery
  ): Promise<Record<string, unknown>[]>;
  processTradeEventSubscriptionCycle(command: {
    market?: string;
    allowGap?: boolean;
    afterStreamEntryId?: string;
    limit?: number;
    overlapCount?: number;
  }): Promise<Record<string, unknown>>;
  getTradeSettlementRecoveryGovernanceReport(): Promise<Record<string, unknown>>;
  listAutomationExecutions(
    query: OpsAutomationExecutionQuery
  ): Promise<Record<string, unknown>[]>;
  processTradeSettlementRecoveryJobs(
    command: OpsProcessRecoveryJobsCommand
  ): Promise<Record<string, unknown>>;
  recoverTradeSettlement(tradeId: string): Promise<Record<string, unknown>>;
}
