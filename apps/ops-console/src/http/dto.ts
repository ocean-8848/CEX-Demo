export interface OpsLoginRequestDto {
  email: string;
  password: string;
  twoFactorCode?: string;
}

export interface OpsDashboardQueryDto {
  network?: string;
  reviewQueueLimit?: string;
  notificationsLimit?: string;
}

export interface OpsLedgerReconciliationQueryDto {
  accountId?: string;
  assetCode?: string;
  includeMatched?: string;
}

export interface OpsLedgerReplayQueryDto {
  accountId?: string;
  assetCode?: string;
}

export interface OpsUserSearchQueryDto {
  userId?: string;
  email?: string;
  status?: string;
  userType?: string;
  role?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

export interface OpsBusinessTraceQueryDto {
  userId?: string;
  accountId?: string;
  orderId?: string;
  tradeId?: string;
  depositId?: string;
  withdrawalId?: string;
  txHash?: string;
  market?: string;
  assetCode?: string;
  limit?: string;
}

export interface OpsBalanceSearchQueryDto {
  userId?: string;
  accountId?: string;
  assetCode?: string;
  accountType?: string;
  accountStatus?: string;
  limit?: string;
  offset?: string;
}

export interface OpsDepositSearchQueryDto {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  status?: string;
  txHash?: string;
  address?: string;
  limit?: string;
  offset?: string;
}

export interface OpsSpotOrderSearchQueryDto {
  userId?: string;
  accountId?: string;
  market?: string;
  status?: string;
  limit?: string;
  offset?: string;
}

export interface OpsSpotTradeSearchQueryDto {
  userId?: string;
  market?: string;
  orderId?: string;
  limit?: string;
  offset?: string;
}

export interface OpsTradeSettlementSearchQueryDto {
  userId?: string;
  market?: string;
  orderId?: string;
  status?: string;
  limit?: string;
  offset?: string;
}

export interface OpsTradeSettlementRecoveryJobQueryDto {
  tradeId?: string;
  market?: string;
  status?: string;
  limit?: string;
  offset?: string;
}

export interface OpsSpotRecoveryJobQueryDto {
  orderId?: string;
  market?: string;
  status?: string;
  deadLettered?: string;
  limit?: string;
  offset?: string;
}

export interface OpsTradeOpsQueryDto {
  market: string;
}

export interface OpsTradeDeadLetterReportQueryDto {
  market?: string;
  limit?: string;
  templateLimit?: string;
}

export interface OpsAutomationExecutionsQueryDto {
  executionType?: string;
  status?: "succeeded" | "failed" | "partial";
  trigger?: "automatic" | "manual" | "template";
  market?: string;
  limit?: string;
  offset?: string;
}

export interface OpsTradeRuntimeReportQueryDto {
  market: string;
  historyLimit?: string;
}

export interface OpsTradeRuntimeDrilldownQueryDto extends OpsTradeRuntimeReportQueryDto {
  streamLimit?: string;
  checkpointLimit?: string;
}

export interface OpsExecutionSchedulesQueryDto {
  scheduleId?: string;
  market?: string;
  dueOnly?: string;
  limit?: string;
}

export interface OpsProcessRecoveryJobsRequestDto {
  limit?: number;
}

export interface OpsExecutionHistoryQueryDto {
  templateId?: string;
  targetId?: string;
  status?: "succeeded" | "failed";
  limit?: string;
  offset?: string;
}

export interface OpsExecutionHistoryDiffQueryDto {
  templateId: string;
  targetId?: string;
  limit?: string;
}

export interface OpsExecuteTemplateRequestDto {
  market?: string;
  limit?: number;
  orderRecoveryLimit?: number;
  settlementRecoveryLimit?: number;
  deadLetterRequeueLimit?: number;
}

export interface OpsRunExecutionSchedulesRequestDto {
  scheduleId?: string;
  force?: boolean;
  limit?: number;
}

export interface OpsReplayTradeEventStreamRequestDto {
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

export interface OpsProcessTradeEventSubscriptionRequestDto {
  market?: string;
  allowGap?: boolean;
  afterStreamEntryId?: string;
  limit?: number;
  overlapCount?: number;
}

export interface OpsTrimTradeEventStreamRequestDto {
  market?: string;
  strategy?: "auto" | "maxlen" | "minid";
  maxLen?: number;
  retentionMs?: number;
  minStreamEntryId?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface OpsMaintainTradeEventStreamRequestDto {
  market?: string;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
}

export interface OpsSelfHealTradeEventBusRequestDto {
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

export interface OpsTradeRuntimeAlertDeliveryRequestDto {
  market: string;
  historyLimit?: number;
  sinkId?: string;
}

export interface OpsReviewQueueQueryDto {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: string;
  network?: string;
  status?: string;
  reviewStatus?: string;
  txHash?: string;
  toAddress?: string;
  riskLevel?: string;
  limit?: string;
  offset?: string;
}

export interface OpsWithdrawalAuditLogsQueryDto {
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
  limit?: string;
  offset?: string;
}

export interface OpsActionAuditLogsQueryDto {
  batchId?: string;
  operatorUserId?: string;
  action?: string;
  permission?: string;
  targetType?: string;
  targetId?: string;
  status?: "succeeded" | "failed";
  limit?: string;
  offset?: string;
}

export interface OpsWithdrawalAddressBookQueryDto {
  userId?: string;
  network?: string;
  address?: string;
  isWhitelisted?: string;
  limit?: string;
  offset?: string;
}

export interface OpsNotificationsQueryDto {
  userId?: string;
  withdrawalId?: string;
  eventType?: string;
  status?: string;
  channel?: string;
  limit?: string;
  offset?: string;
}

export interface OpsApproveWithdrawalRequestDto {
  note?: string;
}

export interface OpsRejectWithdrawalRequestDto {
  reason?: string;
}

export interface OpsBatchApproveWithdrawalsRequestDto {
  withdrawalIds: string[];
  note?: string;
}

export interface OpsBatchRejectWithdrawalsRequestDto {
  withdrawalIds: string[];
  reason?: string;
}

export interface OpsSetMarketStatusRequestDto {
  status?: "listed" | "halted";
  reason?: string;
}

export interface OpsFreezeUserRequestDto {
  reason?: string;
}

export interface OpsKycRequestsQueryDto {
  userId?: string;
  status?: "pending" | "approved" | "rejected";
  limit?: string;
  offset?: string;
}

export interface OpsReviewKycRequestDto {
  tier?: string;
  note?: string;
  reason?: string;
}

export interface OpsSetKycTierRequestDto {
  tier: string;
  reason?: string;
}

export interface OpsDrainLedgerOutboxRequestDto {
  requeueDeadLetter?: boolean;
  maxCycles?: number;
}

export interface OpsDeliverNotificationsRequestDto {
  limit?: number;
}

export interface OpsReconcileStaleWithdrawalsRequestDto {
  staleMinutes?: number;
  rebroadcastAutoConfirm?: boolean;
  forceConfirmations?: number;
  forceBlockNumber?: number;
  pageSize?: number;
}

export interface OpsReplayIndexerRequestDto {
  network: string;
  observationType?: "deposit" | "withdrawal" | "both";
  fromBlock?: number;
  toBlock?: number;
  rpcUrl?: string;
}

export interface OpsRepairIndexerBacklogRequestDto {
  network: string;
  observationType?: "deposit" | "withdrawal" | "both";
  lookbackBlocks?: number;
  rpcUrl?: string;
}

export interface OpsIndexerPendingDepositsQueryDto {
  network?: string;
  assetCode?: string;
  status?: "pending" | "detected" | "confirming" | "closed" | "credited";
  olderThanSeconds?: string;
  limit?: string;
  offset?: string;
}

export interface OpsReplayPendingDepositRequestDto {
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  note?: string;
}

export interface OpsClosePendingDepositRequestDto {
  note?: string;
}

export interface OpsBatchReplayPendingDepositsRequestDto {
  observationIds: string[];
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  note?: string;
}

export interface OpsBatchClosePendingDepositsRequestDto {
  observationIds: string[];
  note?: string;
}

export interface OpsFaultLabDurationRequestDto {
  durationSeconds?: number | string;
}

export interface OpsFaultLabCustodyRequestDto {
  providerName?: string;
  durationSeconds?: number | string;
  count?: number | string;
}

export interface OpsFaultLabSeedDepositRequestDto {
  confirmations?: number | string;
}

export interface OpsFaultLabReorgRequestDto {
  depth?: number | string;
}

export interface OpsFaultLabEngineResetRequestDto {
  market?: string;
  resetSequences?: boolean | string;
}
