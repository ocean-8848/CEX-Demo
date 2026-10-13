import {
  DEFAULT_SPOT_MARKET,
  listAssetDefinitions,
  listSpotMarketDefinitions,
  listSpotMarkets
} from "@web3-cex/domain";

import type {
  OpsActionAuditLogQuery,
  OpsActionAuditRepository
} from "../domain/action-audit.js";
import { tradeRuntimeAlertLevel } from "../domain/alert-severity.js";
import { OpsConsoleError } from "../domain/errors.js";
import type {
  OpsAlertSinkClient,
  OpsAutomationExecutionQuery,
  OpsApproveWithdrawalCommand,
  OpsBalanceQuery,
  OpsBatchApproveWithdrawalsCommand,
  OpsBatchClosePendingDepositsCommand,
  OpsBatchRejectWithdrawalsCommand,
  OpsBatchReplayPendingDepositsCommand,
  OpsBusinessTraceQuery,
  OpsClosePendingDepositCommand,
  OpsCustodyClient,
  OpsMarketClient,
  OpsSetMarketStatusCommand,
  OpsDepositQuery,
  OpsExecutionHistoryDiffQuery,
  OpsExecutionScheduleQuery,
  OpsFreezeUserCommand,
  OpsKycRequestQuery,
  OpsReviewKycRequestCommand,
  OpsSetKycTierCommand,
  OpsIndexerBacklogRepairCommand,
  OpsIndexerClient,
  OpsIndexerPendingDepositQuery,
  OpsIndexerReplayCommand,
  OpsIdentityClient,
  OpsLedgerClient,
  OpsLedgerDrainOutboxCommand,
  OpsLedgerReconciliationQuery,
  OpsLedgerReplayQuery,
  OpsLoginCommand,
  OpsMaintainTradeEventStreamCommand,
  OpsNotificationQuery,
  OpsRejectWithdrawalCommand,
  OpsReplayPendingDepositCommand,
  OpsProcessRecoveryJobsCommand,
  OpsRunExecutionSchedulesCommand,
  OpsReviewQueueQuery,
  OpsReplayTradeEventStreamCommand,
  OpsSession,
  OpsSessionInfo,
  OpsSelfHealTradeEventBusCommand,
  OpsOrderClient,
  OpsSettlementClient,
  OpsSpotOrderQuery,
  OpsSpotRecoveryJobQuery,
  OpsSpotTradeQuery,
  OpsTradeDeadLetterReportQuery,
  OpsTradeEventBusCheckpointQuery,
  OpsTradeEventStreamQuery,
  OpsTradeOpsQuery,
  OpsTradeRuntimeAlertDeliveryCommand,
  OpsTradeRuntimeDrilldownQuery,
  OpsTradeRuntimeReportQuery,
  OpsTradeSettlementQuery,
  OpsTradeSettlementRecoveryJobQuery,
  OpsTrimTradeEventStreamCommand,
  OpsUserQuery,
  OpsWalletClient,
  OpsWalletNotificationDeliveryCommand,
  OpsWalletStaleWithdrawalRepairCommand,
  OpsWithdrawalAddressBookQuery,
  OpsWithdrawalAuditLogQuery,
  OpsWithdrawalQuery
} from "../domain/clients.js";

interface ApplicationOptions {
  now?: () => Date;
  createId?: () => string;
  /** risk-service market status API; without it market status falls back to config/markets.json. */
  marketClient?: OpsMarketClient;
}

export interface AuditedActionOptions {
  session: OpsSessionInfo;
  permission: string;
  action: string;
  targetType: string;
  targetId?: string;
  requestPayload?: Record<string, unknown>;
}

// Markets come from config/markets.json; the default market gets scheduled first.
const DEFAULT_TRADE_MARKET = DEFAULT_SPOT_MARKET;
const EXECUTION_SCHEDULE_MARKETS = [DEFAULT_TRADE_MARKET, ...listSpotMarkets()].filter(
  (market, index, list) => list.indexOf(market) === index
);

const EXECUTION_TEMPLATES = [
  {
    templateId: "order_recovery_batch_process",
    name: "Order Recovery Batch",
    description: "批量处理待恢复的订单落库与结算任务。",
    permission: "ops.ledger.execute",
    action: "trading.recovery.process_pending",
    targetType: "spot_recovery_queue",
    defaults: {
      limit: 20
    }
  },
  {
    templateId: "order_dead_letter_batch_requeue",
    name: "Order Dead-Letter Requeue",
    description: "批量重入队 dead-letter 的订单恢复任务。",
    permission: "ops.ledger.execute",
    action: "trading.recovery.dead_letter.batch_requeue",
    targetType: "spot_recovery_dead_letter_batch",
    defaults: {
      market: DEFAULT_TRADE_MARKET,
      limit: 20
    }
  },
  {
    templateId: "settlement_recovery_batch_process",
    name: "Settlement Recovery Batch",
    description: "批量处理待恢复的交易结算任务。",
    permission: "ops.ledger.execute",
    action: "settlement.recovery.process_pending",
    targetType: "trade_settlement_recovery_queue",
    defaults: {
      limit: 20
    }
  },
  {
    templateId: "trade_domain_recovery_sweep",
    name: "Trade Domain Recovery Sweep",
    description: "串行执行订单恢复、结算恢复和可选 dead-letter 重入队。",
    permission: "ops.ledger.execute",
    action: "trading.runtime.recovery_sweep",
    targetType: "trade_runtime",
    defaults: {
      market: DEFAULT_TRADE_MARKET,
      orderRecoveryLimit: 20,
      settlementRecoveryLimit: 20,
      deadLetterRequeueLimit: 0
    }
  },
  {
    templateId: "trade_runtime_alert_delivery",
    name: "Trade Runtime Alert Delivery",
    description: "导出交易域运行告警并推送到外部 sink。",
    permission: "ops.alerts.manage",
    action: "alerts.trade_runtime.deliver",
    targetType: "trade_runtime_alerts",
    defaults: {
      market: DEFAULT_TRADE_MARKET,
      historyLimit: 10
    }
  },
  {
    templateId: "trade_event_stream_replay",
    name: "Trade Event Stream Replay",
    description: "从持久化成交事件流回放指定区间到实时通道。",
    permission: "ops.ledger.execute",
    action: "trading.event_bus.stream.replay",
    targetType: "trade_event_stream",
    defaults: {
      market: DEFAULT_TRADE_MARKET,
      limit: 20,
      publishToChannel: true,
      processSettlement: true
    }
  },
  {
    templateId: "trade_event_bus_self_heal",
    name: "Trade Event Bus Self-Heal",
    description: "按 lag SLO 自动执行 replay、subscriber process、trim 和告警投递。",
    permission: "ops.ledger.execute",
    action: "trading.event_bus.self_heal",
    targetType: "trade_event_stream",
    defaults: {
      market: DEFAULT_TRADE_MARKET,
      replayLimit: 50,
      overlapCount: 5,
      publishToChannel: true,
      trim: true,
      deliverAlerts: true
    }
  }
] as const;

const EXECUTION_SCHEDULES = EXECUTION_SCHEDULE_MARKETS.flatMap((market) => [
  {
    scheduleId: `trade_domain_recovery_sweep:${market.toLowerCase()}`,
    templateId: "trade_domain_recovery_sweep",
    market,
    intervalMinutes: 15,
    overdueAfterMinutes: 20,
    payload: {
      market,
      orderRecoveryLimit: 20,
      settlementRecoveryLimit: 20,
      deadLetterRequeueLimit: 0
    }
  },
  {
    scheduleId: `trade_runtime_alert_delivery:${market.toLowerCase()}`,
    templateId: "trade_runtime_alert_delivery",
    market,
    intervalMinutes: 10,
    overdueAfterMinutes: 15,
    payload: {
      market,
      historyLimit: 10
    }
  },
  {
    scheduleId: `trade_event_bus_self_heal:${market.toLowerCase()}`,
    templateId: "trade_event_bus_self_heal",
    market,
    intervalMinutes: 5,
    overdueAfterMinutes: 10,
    payload: {
      market,
      replayLimit: 50,
      overlapCount: 5,
      publishToChannel: true,
      trim: true,
      deliverAlerts: true
    }
  }
]) as Array<{
  scheduleId: string;
  templateId: (typeof EXECUTION_TEMPLATES)[number]["templateId"];
  market: string;
  intervalMinutes: number;
  overdueAfterMinutes: number;
  payload: Record<string, unknown>;
}>;

const OPS_MODULES = [
  {
    moduleId: "identity-service",
    title: "Identity Service",
    domain: "Access & user security",
    summary: "用户搜索、冻结/解冻、ops session 与权限来源。",
    panelTarget: "search-panel",
    focusTarget: "users-form"
  },
  {
    moduleId: "api-gateway",
    title: "API Gateway",
    domain: "Customer edge",
    summary: "统一鉴权、session/API Key 入口与私有实时通道说明。",
    panelTarget: "modules-panel",
    focusTarget: "module-card-api-gateway"
  },
  {
    moduleId: "wallet-service",
    title: "Wallet Service",
    domain: "Funding",
    summary: "充值地址、提币记录、通知与审核联动。",
    panelTarget: "feed-panel",
    focusTarget: "notifications-body"
  },
  {
    moduleId: "blockchain-indexer",
    title: "Blockchain Indexer",
    domain: "Chain observer",
    summary: "链上观测、确认推进、pending deposit 收敛。",
    panelTarget: "alerts-panel",
    focusTarget: "pending-deposits-body"
  },
  {
    moduleId: "custody-adapter",
    title: "Custody Adapter",
    domain: "Broadcast & custody",
    summary: "托管 provider 健康、广播记录和运行态。",
    panelTarget: "custody-panel",
    focusTarget: "custody-overview"
  },
  {
    moduleId: "ledger-service",
    title: "Ledger Service",
    domain: "Double-entry ledger",
    summary: "余额、冻结、对账、replay 与 journal 基线。",
    panelTarget: "reconciliation-panel",
    focusTarget: "reconciliation-body"
  },
  {
    moduleId: "risk-service",
    title: "Risk Service",
    domain: "Pre-trade validation",
    summary: "下单前规则命中、限价保护、余额预校验，以及市场暂停/恢复（市场管理页）。",
    panelTarget: "modules-panel",
    focusTarget: "module-card-risk-service"
  },
  {
    moduleId: "order-service",
    title: "Order Service",
    domain: "Order lifecycle",
    summary: "订单状态机、recovery queue 与 dead-letter 治理。",
    panelTarget: "search-panel",
    focusTarget: "spot-orders-body"
  },
  {
    moduleId: "matching-engine",
    title: "Matching Engine",
    domain: "Execution core",
    summary: "订单簿回放、撮合结果和 execution sequence 观察。",
    panelTarget: "reconciliation-panel",
    focusTarget: "trade-runtime-report"
  },
  {
    moduleId: "settlement-service",
    title: "Settlement Service",
    domain: "Post-trade accounting",
    summary: "成交结算、手续费入账、recovery jobs。",
    panelTarget: "search-panel",
    focusTarget: "spot-settlements-body"
  },
  {
    moduleId: "market-data-service",
    title: "Market Data Service",
    domain: "Public market data",
    summary: "行情快照、K 线与公共实时推送结果。",
    panelTarget: "modules-panel",
    focusTarget: "module-card-market-data-service"
  }
] as const;

const NOOP_ALERT_SINK_CLIENT: OpsAlertSinkClient = {
  async listTradeRuntimeAlertSinks() {
    return [];
  },
  async deliverTradeRuntimeAlerts() {
    return [];
  }
};


const DEFAULT_OPS_MARKET = DEFAULT_SPOT_MARKET;

export class OpsConsoleApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly marketClient?: OpsMarketClient;

  constructor(
    private readonly walletClient: OpsWalletClient,
    private readonly custodyClient: OpsCustodyClient,
    private readonly identityClient: OpsIdentityClient,
    private readonly ledgerClient: OpsLedgerClient,
    private readonly indexerClient: OpsIndexerClient,
    private readonly orderClient: OpsOrderClient,
    private readonly settlementClient: OpsSettlementClient,
    private readonly auditRepository: OpsActionAuditRepository,
    private readonly alertSinkClient: OpsAlertSinkClient = NOOP_ALERT_SINK_CLIENT,
    options: ApplicationOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }

        return `ops_${Date.now()}`;
      });
    this.marketClient = options.marketClient;
  }

  /**
   * Static market / asset catalog from config/markets.json, used by every ops
   * page that needs a market or asset dropdown (no hard-coded lists).
   */
  getMarketConfig() {
    return {
      defaultMarket: DEFAULT_SPOT_MARKET,
      markets: listSpotMarketDefinitions({ includeDelisted: true }).map((market) => ({
        market: market.market,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        configuredStatus: market.status
      })),
      assets: listAssetDefinitions().map((asset) => ({
        code: asset.code,
        name: asset.name,
        decimals: asset.decimals,
        networks: [...asset.networks]
      }))
    };
  }

  /**
   * 市场管理: every configured market with its effective status from risk-service.
   * If risk-service is unreachable the configured defaults are shown, flagged
   * with `statusSource: "config"`, so the page still renders.
   */
  async listMarkets() {
    const generatedAt = this.now().toISOString();
    const configured = listSpotMarketDefinitions({ includeDelisted: true });
    let live: Record<string, unknown>[] | null = null;
    let statusError: string | null = null;
    if (this.marketClient) {
      try {
        live = await this.marketClient.listMarkets();
      } catch (error) {
        statusError = readErrorMessage(error);
      }
    } else {
      statusError = "risk-service market client is not configured";
    }
    const liveByMarket = new Map((live ?? []).map((item) => [String(item.market), item]));

    return {
      generatedAt,
      defaultMarket: DEFAULT_SPOT_MARKET,
      statusSource: live ? "risk-service" : "config",
      statusError,
      markets: configured.map((definition) => {
        const item = liveByMarket.get(definition.market);
        return {
          market: definition.market,
          baseAsset: definition.baseAsset,
          quoteAsset: definition.quoteAsset,
          configuredStatus: definition.status,
          status: typeof item?.status === "string" ? item.status : definition.status,
          override: item?.override ?? null,
          priceStep: definition.priceStep,
          quantityStep: definition.quantityStep,
          minQuantity: definition.minQuantity,
          makerFeeRate: definition.makerFeeRate,
          takerFeeRate: definition.takerFeeRate,
          maxPriceDeviationRatio: definition.maxPriceDeviationRatio,
          referencePrice: definition.referencePrice,
          simulatorEnabled: definition.simulator.enabled
        };
      })
    };
  }

  /** Halt (`halted`) or resume (`listed`) a market; audited like every other ops action. */
  async setMarketStatus(session: OpsSessionInfo, command: OpsSetMarketStatusCommand) {
    if (!listSpotMarkets({ includeDelisted: true }).includes(command.market)) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, `Unknown market ${command.market}`);
    }
    if (command.status !== "listed" && command.status !== "halted") {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "status must be listed or halted");
    }
    const reason = command.reason?.trim();
    if (command.status === "halted" && !reason) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "A reason is required to halt a market");
    }
    const marketClient = this.marketClient;
    if (!marketClient) {
      throw new OpsConsoleError("RISK_UPSTREAM_FAILED", 503, "risk-service market client is not configured");
    }
    return this.runAuditedAction(
      {
        session,
        permission: "ops.markets.manage",
        action: command.status === "halted" ? "market.halt" : "market.resume",
        targetType: "spot_market",
        targetId: command.market,
        requestPayload: { status: command.status, reason }
      },
      () =>
        marketClient.setMarketStatus({
          market: command.market,
          status: command.status,
          reason,
          operator: session.email ?? session.userId
        })
    );
  }

  async login(command: OpsLoginCommand): Promise<OpsSession> {
    return this.identityClient.login(command);
  }

  async getCurrentSession(token: string): Promise<OpsSessionInfo> {
    return this.identityClient.getCurrentSession(token);
  }

  async logout(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.identityClient.logout(token);
  }

  async getDashboard(query: {
    network?: string;
    reviewQueueLimit?: number;
    notificationsLimit?: number;
  }) {
    const [reviewQueue, notifications, custodyOverview, providerHealth] = await Promise.all([
      this.walletClient.listWithdrawalReviewQueue({
        network: query.network,
        limit: query.reviewQueueLimit ?? 20,
        offset: 0
      }),
      this.walletClient.listNotifications({
        status: "pending",
        limit: query.notificationsLimit ?? 20,
        offset: 0
      }),
      this.custodyClient.getOpsOverview(),
      this.custodyClient.getProviderHealth()
    ]);

    return {
      generatedAt: this.now().toISOString(),
      withdrawalReviewQueue: reviewQueue,
      pendingNotifications: notifications,
      custody: {
        overview: custodyOverview,
        providerHealth
      }
    };
  }

  async listUsers(query: OpsUserQuery) {
    return this.identityClient.listUsers(query);
  }

  async freezeUser(session: OpsSessionInfo, command: OpsFreezeUserCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.users.freeze",
        action: "user.freeze",
        targetType: "user",
        targetId: command.userId,
        requestPayload: {
          reason: command.reason
        }
      },
      () => this.identityClient.freezeUser(command)
    );
  }

  async unfreezeUser(session: OpsSessionInfo, userId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.users.freeze",
        action: "user.unfreeze",
        targetType: "user",
        targetId: userId
      },
      () => this.identityClient.unfreezeUser(userId)
    );
  }

  // M4-4: KYC review. Every decision goes through the ops action audit log
  // and identity additionally appends a KYC event (from / to tier, actor).
  async getUserKycProfile(userId: string) {
    return this.identityClient.getKycProfile(userId);
  }

  async listKycRequests(query: OpsKycRequestQuery) {
    return this.identityClient.listKycRequests(query);
  }

  async approveKycRequest(session: OpsSessionInfo, command: OpsReviewKycRequestCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.users.manage",
        action: "user.kyc.approve",
        targetType: "kyc_request",
        targetId: command.requestId,
        requestPayload: { tier: command.tier, note: command.note }
      },
      () => this.identityClient.approveKycRequest(command)
    );
  }

  async rejectKycRequest(session: OpsSessionInfo, command: OpsReviewKycRequestCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.users.manage",
        action: "user.kyc.reject",
        targetType: "kyc_request",
        targetId: command.requestId,
        requestPayload: { note: command.note }
      },
      () => this.identityClient.rejectKycRequest(command)
    );
  }

  async setUserKycTier(session: OpsSessionInfo, command: OpsSetKycTierCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.users.manage",
        action: "user.kyc.set_tier",
        targetType: "user",
        targetId: command.userId,
        requestPayload: { tier: command.tier, reason: command.reason }
      },
      () => this.identityClient.setKycTier(command)
    );
  }

  async listBalances(query: OpsBalanceQuery) {
    return this.ledgerClient.listBalances(query);
  }

  async listDeposits(query: OpsDepositQuery) {
    return this.walletClient.listDeposits(query);
  }

  async listWithdrawalReviewQueue(query: OpsReviewQueueQuery) {
    return this.walletClient.listWithdrawalReviewQueue(query);
  }

  async listWithdrawals(query: OpsWithdrawalQuery) {
    return this.walletClient.listWithdrawals(query);
  }

  async getWithdrawalDetail(
    withdrawalId: string,
    auditLogQuery: OpsWithdrawalAuditLogQuery = {}
  ) {
    const [withdrawal, auditLogs] = await Promise.all([
      this.walletClient.getWithdrawal(withdrawalId),
      this.walletClient.listWithdrawalAuditLogs(withdrawalId, auditLogQuery)
    ]);

    if (!withdrawal) {
      throw new OpsConsoleError(
        "RESOURCE_NOT_FOUND",
        404,
        `Withdrawal ${withdrawalId} not found`
      );
    }

    const custodyTransferId = getOptionalString(withdrawal.custodyRequestId);
    const custodyTransfer = custodyTransferId
      ? await this.custodyClient.getTransfer(custodyTransferId)
      : null;

    return {
      withdrawal,
      auditLogs,
      custodyTransfer
    };
  }

  async approveWithdrawal(session: OpsSessionInfo, command: OpsApproveWithdrawalCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.withdrawals.review",
        action: "withdrawal.approve",
        targetType: "withdrawal",
        targetId: command.withdrawalId,
        requestPayload: {
          reviewedBy: command.reviewedBy,
          note: command.note
        }
      },
      () => this.walletClient.approveWithdrawal(command)
    );
  }

  async rejectWithdrawal(session: OpsSessionInfo, command: OpsRejectWithdrawalCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.withdrawals.review",
        action: "withdrawal.reject",
        targetType: "withdrawal",
        targetId: command.withdrawalId,
        requestPayload: {
          reviewedBy: command.reviewedBy,
          reason: command.reason
        }
      },
      () => this.walletClient.rejectWithdrawal(command)
    );
  }

  async batchApproveWithdrawals(
    session: OpsSessionInfo,
    command: OpsBatchApproveWithdrawalsCommand
  ) {
    const batchId = this.createId();
    const withdrawalIds = dedupeIds(command.withdrawalIds);
    const items = [];

    for (const withdrawalId of withdrawalIds) {
      try {
        const result = await this.runAuditedAction(
          {
            session,
            permission: "ops.withdrawals.batch_review",
            action: "withdrawal.approve",
            targetType: "withdrawal",
            targetId: withdrawalId,
            requestPayload: {
              reviewedBy: command.reviewedBy,
              note: command.note,
              batchId
            }
          },
          () =>
            this.walletClient.approveWithdrawal({
              withdrawalId,
              reviewedBy: command.reviewedBy,
              note: command.note
            }),
          batchId
        );

        items.push({
          withdrawalId,
          status: "succeeded",
          result
        });
      } catch (error) {
        items.push({
          withdrawalId,
          status: "failed",
          errorCode: readErrorCode(error),
          errorMessage: readErrorMessage(error)
        });
      }
    }

    return this.finalizeBatchSummary(
      session,
      {
        batchId,
        permission: "ops.withdrawals.batch_review",
        action: "withdrawal.batch_approve",
        targetType: "withdrawal_batch",
        requestPayload: {
          withdrawalIds,
          reviewedBy: command.reviewedBy,
          note: command.note
        }
      },
      "withdrawalId",
      items
    );
  }

  async batchRejectWithdrawals(
    session: OpsSessionInfo,
    command: OpsBatchRejectWithdrawalsCommand
  ) {
    const batchId = this.createId();
    const withdrawalIds = dedupeIds(command.withdrawalIds);
    const items = [];

    for (const withdrawalId of withdrawalIds) {
      try {
        const result = await this.runAuditedAction(
          {
            session,
            permission: "ops.withdrawals.batch_review",
            action: "withdrawal.reject",
            targetType: "withdrawal",
            targetId: withdrawalId,
            requestPayload: {
              reviewedBy: command.reviewedBy,
              reason: command.reason,
              batchId
            }
          },
          () =>
            this.walletClient.rejectWithdrawal({
              withdrawalId,
              reviewedBy: command.reviewedBy,
              reason: command.reason
            }),
          batchId
        );

        items.push({
          withdrawalId,
          status: "succeeded",
          result
        });
      } catch (error) {
        items.push({
          withdrawalId,
          status: "failed",
          errorCode: readErrorCode(error),
          errorMessage: readErrorMessage(error)
        });
      }
    }

    return this.finalizeBatchSummary(
      session,
      {
        batchId,
        permission: "ops.withdrawals.batch_review",
        action: "withdrawal.batch_reject",
        targetType: "withdrawal_batch",
        requestPayload: {
          withdrawalIds,
          reviewedBy: command.reviewedBy,
          reason: command.reason
        }
      },
      "withdrawalId",
      items
    );
  }

  async listWithdrawalAuditLogs(
    withdrawalId: string,
    query: OpsWithdrawalAuditLogQuery
  ) {
    return this.walletClient.listWithdrawalAuditLogs(withdrawalId, query);
  }

  async searchWithdrawalAuditLogs(query: OpsWithdrawalAuditLogQuery) {
    return this.walletClient.searchWithdrawalAuditLogs(query);
  }

  async listActionAuditLogs(query: OpsActionAuditLogQuery) {
    return this.auditRepository.list({
      ...query,
      limit: normalizeLimit(query.limit),
      offset: normalizeOffset(query.offset)
    });
  }

  async listWithdrawalAddressBook(query: OpsWithdrawalAddressBookQuery) {
    return this.walletClient.listWithdrawalAddressBook(query);
  }

  async whitelistWithdrawalAddress(session: OpsSessionInfo, addressBookId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.address_book.manage",
        action: "address_book.whitelist",
        targetType: "address_book",
        targetId: addressBookId
      },
      () => this.walletClient.whitelistWithdrawalAddress(addressBookId)
    );
  }

  async unwhitelistWithdrawalAddress(session: OpsSessionInfo, addressBookId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.address_book.manage",
        action: "address_book.unwhitelist",
        targetType: "address_book",
        targetId: addressBookId
      },
      () => this.walletClient.unwhitelistWithdrawalAddress(addressBookId)
    );
  }

  async listNotifications(query: OpsNotificationQuery) {
    return this.walletClient.listNotifications(query);
  }

  async listSpotOrders(query: OpsSpotOrderQuery) {
    return this.orderClient.listSpotOrders(query);
  }

  async listSpotTrades(query: OpsSpotTradeQuery) {
    return this.orderClient.listSpotTrades(query);
  }

  async listTradeSettlements(query: OpsTradeSettlementQuery) {
    return this.settlementClient.listTradeSettlements(query);
  }

  async getTradeSettlementReport(query: OpsTradeSettlementQuery) {
    return this.settlementClient.getTradeSettlementReport(query);
  }

  async listTradeSettlementRecoveryJobs(query: OpsTradeSettlementRecoveryJobQuery) {
    return this.settlementClient.listTradeSettlementRecoveryJobs(query);
  }

  async getTradeSettlementRecoveryGovernanceReport() {
    return this.settlementClient.getTradeSettlementRecoveryGovernanceReport();
  }

  async listTradeSettlementAutomationExecutions(query: OpsAutomationExecutionQuery) {
    return this.settlementClient.listAutomationExecutions(query);
  }

  // Book-level views are per market; default to the standard demo market.
  async getTradeOpsOverview(query: OpsTradeOpsQuery) {
    return this.orderClient.getTradeOpsOverview({ ...query, market: query.market ?? DEFAULT_OPS_MARKET });
  }

  async getTradeOpsAnomalies(query: OpsTradeOpsQuery) {
    return this.orderClient.getTradeOpsAnomalies({ ...query, market: query.market ?? DEFAULT_OPS_MARKET });
  }

  async getTradeRecoveryMetrics() {
    return this.orderClient.getRecoveryMetrics();
  }

  async getTradeRecoveryGovernanceReport() {
    return this.orderClient.getRecoveryGovernanceReport();
  }

  async getTradeDeadLetterReport(query: OpsTradeDeadLetterReportQuery) {
    return this.orderClient.getDeadLetterReport(query);
  }

  async listTradeAutomationExecutions(query: OpsAutomationExecutionQuery) {
    return this.orderClient.listAutomationExecutions(query);
  }

  async listTradeRecoveryJobs(query: OpsSpotRecoveryJobQuery) {
    return this.orderClient.listRecoveryJobs(query);
  }

  async listTradeDeadLetterJobs(query: OpsSpotRecoveryJobQuery) {
    return this.orderClient.listDeadLetterJobs({
      ...query,
      deadLettered: true
    });
  }

  async listTradeEventStreamEntries(query: OpsTradeEventStreamQuery) {
    return this.orderClient.listTradeEventStreamEntries(query);
  }

  async getTradeRuntimeReport(rawQuery: OpsTradeRuntimeReportQuery) {
    const query = { ...rawQuery, market: rawQuery.market ?? DEFAULT_OPS_MARKET };
    const historyLimit = normalizeLimit(query.historyLimit ?? 10);
    const [
      overview,
      anomalies,
      recentTrades,
      orderEventBus,
      recoveryMetrics,
      recoveryGovernance,
      deadLetterReport,
      orderAutomationExecutions,
      settlementReport,
      settlementRecoveryJobs,
      settlementEventBus,
      settlementRecoveryGovernance,
      settlementAutomationExecutions,
      templates,
      schedules,
      historyDiff
    ] = await Promise.all([
      this.getTradeOpsOverview({ market: query.market }),
      this.getTradeOpsAnomalies({ market: query.market }),
      this.listSpotTrades({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.orderClient.getTradeEventBusReport(),
      this.getTradeRecoveryMetrics(),
      this.getTradeRecoveryGovernanceReport(),
      this.getTradeDeadLetterReport({
        market: query.market,
        limit: historyLimit,
        templateLimit: 5
      }),
      this.listTradeAutomationExecutions({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.getTradeSettlementReport({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.listTradeSettlementRecoveryJobs({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.settlementClient.getTradeEventBusReport({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.getTradeSettlementRecoveryGovernanceReport(),
      this.listTradeSettlementAutomationExecutions({
        market: query.market,
        limit: historyLimit,
        offset: 0
      }),
      this.listExecutionTemplates(),
      this.listExecutionSchedules({
        market: query.market,
        limit: historyLimit
      }),
      this.getExecutionHistoryDiff({
        templateId: "trade_domain_recovery_sweep",
        targetId: query.market,
        limit: 5
      })
    ]);

    const latestStreamHead = getLatestStreamHead(
      readStreamHeads(orderEventBus),
      query.market
    );

    return {
      generatedAt: this.now().toISOString(),
      market: query.market,
      order: {
        overview,
        anomalies,
        trades: recentTrades,
        recoveryMetrics,
        recoveryGovernance,
        deadLetterReport,
        automationExecutions: orderAutomationExecutions
      },
      settlement: {
        report: settlementReport,
        recoveryJobs: settlementRecoveryJobs,
        eventBus: settlementEventBus,
        recoveryGovernance: settlementRecoveryGovernance,
        automationExecutions: settlementAutomationExecutions
      },
      eventBus: {
        publisher: orderEventBus,
        latestExecutionSequence:
          getOptionalNumber(latestStreamHead?.latestExecutionSequence) ??
          getLatestExecutionSequence(recentTrades),
        latestReplayCursor:
          getOptionalString(latestStreamHead?.latestReplayCursor) ??
          getLatestReplayCursor(recentTrades)
      },
      schedules,
      historyDiff,
      templates
    };
  }

  async getTradeRuntimeDrilldown(rawQuery: OpsTradeRuntimeDrilldownQuery) {
    const query = { ...rawQuery, market: rawQuery.market ?? DEFAULT_OPS_MARKET };
    const historyLimit = normalizeLimit(query.historyLimit ?? 10);
    const checkpointLimit = normalizeLimit(query.checkpointLimit ?? 20);
    const [runtimeReport, streamEntries, checkpoints, sinks, alertDeliveries] = await Promise.all([
      this.getTradeRuntimeReport(query),
      this.orderClient.listTradeEventStreamEntries({
        market: query.market,
        direction: "backward",
        limit: normalizeLimit(query.streamLimit ?? 20)
      }),
      this.settlementClient.listTradeEventConsumerCheckpoints({
        market: query.market,
        limit: checkpointLimit,
        offset: 0
      }),
      this.alertSinkClient.listTradeRuntimeAlertSinks(),
      this.auditRepository.list({
        action: "alerts.trade_runtime.deliver",
        targetId: query.market,
        limit: historyLimit,
        offset: 0
      })
    ]);
    const latestStreamHead = getLatestStreamHead(
      readStreamHeads((runtimeReport as { eventBus?: { publisher?: Record<string, unknown> } }).eventBus?.publisher),
      query.market
    );
    const latestArchiveHead = getLatestArchiveHead(
      readArchiveHeads((runtimeReport as { eventBus?: { publisher?: Record<string, unknown> } }).eventBus?.publisher),
      query.market
    );
    const checkpointLag = checkpoints.map((checkpoint) => ({
      ...checkpoint,
      executionSequenceLag:
        latestStreamHead && getOptionalNumber(checkpoint.lastExecutionSequence) !== undefined
          ? Math.max(
              (getOptionalNumber(latestStreamHead.latestExecutionSequence) ?? 0) -
                (getOptionalNumber(checkpoint.lastExecutionSequence) ?? 0),
              0
            )
          : undefined,
      streamUpToDate:
        getOptionalString(checkpoint.lastStreamEntryId) !== undefined &&
        getOptionalString(checkpoint.lastStreamEntryId) ===
          getOptionalString(latestStreamHead?.latestStreamEntryId)
    }));

    return {
      generatedAt: this.now().toISOString(),
      market: query.market,
      runtimeReport,
      eventBus: {
        latestStreamHead,
        latestArchiveHead,
        checkpoints: checkpointLag,
        recentStreamEntries: streamEntries
      },
      alerting: {
        sinks,
        recentDeliveries: alertDeliveries.items
      }
    };
  }

  async listTradeRuntimeAlertSinks() {
    return this.alertSinkClient.listTradeRuntimeAlertSinks();
  }

  async replayTradeEngineBook(session: OpsSessionInfo, command: OpsTradeOpsQuery) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.engine.replay",
        targetType: "spot_market",
        targetId: command.market,
        requestPayload: sanitizeRecord(command)
      },
      () => this.orderClient.replayEngineBook(command)
    );
  }

  async replayTradeEventStream(
    session: OpsSessionInfo,
    command: OpsReplayTradeEventStreamCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.event_bus.stream.replay",
        targetType: "trade_event_stream",
        targetId: command.market,
        requestPayload: sanitizeRecord(command)
      },
      async () => {
        const replay = await this.orderClient.replayTradeEventStream(command);
        const settlementProcessing = command.processSettlement
          ? await this.settlementClient.processTradeEventSubscriptionCycle({
              market: command.market,
              allowGap: command.allowGap,
              afterStreamEntryId: command.afterStreamEntryId,
              limit: command.limit,
              overlapCount: command.overlapCount
            })
          : undefined;

        return {
          replay,
          settlementProcessing
        };
      }
    );
  }

  async trimTradeEventStream(
    session: OpsSessionInfo,
    command: OpsTrimTradeEventStreamCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.event_bus.stream.trim",
        targetType: "trade_event_stream",
        targetId: getOptionalString(command.market),
        requestPayload: sanitizeRecord(command)
      },
      () => this.orderClient.trimTradeEventStream(command)
    );
  }

  async maintainTradeEventStream(
    session: OpsSessionInfo,
    command: OpsMaintainTradeEventStreamCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.event_bus.stream.maintenance",
        targetType: "trade_event_stream",
        targetId: getOptionalString(command.market),
        requestPayload: sanitizeRecord(command)
      },
      () => this.orderClient.maintainTradeEventStream(command)
    );
  }

  async selfHealTradeEventBus(
    session: OpsSessionInfo,
    command: OpsSelfHealTradeEventBusCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.event_bus.self_heal",
        targetType: "trade_event_stream",
        targetId: command.market,
        requestPayload: sanitizeRecord(command)
      },
      async () => {
        const drilldown = (await this.getTradeRuntimeDrilldown({
          market: command.market,
          historyLimit: command.historyLimit ?? 10,
          streamLimit: Math.min(command.replayLimit ?? 20, 100),
          checkpointLimit: 20
        })) as {
          runtimeReport?: {
            eventBus?: { publisher?: Record<string, unknown> };
          };
          eventBus?: {
            latestStreamHead?: Record<string, unknown>;
            checkpoints?: Array<Record<string, unknown>>;
          };
        };
        const checkpoints = drilldown.eventBus?.checkpoints ?? [];
        const latestCheckpoint = getLatestCheckpoint(checkpoints);
        const maxLag = checkpoints.reduce((currentMax, checkpoint) => {
          return Math.max(currentMax, getOptionalNumber(checkpoint.executionSequenceLag) ?? 0);
        }, 0);
        const publisher = drilldown.runtimeReport?.eventBus?.publisher as
          | { operator?: Record<string, unknown>; stream?: Record<string, unknown> }
          | undefined;
        const lagSlo = readLagSlo(publisher?.operator);
        const lagThreshold = command.maxAcceptableLag ?? lagSlo.warning ?? 10;
        const shouldReplay = checkpoints.length === 0 || maxLag >= lagThreshold;
        const shouldTrim =
          command.trim !== false &&
          hasRetentionPressure(drilldown.eventBus?.latestStreamHead, publisher?.stream);

        const replay = shouldReplay
          ? await this.orderClient.replayTradeEventStream({
              market: command.market,
              afterStreamEntryId: getOptionalString(latestCheckpoint?.lastStreamEntryId),
              executionSequenceFrom:
                getOptionalNumber(latestCheckpoint?.lastExecutionSequence) !== undefined
                  ? (getOptionalNumber(latestCheckpoint?.lastExecutionSequence) ?? 0) + 1
                  : undefined,
              limit: command.replayLimit ?? Math.max(maxLag, 20),
              overlapCount: command.overlapCount ?? 5,
              direction: "forward",
              publishToChannel: command.publishToChannel !== false
            })
          : {
              skipped: true,
              reason: "lag_within_slo",
              lag: maxLag,
              lagThreshold
            };

        const settlementProcessing = shouldReplay
          ? await this.settlementClient.processTradeEventSubscriptionCycle({
              market: command.market,
              allowGap: command.allowGap,
              afterStreamEntryId: getOptionalString(latestCheckpoint?.lastStreamEntryId),
              limit: command.replayLimit ?? Math.max(maxLag, 20),
              overlapCount: command.overlapCount ?? 5
            })
          : {
              skipped: true,
              reason: "lag_within_slo"
            };

        const maintenance = shouldTrim
          ? await this.orderClient.maintainTradeEventStream({
              market: command.market,
              force: false
            })
          : {
              skipped: true,
              reason: "retention_within_policy"
            };

        const alertExport = await this.exportTradeRuntimeAlerts({
          market: command.market,
          historyLimit: command.historyLimit
        });
        const deliveries =
          command.deliverAlerts === false || alertExport.status === "ok"
            ? []
            : await this.alertSinkClient.deliverTradeRuntimeAlerts({
                market: command.market,
                sinkId: command.sinkId,
                payload: alertExport.export.payload as Record<string, unknown>
              });

        return {
          market: command.market,
          lag: {
            current: maxLag,
            threshold: lagThreshold,
            warning: lagSlo.warning,
            critical: lagSlo.critical
          },
          replay,
          settlementProcessing,
          maintenance,
          alerting: {
            status: alertExport.status,
            deliveredCount: deliveries.length,
            deliveries
          }
        };
      }
    );
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
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "settlement.event_bus.process_cycle",
        targetType: "trade_event_subscription",
        targetId: getOptionalString(command.market),
        requestPayload: sanitizeRecord(command)
      },
      () => this.settlementClient.processTradeEventSubscriptionCycle(command)
    );
  }

  async processTradeRecoveryJobs(
    session: OpsSessionInfo,
    command: OpsProcessRecoveryJobsCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.recovery.process_pending",
        targetType: "spot_recovery_queue",
        requestPayload: sanitizeRecord(command)
      },
      () => this.orderClient.processRecoveryJobs(command)
    );
  }

  async recoverTradeRecoveryJob(session: OpsSessionInfo, jobId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.recovery.recover_job",
        targetType: "spot_recovery_job",
        targetId: jobId
      },
      () => this.orderClient.recoverJob(jobId)
    );
  }

  async requeueTradeDeadLetterJob(session: OpsSessionInfo, jobId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.recovery.dead_letter.requeue_job",
        targetType: "spot_recovery_dead_letter",
        targetId: jobId
      },
      () => this.orderClient.requeueDeadLetterJob(jobId)
    );
  }

  async batchRequeueTradeDeadLetterJobs(
    session: OpsSessionInfo,
    command: { market?: string; limit?: number }
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "trading.recovery.dead_letter.batch_requeue",
        targetType: "spot_recovery_dead_letter_batch",
        requestPayload: sanitizeRecord(command)
      },
      () => this.orderClient.batchRequeueDeadLetterJobs(command)
    );
  }

  async processTradeSettlementRecoveryJobs(
    session: OpsSessionInfo,
    command: OpsProcessRecoveryJobsCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "settlement.recovery.process_pending",
        targetType: "trade_settlement_recovery_queue",
        requestPayload: sanitizeRecord(command)
      },
      () => this.settlementClient.processTradeSettlementRecoveryJobs(command)
    );
  }

  async recoverTradeSettlement(session: OpsSessionInfo, tradeId: string) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "settlement.recovery.recover_trade",
        targetType: "trade_settlement",
        targetId: tradeId
      },
      () => this.settlementClient.recoverTradeSettlement(tradeId)
    );
  }

  async listExecutionTemplates() {
    return EXECUTION_TEMPLATES.map((template) => ({
      ...template
    }));
  }

  async listModuleNavigation() {
    return OPS_MODULES.map((module) => ({
      ...module
    }));
  }

  async getBusinessTrace(query: OpsBusinessTraceQuery) {
    const normalized = {
      userId: getOptionalString(query.userId),
      accountId: getOptionalString(query.accountId),
      orderId: getOptionalString(query.orderId),
      tradeId: getOptionalString(query.tradeId),
      depositId: getOptionalString(query.depositId),
      withdrawalId: getOptionalString(query.withdrawalId),
      txHash: getOptionalString(query.txHash),
      market: getOptionalString(query.market),
      assetCode: getOptionalString(query.assetCode),
      limit: normalizeLimit(query.limit)
    };

    if (!hasBusinessTraceSelector(normalized)) {
      throw new OpsConsoleError(
        "VALIDATION_ERROR",
        400,
        "At least one trace selector is required."
      );
    }

    const baseLimit = normalized.limit;
    const [userResponse, balancesResponse, depositsResponse, withdrawalsResponse, reviewQueue, ordersResponse, tradesResponse, settlementsResponse, notificationsResponse, pendingDepositsResponse, withdrawalBundle] =
      await Promise.all([
        normalized.userId
          ? this.identityClient.listUsers({
              userId: normalized.userId,
              limit: 1,
              offset: 0
            })
          : Promise.resolve(null),
        this.ledgerClient.listBalances({
          userId: normalized.userId,
          accountId: normalized.accountId,
          assetCode: normalized.assetCode,
          limit: baseLimit,
          offset: 0
        }),
        this.walletClient.listDeposits({
          userId: normalized.userId,
          ledgerAccountId: normalized.accountId,
          assetCode: normalized.assetCode,
          txHash: normalized.txHash,
          limit: baseLimit,
          offset: 0
        }),
        this.walletClient.listWithdrawals({
          userId: normalized.userId,
          ledgerAccountId: normalized.accountId,
          assetCode: normalized.assetCode,
          txHash: normalized.txHash,
          limit: baseLimit,
          offset: 0
        }),
        this.walletClient.listWithdrawalReviewQueue({
          userId: normalized.userId,
          ledgerAccountId: normalized.accountId,
          assetCode: normalized.assetCode,
          txHash: normalized.txHash,
          limit: baseLimit,
          offset: 0
        }),
        this.orderClient.listSpotOrders({
          userId: normalized.userId,
          accountId: normalized.accountId,
          market: normalized.market,
          limit: baseLimit,
          offset: 0
        }),
        this.orderClient.listSpotTrades({
          userId: normalized.userId,
          market: normalized.market,
          orderId: normalized.orderId,
          limit: baseLimit,
          offset: 0
        }),
        this.settlementClient.listTradeSettlements({
          userId: normalized.userId,
          market: normalized.market,
          orderId: normalized.orderId,
          limit: baseLimit,
          offset: 0
        }),
        this.walletClient.listNotifications({
          userId: normalized.userId,
          withdrawalId: normalized.withdrawalId,
          limit: baseLimit,
          offset: 0
        }),
        this.indexerClient.listPendingDeposits({
          assetCode: normalized.assetCode,
          limit: baseLimit,
          offset: 0
        }),
        normalized.withdrawalId
          ? this.getWithdrawalDetail(normalized.withdrawalId, {
              limit: Math.min(baseLimit, 20),
              offset: 0
            })
          : Promise.resolve(null)
      ]);

    let user = userResponse?.items[0] ?? null;
    let balances = balancesResponse.items;
    let deposits = depositsResponse.items;
    let withdrawals = withdrawalsResponse.items;
    let notifications = notificationsResponse.items;
    let pendingDeposits = pendingDepositsResponse.items;
    let orders = ordersResponse;
    let trades = tradesResponse;
    let settlements = settlementsResponse;
    let focusWithdrawal = withdrawalBundle?.withdrawal ?? findTraceRecordById(withdrawals, ["withdrawalId"], normalized.withdrawalId);
    let focusWithdrawalAuditLogs = withdrawalBundle?.auditLogs?.items ?? [];
    let custodyTransfer = withdrawalBundle?.custodyTransfer ?? null;
    let focusDeposit = findTraceRecordById(deposits, ["depositId"], normalized.depositId);
    let focusOrder = findTraceRecordById(orders, ["orderId"], normalized.orderId);
    let focusTrade = findTraceRecordById(trades, ["tradeId"], normalized.tradeId);
    let focusSettlement = findTraceSettlement(settlements, {
      settlementId: readRecordString(focusTrade, "settlementId"),
      tradeId: normalized.tradeId ?? readRecordString(focusTrade, "tradeId"),
      orderId: normalized.orderId
    });

    if (!focusDeposit && normalized.txHash) {
      focusDeposit = findTraceRecordById(deposits, ["txHash"], normalized.txHash);
    }
    if (!focusWithdrawal && normalized.txHash) {
      focusWithdrawal = findTraceRecordById(withdrawals, ["txHash"], normalized.txHash);
    }
    if (!focusTrade && normalized.orderId) {
      focusTrade = findTraceRecordById(trades, ["orderId", "buyerOrderId", "sellerOrderId"], normalized.orderId);
    }
    if (!focusOrder && focusTrade) {
      focusOrder = findTraceRecordById(orders, ["orderId"], readFirstString([
        readRecordString(focusTrade, "orderId"),
        readRecordString(focusTrade, "buyerOrderId"),
        readRecordString(focusTrade, "sellerOrderId"),
        readRecordString(focusTrade, "makerOrderId"),
        readRecordString(focusTrade, "takerOrderId")
      ]));
    }
    if (!focusSettlement && focusTrade) {
      focusSettlement = findTraceSettlement(settlements, {
        settlementId: readRecordString(focusTrade, "settlementId"),
        tradeId: readRecordString(focusTrade, "tradeId"),
        orderId: readFirstString([
          readRecordString(focusTrade, "orderId"),
          readRecordString(focusTrade, "buyerOrderId"),
          readRecordString(focusTrade, "sellerOrderId")
        ])
      });
    }

    if (
      focusDeposit &&
      !findTraceRecordById(deposits, ["depositId"], readRecordString(focusDeposit, "depositId"))
    ) {
      deposits = [focusDeposit, ...deposits];
    }
    if (
      focusWithdrawal &&
      !findTraceRecordById(withdrawals, ["withdrawalId"], readRecordString(focusWithdrawal, "withdrawalId"))
    ) {
      withdrawals = [focusWithdrawal, ...withdrawals];
    }

    const inferredUserId = readFirstString([
      normalized.userId,
      readRecordString(user, "userId"),
      readRecordString(focusDeposit, "userId"),
      readRecordString(focusWithdrawal, "userId"),
      readRecordString(focusOrder, "userId"),
      readRecordString(focusTrade, "userId"),
      readRecordString(focusSettlement, "userId"),
      readRecordString(focusSettlement, "buyerUserId"),
      readRecordString(focusSettlement, "sellerUserId")
    ]);
    const inferredAccountId = readFirstString([
      normalized.accountId,
      readRecordString(focusDeposit, "ledgerAccountId", "accountId"),
      readRecordString(focusWithdrawal, "ledgerAccountId", "accountId"),
      readRecordString(focusOrder, "accountId"),
      readRecordString(focusTrade, "accountId", "buyerAccountId", "sellerAccountId"),
      readRecordString(focusSettlement, "accountId", "buyerAccountId", "sellerAccountId")
    ]);
    const inferredMarket = readFirstString([
      normalized.market,
      readRecordString(focusOrder, "market"),
      readRecordString(focusTrade, "market"),
      readRecordString(focusSettlement, "market")
    ]);
    const inferredAssetCode = readFirstString([
      normalized.assetCode,
      readRecordString(focusDeposit, "assetCode"),
      readRecordString(focusWithdrawal, "assetCode")
    ]);
    const inferredTxHash = readFirstString([
      normalized.txHash,
      readRecordString(focusDeposit, "txHash"),
      readRecordString(focusWithdrawal, "txHash")
    ]);

    if (!focusWithdrawal && normalized.withdrawalId === undefined && inferredTxHash) {
      focusWithdrawal = findTraceRecordById(withdrawals, ["txHash"], inferredTxHash);
    }
    if (!focusDeposit && normalized.depositId === undefined && inferredTxHash) {
      focusDeposit = findTraceRecordById(deposits, ["txHash"], inferredTxHash);
    }

    if (!user && inferredUserId) {
      const userFallback = await this.identityClient.listUsers({
        userId: inferredUserId,
        limit: 1,
        offset: 0
      });
      if (userFallback.items[0]) {
        user = userFallback.items[0];
        balances = balances.length
          ? balances
          : (
              await this.ledgerClient.listBalances({
                userId: inferredUserId,
                accountId: inferredAccountId,
                assetCode: inferredAssetCode,
                limit: baseLimit,
                offset: 0
              })
            ).items;
      }
    }

    if (inferredAccountId && balances.length === 0) {
      balances = (
        await this.ledgerClient.listBalances({
          userId: inferredUserId,
          accountId: inferredAccountId,
          assetCode: inferredAssetCode,
          limit: baseLimit,
          offset: 0
        })
      ).items;
    }

    if (inferredAccountId && deposits.length === 0) {
      deposits = (
        await this.walletClient.listDeposits({
          userId: inferredUserId,
          ledgerAccountId: inferredAccountId,
          assetCode: inferredAssetCode,
          txHash: inferredTxHash,
          limit: baseLimit,
          offset: 0
        })
      ).items;
      if (!focusDeposit && normalized.depositId) {
        focusDeposit = findTraceRecordById(deposits, ["depositId"], normalized.depositId);
      }
    }

    if (inferredAccountId && withdrawals.length === 0) {
      withdrawals = (
        await this.walletClient.listWithdrawals({
          userId: inferredUserId,
          ledgerAccountId: inferredAccountId,
          assetCode: inferredAssetCode,
          txHash: inferredTxHash,
          limit: baseLimit,
          offset: 0
        })
      ).items;
      if (!focusWithdrawal) {
        focusWithdrawal = findTraceRecordById(
          withdrawals,
          ["withdrawalId", "txHash"],
          normalized.withdrawalId ?? inferredTxHash
        );
      }
    }

    if (!focusOrder && normalized.orderId && (inferredUserId || inferredAccountId || inferredMarket)) {
      orders = await this.orderClient.listSpotOrders({
        userId: inferredUserId,
        accountId: inferredAccountId,
        market: inferredMarket,
        limit: baseLimit,
        offset: 0
      });
      focusOrder = findTraceRecordById(
        orders,
        ["orderId"],
        normalized.orderId
      );
    }

    if (!focusTrade && (normalized.tradeId || normalized.orderId) && (inferredUserId || inferredMarket)) {
      const tradeCandidates = await this.orderClient.listSpotTrades({
        userId: inferredUserId,
        market: inferredMarket,
        orderId: normalized.orderId ?? readRecordString(focusOrder, "orderId"),
        limit: baseLimit,
        offset: 0
      });
      focusTrade = findTraceRecordById(
        tradeCandidates,
        ["tradeId", "orderId", "buyerOrderId", "sellerOrderId"],
        normalized.tradeId ?? normalized.orderId
      );
      if (trades.length === 0) {
        trades = tradeCandidates;
      }
    }

    if (!focusSettlement && (focusTrade || normalized.orderId || inferredMarket)) {
      const settlementCandidates = await this.settlementClient.listTradeSettlements({
        userId: inferredUserId,
        market: inferredMarket,
        orderId: normalized.orderId ?? readRecordString(focusOrder, "orderId"),
        limit: baseLimit,
        offset: 0
      });
      focusSettlement = findTraceSettlement(settlementCandidates, {
        settlementId: readRecordString(focusTrade, "settlementId"),
        tradeId: normalized.tradeId ?? readRecordString(focusTrade, "tradeId"),
        orderId: normalized.orderId ?? readRecordString(focusOrder, "orderId")
      });
      if (settlements.length === 0) {
        settlements = settlementCandidates;
      }
    }

    if (focusWithdrawal && !withdrawalBundle) {
      const fallbackWithdrawalBundle = await this.getWithdrawalDetail(
        readRecordString(focusWithdrawal, "withdrawalId") ?? "",
        {
          limit: Math.min(baseLimit, 20),
          offset: 0
        }
      );
      custodyTransfer = fallbackWithdrawalBundle.custodyTransfer;
      focusWithdrawalAuditLogs = fallbackWithdrawalBundle.auditLogs.items;
      notifications = notifications.length
        ? notifications
        : (
            await this.walletClient.listNotifications({
              userId: inferredUserId,
              withdrawalId: readRecordString(focusWithdrawal, "withdrawalId"),
              limit: baseLimit,
              offset: 0
            })
          ).items;
    }

    if (notifications.length === 0 && focusWithdrawal) {
      notifications = (
        await this.walletClient.listNotifications({
          userId: inferredUserId,
          withdrawalId: readRecordString(focusWithdrawal, "withdrawalId"),
          limit: baseLimit,
          offset: 0
        })
      ).items;
    }

    if (pendingDeposits.length === 0 && (inferredAssetCode || inferredTxHash)) {
      pendingDeposits = (
        await this.indexerClient.listPendingDeposits({
          assetCode: inferredAssetCode,
          limit: baseLimit,
          offset: 0
        })
      ).items;
    }

    const indexerObservation = findTraceIndexerObservation(pendingDeposits, {
      txHash: inferredTxHash,
      assetCode: inferredAssetCode
    });
    const reviewQueueItem = findTraceRecordById(
      reviewQueue.items,
      ["withdrawalId", "txHash"],
      readFirstString([normalized.withdrawalId, inferredTxHash])
    );

    const traceBalances = prioritizeTraceRecords(
      balances,
      (item) =>
        matchesRecordValue(item, ["accountId"], inferredAccountId) ||
        matchesRecordValue(item, ["accountId"], readRecordString(focusSettlement, "buyerAccountId")) ||
        matchesRecordValue(item, ["accountId"], readRecordString(focusSettlement, "sellerAccountId")),
      8
    );

    const root = buildBusinessTraceRoot(normalized, {
      user,
      deposit: focusDeposit,
      withdrawal: focusWithdrawal,
      order: focusOrder,
      trade: focusTrade,
      settlement: focusSettlement
    });

    return {
      generatedAt: this.now().toISOString(),
      query: {
        ...normalized
      },
      root,
      inferred: {
        userId: inferredUserId,
        accountId: inferredAccountId,
        market: inferredMarket,
        assetCode: inferredAssetCode,
        txHash: inferredTxHash
      },
      entities: {
        user,
        deposit: focusDeposit,
        withdrawal: focusWithdrawal,
        reviewQueueItem,
        order: focusOrder,
        trade: focusTrade,
        settlement: focusSettlement,
        indexerObservation,
        custodyTransfer,
        balances: traceBalances,
        notifications: prioritizeTraceRecords(
          notifications,
          (item) =>
            matchesRecordValue(item, ["withdrawalId"], readRecordString(focusWithdrawal, "withdrawalId")) ||
            matchesRecordValue(item, ["userId"], inferredUserId),
          6
        ),
        withdrawalAuditLogs: focusWithdrawalAuditLogs
      },
      related: {
        deposits: prioritizeTraceRecords(
          deposits,
          (item) =>
            matchesRecordValue(item, ["depositId"], readRecordString(focusDeposit, "depositId")) ||
            matchesRecordValue(item, ["txHash"], inferredTxHash) ||
            matchesRecordValue(item, ["ledgerAccountId", "accountId"], inferredAccountId),
          5
        ),
        withdrawals: prioritizeTraceRecords(
          withdrawals,
          (item) =>
            matchesRecordValue(item, ["withdrawalId"], readRecordString(focusWithdrawal, "withdrawalId")) ||
            matchesRecordValue(item, ["txHash"], inferredTxHash) ||
            matchesRecordValue(item, ["ledgerAccountId", "accountId"], inferredAccountId),
          5
        ),
        orders: prioritizeTraceRecords(
          orders,
          (item) =>
            matchesRecordValue(item, ["orderId"], readRecordString(focusOrder, "orderId")) ||
            matchesRecordValue(item, ["accountId"], inferredAccountId),
          5
        ),
        trades: prioritizeTraceRecords(
          trades,
          (item) =>
            matchesRecordValue(item, ["tradeId"], readRecordString(focusTrade, "tradeId")) ||
            matchesRecordValue(item, ["orderId", "buyerOrderId", "sellerOrderId"], readRecordString(focusOrder, "orderId")),
          5
        ),
        settlements: prioritizeTraceRecords(
          settlements,
          (item) =>
            matchesRecordValue(item, ["settlementId"], readRecordString(focusSettlement, "settlementId")) ||
            matchesRecordValue(item, ["tradeId"], readRecordString(focusTrade, "tradeId")) ||
            matchesRecordValue(item, ["buyerOrderId", "sellerOrderId", "orderId"], readRecordString(focusOrder, "orderId")),
          5
        )
      },
      steps: buildBusinessTraceSteps({
        user,
        deposit: focusDeposit,
        withdrawal: focusWithdrawal,
        order: focusOrder,
        trade: focusTrade,
        settlement: focusSettlement,
        indexerObservation,
        custodyTransfer,
        reviewQueueItem,
        balances: traceBalances,
        notifications,
        auditLogs: focusWithdrawalAuditLogs
      })
    };
  }

  async listExecutionHistory(
    query: {
      templateId?: string;
      targetId?: string;
      status?: OpsActionAuditLogQuery["status"];
      limit?: number;
      offset?: number;
    }
  ) {
    const template = query.templateId
      ? EXECUTION_TEMPLATES.find((item) => item.templateId === query.templateId)
      : undefined;

    return this.auditRepository.list({
      action: template?.action,
      targetId: query.targetId,
      status: query.status,
      limit: normalizeLimit(query.limit),
      offset: normalizeOffset(query.offset)
    });
  }

  async executeExecutionTemplate(
    session: OpsSessionInfo,
    templateId: string,
    payload: Record<string, unknown>
  ) {
    switch (templateId) {
      case "order_recovery_batch_process":
        return this.processTradeRecoveryJobs(session, {
          limit: getOptionalNumber(payload.limit)
        });
      case "order_dead_letter_batch_requeue":
        return this.batchRequeueTradeDeadLetterJobs(session, {
          market: getOptionalString(payload.market),
          limit: getOptionalNumber(payload.limit)
        });
      case "settlement_recovery_batch_process":
        return this.processTradeSettlementRecoveryJobs(session, {
          limit: getOptionalNumber(payload.limit)
        });
      case "trade_domain_recovery_sweep":
        return this.runAuditedAction(
          {
            session,
            permission: "ops.ledger.execute",
            action: "trading.runtime.recovery_sweep",
            targetType: "trade_runtime",
            targetId: getOptionalString(payload.market),
            requestPayload: sanitizeRecord(payload)
          },
          async () => {
            const market = getOptionalString(payload.market);
            const deadLetterRequeueLimit = getOptionalNumber(payload.deadLetterRequeueLimit) ?? 0;
            const [orderRecovery, settlementRecovery] = await Promise.all([
              this.orderClient.processRecoveryJobs({
                limit: getOptionalNumber(payload.orderRecoveryLimit)
              }),
              this.settlementClient.processTradeSettlementRecoveryJobs({
                limit: getOptionalNumber(payload.settlementRecoveryLimit)
              })
            ]);

            const deadLetterRequeue =
              deadLetterRequeueLimit > 0
                ? await this.orderClient.batchRequeueDeadLetterJobs({
                    market,
                    limit: deadLetterRequeueLimit
                  })
                : {
                    skipped: true,
                    market,
                    requeuedCount: 0
                  };

            return {
              market,
              orderRecovery,
              settlementRecovery,
              deadLetterRequeue
            };
          }
        );
      case "trade_runtime_alert_delivery":
        return this.deliverTradeRuntimeAlerts(session, {
          market: getOptionalString(payload.market) ?? DEFAULT_TRADE_MARKET,
          historyLimit: getOptionalNumber(payload.historyLimit),
          sinkId: getOptionalString(payload.sinkId)
        });
      case "trade_event_stream_replay":
        return this.replayTradeEventStream(session, {
          market: getOptionalString(payload.market) ?? DEFAULT_TRADE_MARKET,
          afterStreamEntryId: getOptionalString(payload.afterStreamEntryId),
          fromStreamEntryId: getOptionalString(payload.fromStreamEntryId),
          toStreamEntryId: getOptionalString(payload.toStreamEntryId),
          executionSequenceFrom: getOptionalNumber(payload.executionSequenceFrom),
          limit: getOptionalNumber(payload.limit),
          overlapCount: getOptionalNumber(payload.overlapCount),
          direction:
            payload.direction === "backward" || payload.direction === "forward"
              ? payload.direction
              : undefined,
          processSettlement:
            typeof payload.processSettlement === "boolean"
              ? payload.processSettlement
              : false,
          allowGap:
            typeof payload.allowGap === "boolean"
              ? payload.allowGap
              : undefined,
          publishToChannel:
            typeof payload.publishToChannel === "boolean"
              ? payload.publishToChannel
              : true
        });
      case "trade_event_bus_self_heal":
        return this.selfHealTradeEventBus(session, {
          market: getOptionalString(payload.market) ?? DEFAULT_TRADE_MARKET,
          historyLimit: getOptionalNumber(payload.historyLimit),
          maxAcceptableLag: getOptionalNumber(payload.maxAcceptableLag),
          replayLimit: getOptionalNumber(payload.replayLimit),
          overlapCount: getOptionalNumber(payload.overlapCount),
          allowGap:
            typeof payload.allowGap === "boolean"
              ? payload.allowGap
              : undefined,
          publishToChannel:
            typeof payload.publishToChannel === "boolean"
              ? payload.publishToChannel
              : true,
          trim: typeof payload.trim === "boolean" ? payload.trim : true,
          deliverAlerts:
            typeof payload.deliverAlerts === "boolean"
              ? payload.deliverAlerts
              : true,
          sinkId: getOptionalString(payload.sinkId)
        });
      default:
        throw new OpsConsoleError(
          "RESOURCE_NOT_FOUND",
          404,
          `Execution template ${templateId} not found`
        );
    }
  }

  async listExecutionSchedules(query: OpsExecutionScheduleQuery = {}) {
    const now = this.now();
    const items = [];

    for (const schedule of EXECUTION_SCHEDULES) {
      if (query.scheduleId && schedule.scheduleId !== query.scheduleId) {
        continue;
      }
      if (query.market && schedule.market !== query.market) {
        continue;
      }

      const template = resolveExecutionTemplate(schedule.templateId);
      const history = await this.auditRepository.list({
        action: template.action,
        targetId: schedule.market,
        limit: 1,
        offset: 0
      });
      const lastRun = history.items[0];
      const dueAt = lastRun
        ? new Date(Date.parse(lastRun.completedAt) + schedule.intervalMinutes * 60_000)
        : now;
      const overdueAt = new Date(dueAt.getTime() + (schedule.overdueAfterMinutes - schedule.intervalMinutes) * 60_000);
      const status =
        overdueAt <= now ? "overdue" : dueAt <= now ? "due" : "scheduled";

      if (query.dueOnly && status === "scheduled") {
        continue;
      }

      items.push({
        ...schedule,
        templateName: template.name,
        action: template.action,
        lastRunAt: lastRun?.completedAt,
        lastStatus: lastRun?.status,
        dueAt: dueAt.toISOString(),
        overdueAt: overdueAt.toISOString(),
        status
      });
    }

    return items.slice(0, normalizeLimit(query.limit ?? items.length));
  }

  async runDueExecutionSchedules(
    command: OpsRunExecutionSchedulesCommand = {},
    session: OpsSessionInfo = createSchedulerSession()
  ) {
    const schedules = await this.listExecutionSchedules({
      scheduleId: command.scheduleId,
      dueOnly: !command.force,
      limit: command.limit
    });
    const executed = [];

    for (const schedule of schedules) {
      const result = await this.executeExecutionTemplate(
        session,
        schedule.templateId,
        schedule.payload
      );
      executed.push({
        scheduleId: schedule.scheduleId,
        templateId: schedule.templateId,
        market: schedule.market,
        status: "executed",
        result
      });
    }

    return {
      generatedAt: this.now().toISOString(),
      processedCount: schedules.length,
      executedCount: executed.length,
      skippedCount: 0,
      items: executed
    };
  }

  async getExecutionHistoryDiff(query: OpsExecutionHistoryDiffQuery) {
    const template = resolveExecutionTemplate(query.templateId);
    const history = await this.auditRepository.list({
      action: template.action,
      targetId: query.targetId,
      limit: Math.max(normalizeLimit(query.limit ?? 5), 2),
      offset: 0
    });
    const current = history.items[0];
    const previous = history.items[1];
    const currentMetrics = extractNumericMetrics(current?.responsePayload);
    const previousMetrics = extractNumericMetrics(previous?.responsePayload);
    const delta = diffNumericMetrics(currentMetrics, previousMetrics);
    const alerts = [];

    if (current?.status === "failed") {
      alerts.push("latest execution failed");
    }
    if ((currentMetrics.failedCount ?? 0) > 0) {
      alerts.push(`failedCount=${(currentMetrics.failedCount ?? 0).toString()} exceeds threshold 0`);
    }
    if ((currentMetrics["orderRecovery.failedCount"] ?? 0) > 0) {
      alerts.push(
        `orderRecovery.failedCount=${(currentMetrics["orderRecovery.failedCount"] ?? 0).toString()} exceeds threshold 0`
      );
    }
    if ((currentMetrics["settlementRecovery.failedCount"] ?? 0) > 0) {
      alerts.push(
        `settlementRecovery.failedCount=${(currentMetrics["settlementRecovery.failedCount"] ?? 0).toString()} exceeds threshold 0`
      );
    }

    return {
      generatedAt: this.now().toISOString(),
      templateId: query.templateId,
      targetId: query.targetId,
      current: current
        ? {
            auditLogId: current.auditLogId,
            status: current.status,
            completedAt: current.completedAt,
            metrics: currentMetrics
          }
        : undefined,
      previous: previous
        ? {
            auditLogId: previous.auditLogId,
            status: previous.status,
            completedAt: previous.completedAt,
            metrics: previousMetrics
          }
        : undefined,
      delta,
      alerts
    };
  }

  async deliverTradeRuntimeAlerts(
    session: OpsSessionInfo,
    command: OpsTradeRuntimeAlertDeliveryCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.alerts.manage",
        action: "alerts.trade_runtime.deliver",
        targetType: "trade_runtime_alerts",
        targetId: command.market,
        requestPayload: sanitizeRecord(command)
      },
      async () => {
        const exported = await this.exportTradeRuntimeAlerts({
          market: command.market,
          historyLimit: command.historyLimit
        });
        const deliveries = await this.alertSinkClient.deliverTradeRuntimeAlerts({
          market: command.market,
          sinkId: command.sinkId,
          payload: exported.export.payload as Record<string, unknown>
        });

        return {
          ...exported,
          deliveredCount: deliveries.length,
          deliveries
        };
      }
    );
  }

  async exportTradeRuntimeAlerts(query: OpsTradeRuntimeReportQuery) {
    const [runtimeReport, recentDeliveries] = await Promise.all([
      this.getTradeRuntimeReport(query),
      this.auditRepository.list({
        action: "alerts.trade_runtime.deliver",
        targetId: query.market,
        limit: normalizeLimit(query.historyLimit ?? 10),
        offset: 0
      })
    ]);
    const typedRuntimeReport = runtimeReport as {
      market: string;
      order: {
        deadLetterReport?: { totalJobs?: number };
        recoveryGovernance?: { expiredLeases?: unknown[]; orphanedLeases?: unknown[] };
      };
      settlement: {
        report?: {
          totals?: { pendingRecoveryCount?: number; failedCount?: number };
        };
        eventBus?: { checkpoints?: Array<Record<string, unknown>> };
        recoveryGovernance?: { expiredLeases?: unknown[]; orphanedLeases?: unknown[] };
      };
      eventBus?: {
        latestExecutionSequence?: number;
        latestReplayCursor?: string;
        publisher?: {
          operator?: Record<string, unknown>;
          stream?: Record<string, unknown>;
          versionGate?: { supportedProtocolVersions?: string[] };
        };
      };
      schedules?: Array<{ scheduleId: string; status: string; dueAt: string }>;
      historyDiff?: { alerts?: string[] };
    };
    const alerts: Array<{
      code: string;
      severity: "warning" | "critical";
      summary: string;
      detail?: Record<string, unknown>;
    }> = [];
    const lagSlo = readLagSlo(typedRuntimeReport.eventBus?.publisher?.operator);

    if ((typedRuntimeReport.order.deadLetterReport?.totalJobs ?? 0) > 0) {
      alerts.push({
        code: "ORDER_DEAD_LETTER_BACKLOG",
        severity: "warning",
        summary: `order dead-letter backlog=${typedRuntimeReport.order.deadLetterReport?.totalJobs?.toString() ?? "0"}`,
        detail: typedRuntimeReport.order.deadLetterReport as Record<string, unknown>
      });
    }

    if ((typedRuntimeReport.settlement.report?.totals?.pendingRecoveryCount ?? 0) > 0) {
      alerts.push({
        code: "SETTLEMENT_PENDING_RECOVERY",
        severity: "warning",
        summary: `settlement pendingRecoveryCount=${typedRuntimeReport.settlement.report?.totals?.pendingRecoveryCount?.toString() ?? "0"}`
      });
    }

    if ((typedRuntimeReport.settlement.report?.totals?.failedCount ?? 0) > 0) {
      alerts.push({
        code: "SETTLEMENT_FAILED",
        severity: "critical",
        summary: `settlement failedCount=${typedRuntimeReport.settlement.report?.totals?.failedCount?.toString() ?? "0"}`
      });
    }

    if ((typedRuntimeReport.order.recoveryGovernance?.expiredLeases?.length ?? 0) > 0) {
      alerts.push({
        code: "ORDER_RECOVERY_EXPIRED_LEASE",
        severity: "warning",
        summary: `order recovery expired leases=${typedRuntimeReport.order.recoveryGovernance?.expiredLeases?.length.toString()}`
      });
    }

    if ((typedRuntimeReport.settlement.recoveryGovernance?.expiredLeases?.length ?? 0) > 0) {
      alerts.push({
        code: "SETTLEMENT_RECOVERY_EXPIRED_LEASE",
        severity: "warning",
        summary: `settlement recovery expired leases=${typedRuntimeReport.settlement.recoveryGovernance?.expiredLeases?.length.toString()}`
      });
    }

    const latestCheckpoint = getLatestCheckpoint(typedRuntimeReport.settlement.eventBus?.checkpoints);
    const latestStreamHead = getLatestStreamHead(
      readStreamHeads(typedRuntimeReport.eventBus?.publisher),
      query.market
    );
    const currentLag =
      typeof typedRuntimeReport.eventBus?.latestExecutionSequence === "number"
        ? Math.max(
            typedRuntimeReport.eventBus.latestExecutionSequence -
              Number(latestCheckpoint?.lastExecutionSequence ?? 0),
            0
          )
        : undefined;
    if (
      typeof typedRuntimeReport.eventBus?.latestExecutionSequence === "number" &&
      (!latestCheckpoint ||
        Number(latestCheckpoint.lastExecutionSequence ?? -1) <
          typedRuntimeReport.eventBus.latestExecutionSequence)
    ) {
      alerts.push({
        code: "TRADE_EVENT_CONSUMER_LAG",
        severity:
          currentLag !== undefined &&
          lagSlo.critical !== undefined &&
          currentLag >= lagSlo.critical
            ? "critical"
            : "warning",
        summary: `latest settlement checkpoint lags publisher sequence ${typedRuntimeReport.eventBus.latestExecutionSequence.toString()}`,
        detail: {
          latestExecutionSequence: typedRuntimeReport.eventBus.latestExecutionSequence,
          latestReplayCursor: typedRuntimeReport.eventBus.latestReplayCursor,
          checkpoint: latestCheckpoint,
          lagSlo,
          currentLag
        }
      });
    }

    if (
      hasRetentionPressure(latestStreamHead, typedRuntimeReport.eventBus?.publisher?.stream) &&
      latestStreamHead
    ) {
      alerts.push({
        code: "TRADE_EVENT_STREAM_RETENTION_PRESSURE",
        severity: "warning",
        summary: `trade event stream ${query.market} is at retention pressure`,
        detail: {
          streamHead: latestStreamHead,
          retention: typedRuntimeReport.eventBus?.publisher?.stream
        }
      });
    }

    for (const schedule of typedRuntimeReport.schedules ?? []) {
      if (schedule.status === "scheduled") {
        continue;
      }

      alerts.push({
        code: "TRADE_RUNTIME_SCHEDULE_DUE",
        severity: schedule.status === "overdue" ? "critical" : "warning",
        summary: `${schedule.scheduleId} is ${schedule.status}`,
        detail: schedule as Record<string, unknown>
      });
    }

    for (const message of typedRuntimeReport.historyDiff?.alerts ?? []) {
      alerts.push({
        code: "TRADE_RUNTIME_EXECUTION_DIFF",
        severity: "warning",
        summary: message
      });
    }

    if (
      !(typedRuntimeReport.eventBus?.publisher?.versionGate?.supportedProtocolVersions ?? []).includes(
        "v2"
      )
    ) {
      alerts.push({
        code: "TRADE_EVENT_PROTOCOL_V2_UNSUPPORTED",
        severity: "critical",
        summary: "publisher version gate does not include v2"
      });
    }

    const maxSeverity = alerts.some((item) => item.severity === "critical")
      ? "critical"
      : alerts.length > 0
        ? "warning"
        : "info";
    const routing = deriveTradeRuntimeAlertRouting(
      alerts,
      recentDeliveries.items,
      this.now()
    );

    return {
      generatedAt: this.now().toISOString(),
      market: query.market,
      status: alerts.length > 0 ? "alert" : "ok",
      alertCount: alerts.length,
      // P1/P2/P3 next to the original warning / critical (domain/alert-severity.ts).
      alerts: alerts.map((alert) => ({ ...alert, level: tradeRuntimeAlertLevel(alert.code, alert.severity) })),
      routing,
      export: {
        source: "trade_runtime",
        format: "json",
        payload: {
          market: query.market,
          alertCount: alerts.length,
          maxSeverity,
          route: routing.route,
          escalationReason: routing.reason,
          consecutiveAlertWindows: routing.consecutiveAlertWindows,
          alertCodes: alerts.map((item) => item.code),
          alerts
        }
      }
    };
  }

  async getCustodyProviderHealth() {
    return this.custodyClient.getProviderHealth();
  }

  async runCustodyProviderHealthChecks(session: OpsSessionInfo) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.providers.manage",
        action: "custody.providers.health_check",
        targetType: "custody_provider"
      },
      () => this.custodyClient.runProviderHealthChecks()
    );
  }

  async getCustodyOpsOverview() {
    return this.custodyClient.getOpsOverview();
  }

  async getLedgerReconciliationReport(query: OpsLedgerReconciliationQuery) {
    return this.ledgerClient.getReconciliationReport(query);
  }

  async getLedgerReplayReport(query: OpsLedgerReplayQuery) {
    return this.ledgerClient.getReplayReport(query);
  }

  async getLedgerOpsOverview() {
    return this.ledgerClient.getOpsOverview();
  }

  async drainLedgerOutbox(session: OpsSessionInfo, command: OpsLedgerDrainOutboxCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.ledger.execute",
        action: "ledger.outbox.drain",
        targetType: "ledger_outbox",
        requestPayload: {
          requeueDeadLetter: command.requeueDeadLetter,
          maxCycles: command.maxCycles
        }
      },
      () => this.ledgerClient.drainOutbox(command)
    );
  }

  async getIndexerOpsOverview() {
    return this.indexerClient.getOpsOverview();
  }

  async replayIndexer(session: OpsSessionInfo, command: OpsIndexerReplayCommand) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.indexer.execute",
        action: "indexer.replay",
        targetType: "indexer_network",
        targetId: command.network,
        requestPayload: sanitizeRecord(command)
      },
      () => this.indexerClient.replay(command)
    );
  }

  async repairIndexerBacklog(
    session: OpsSessionInfo,
    command: OpsIndexerBacklogRepairCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.indexer.execute",
        action: "indexer.backlog_repair",
        targetType: "indexer_network",
        targetId: command.network,
        requestPayload: sanitizeRecord(command)
      },
      () => this.indexerClient.repairBacklog(command)
    );
  }

  async listIndexerPendingDeposits(query: OpsIndexerPendingDepositQuery) {
    return this.indexerClient.listPendingDeposits(query);
  }

  async replayIndexerPendingDeposit(
    session: OpsSessionInfo,
    command: OpsReplayPendingDepositCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.indexer.pending.manage",
        action: "indexer.pending_deposit.replay",
        targetType: "pending_deposit",
        targetId: command.observationId,
        requestPayload: sanitizeRecord(command)
      },
      () => this.indexerClient.replayPendingDeposit(command)
    );
  }

  async closeIndexerPendingDeposit(
    session: OpsSessionInfo,
    command: OpsClosePendingDepositCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.indexer.pending.manage",
        action: "indexer.pending_deposit.close",
        targetType: "pending_deposit",
        targetId: command.observationId,
        requestPayload: sanitizeRecord(command)
      },
      () => this.indexerClient.closePendingDeposit(command)
    );
  }

  async batchReplayIndexerPendingDeposits(
    session: OpsSessionInfo,
    command: OpsBatchReplayPendingDepositsCommand
  ) {
    const batchId = this.createId();
    const observationIds = dedupeIds(command.observationIds);
    const items = [];

    for (const observationId of observationIds) {
      try {
        const result = await this.runAuditedAction(
          {
            session,
            permission: "ops.indexer.pending.manage",
            action: "indexer.pending_deposit.replay",
            targetType: "pending_deposit",
            targetId: observationId,
            requestPayload: sanitizeRecord({
              ...command,
              observationId,
              batchId
            })
          },
          () =>
            this.indexerClient.replayPendingDeposit({
              observationId,
              confirmations: command.confirmations,
              blockNumber: command.blockNumber,
              blockHash: command.blockHash,
              operatedBy: command.operatedBy,
              note: command.note
            }),
          batchId
        );

        items.push({
          observationId,
          status: "succeeded",
          result
        });
      } catch (error) {
        items.push({
          observationId,
          status: "failed",
          errorCode: readErrorCode(error),
          errorMessage: readErrorMessage(error)
        });
      }
    }

    return this.finalizeBatchSummary(
      session,
      {
        batchId,
        permission: "ops.indexer.pending.manage",
        action: "indexer.pending_deposit.batch_replay",
        targetType: "pending_deposit_batch",
        requestPayload: sanitizeRecord(command)
      },
      "observationId",
      items
    );
  }

  async batchCloseIndexerPendingDeposits(
    session: OpsSessionInfo,
    command: OpsBatchClosePendingDepositsCommand
  ) {
    const batchId = this.createId();
    const observationIds = dedupeIds(command.observationIds);
    const items = [];

    for (const observationId of observationIds) {
      try {
        const result = await this.runAuditedAction(
          {
            session,
            permission: "ops.indexer.pending.manage",
            action: "indexer.pending_deposit.close",
            targetType: "pending_deposit",
            targetId: observationId,
            requestPayload: sanitizeRecord({
              ...command,
              observationId,
              batchId
            })
          },
          () =>
            this.indexerClient.closePendingDeposit({
              observationId,
              operatedBy: command.operatedBy,
              note: command.note
            }),
          batchId
        );

        items.push({
          observationId,
          status: "succeeded",
          result
        });
      } catch (error) {
        items.push({
          observationId,
          status: "failed",
          errorCode: readErrorCode(error),
          errorMessage: readErrorMessage(error)
        });
      }
    }

    return this.finalizeBatchSummary(
      session,
      {
        batchId,
        permission: "ops.indexer.pending.manage",
        action: "indexer.pending_deposit.batch_close",
        targetType: "pending_deposit_batch",
        requestPayload: sanitizeRecord(command)
      },
      "observationId",
      items
    );
  }

  async deliverNotifications(
    session: OpsSessionInfo,
    command: OpsWalletNotificationDeliveryCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.notifications.manage",
        action: "wallet.notifications.deliver",
        targetType: "wallet_notifications",
        requestPayload: sanitizeRecord(command)
      },
      () => this.walletClient.deliverNotifications(command)
    );
  }

  async reconcileStaleWithdrawals(
    session: OpsSessionInfo,
    command: OpsWalletStaleWithdrawalRepairCommand
  ) {
    return this.runAuditedAction(
      {
        session,
        permission: "ops.notifications.manage",
        action: "wallet.withdrawals.reconcile_stale",
        targetType: "wallet_withdrawals",
        requestPayload: sanitizeRecord(command)
      },
      () => this.walletClient.reconcileStaleWithdrawals(command)
    );
  }

  async getAlertsOverview() {
    const [ledger, indexer, custody, pendingNotifications, failedNotifications, reviewQueue] =
      await Promise.all([
        this.ledgerClient.getOpsOverview(),
        this.indexerClient.getOpsOverview(),
        this.custodyClient.getOpsOverview(),
        this.walletClient.listNotifications({
          status: "pending",
          limit: 1,
          offset: 0
        }),
        this.walletClient.listNotifications({
          status: "failed",
          limit: 1,
          offset: 0
        }),
        this.walletClient.listWithdrawalReviewQueue({
          limit: 1,
          offset: 0
        })
      ]);

    const walletAlerts: string[] = [];
    if (pendingNotifications.total > 20) {
      walletAlerts.push(
        `pending_notifications=${pendingNotifications.total} exceeds threshold 20`
      );
    }
    if (failedNotifications.total > 0) {
      walletAlerts.push(`failed_notifications=${failedNotifications.total} exceeds threshold 0`);
    }
    if (reviewQueue.total > 50) {
      walletAlerts.push(`review_queue=${reviewQueue.total} exceeds threshold 50`);
    }

    const sources = [
      normalizeAlertSource("ledger", ledger),
      normalizeAlertSource("indexer", indexer),
      normalizeAlertSource("custody", custody),
      {
        source: "wallet",
        status: walletAlerts.length > 0 ? "alert" : "ok",
        alerts: walletAlerts,
        summary: {
          pendingNotifications: pendingNotifications.total,
          failedNotifications: failedNotifications.total,
          reviewQueue: reviewQueue.total
        }
      }
    ];

    return {
      generatedAt: this.now().toISOString(),
      status: sources.some((source) => source.status === "alert") ? "alert" : "ok",
      alertCount: sources.reduce((count, source) => count + source.alerts.length, 0),
      sources
    };
  }

  /** Runs an operation and records it in the ops action audit log (also used by the fault lab). */
  async runAuditedAction<T>(
    options: AuditedActionOptions,
    operation: () => Promise<T>,
    batchId?: string
  ): Promise<T> {
    const startedAt = this.now().toISOString();

    try {
      const result = await operation();
      const completedAt = this.now().toISOString();
      await this.auditRepository.save({
        batchId,
        operator: options.session,
        permission: options.permission,
        action: options.action,
        targetType: options.targetType,
        targetId: options.targetId,
        requestPayload: options.requestPayload,
        responsePayload: sanitizeRecord(result),
        status: "succeeded",
        startedAt,
        completedAt
      });
      return result;
    } catch (error) {
      const completedAt = this.now().toISOString();
      await this.auditRepository.save({
        batchId,
        operator: options.session,
        permission: options.permission,
        action: options.action,
        targetType: options.targetType,
        targetId: options.targetId,
        requestPayload: options.requestPayload,
        responsePayload: undefined,
        status: "failed",
        errorCode: readErrorCode(error),
        errorMessage: readErrorMessage(error),
        startedAt,
        completedAt
      });
      throw error;
    }
  }

  private async finalizeBatchSummary(
    session: OpsSessionInfo,
    options: {
      batchId: string;
      permission: string;
      action: string;
      targetType: string;
      requestPayload?: Record<string, unknown>;
    },
    key: string,
    items: Array<Record<string, unknown>>
  ) {
    const succeededCount = items.filter((item) => item.status === "succeeded").length;
    const failedCount = items.length - succeededCount;
    const summary = {
      batchId: options.batchId,
      totalCount: items.length,
      succeededCount,
      failedCount,
      items
    };

    await this.auditRepository.save({
      batchId: options.batchId,
      operator: session,
      permission: options.permission,
      action: options.action,
      targetType: options.targetType,
      targetId: options.batchId,
      requestPayload: options.requestPayload,
      responsePayload: {
        totalCount: items.length,
        succeededCount,
        failedCount,
        [key]: items.map((item) => item[key]).filter((value) => typeof value === "string")
      },
      status: failedCount > 0 ? "failed" : "succeeded",
      errorCode: failedCount > 0 ? "BATCH_PARTIAL_FAILURE" : undefined,
      errorMessage:
        failedCount > 0 ? `${failedCount} item(s) failed inside batch ${options.batchId}` : undefined,
      startedAt: this.now().toISOString(),
      completedAt: this.now().toISOString()
    });

    return summary;
  }
}

function resolveExecutionTemplate(templateId: string) {
  const template = EXECUTION_TEMPLATES.find((item) => item.templateId === templateId);
  if (!template) {
    throw new OpsConsoleError(
      "RESOURCE_NOT_FOUND",
      404,
      `Execution template ${templateId} not found`
    );
  }

  return template;
}

function extractNumericMetrics(
  payload: Record<string, unknown> | undefined,
  prefix = ""
): Record<string, number> {
  if (!payload) {
    return {};
  }

  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload)) {
    const metricKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[metricKey] = value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        metrics,
        extractNumericMetrics(value as Record<string, unknown>, metricKey)
      );
    }
  }

  return metrics;
}

function diffNumericMetrics(
  current: Record<string, number>,
  previous: Record<string, number>
): Record<string, number> {
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const delta: Record<string, number> = {};

  for (const key of keys) {
    delta[key] = (current[key] ?? 0) - (previous[key] ?? 0);
  }

  return delta;
}

function getLatestExecutionSequence(trades: Record<string, unknown>[]): number | undefined {
  return trades
    .map((trade) => getOptionalNumber(trade.executionSequence))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
}

function getLatestReplayCursor(trades: Record<string, unknown>[]): string | undefined {
  return trades
    .map((trade) => getOptionalString(trade.replayCursor))
    .find((value) => value !== undefined);
}

function readStreamHeads(
  payload: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  const stream = payload?.stream;
  if (!stream || typeof stream !== "object" || !("heads" in stream)) {
    return [];
  }

  const heads = (stream as { heads?: unknown }).heads;
  if (!Array.isArray(heads)) {
    return [];
  }

  return heads.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
  );
}

function readArchiveHeads(
  payload: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  const stream = payload?.stream;
  if (!stream || typeof stream !== "object" || !("archive" in stream)) {
    return [];
  }

  const archive = (stream as { archive?: unknown }).archive;
  if (!archive || typeof archive !== "object" || !("heads" in archive)) {
    return [];
  }

  const heads = (archive as { heads?: unknown }).heads;
  if (!Array.isArray(heads)) {
    return [];
  }

  return heads.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
  );
}

function getLatestStreamHead(
  heads: Array<Record<string, unknown>>,
  market?: string
): Record<string, unknown> | undefined {
  return heads
    .filter((item) => !market || getOptionalString(item.market) === market)
    .slice()
    .sort((left, right) => {
      const rightSequence = getOptionalNumber(right.latestExecutionSequence) ?? -1;
      const leftSequence = getOptionalNumber(left.latestExecutionSequence) ?? -1;
      if (rightSequence !== leftSequence) {
        return rightSequence - leftSequence;
      }

      return String(right.latestPublishedAt ?? "").localeCompare(String(left.latestPublishedAt ?? ""));
    })[0];
}

function getLatestArchiveHead(
  heads: Array<Record<string, unknown>>,
  market?: string
): Record<string, unknown> | undefined {
  return heads
    .filter((item) => !market || getOptionalString(item.market) === market)
    .slice()
    .sort((left, right) =>
      String(right.latestArchivedAt ?? "").localeCompare(String(left.latestArchivedAt ?? ""))
    )[0];
}

function getLatestCheckpoint(
  checkpoints: Array<Record<string, unknown>> | undefined
): Record<string, unknown> | undefined {
  return checkpoints
    ?.slice()
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    )[0];
}

function readLagSlo(
  operator: Record<string, unknown> | undefined
): {
  warning?: number;
  critical?: number;
} {
  const lagSlo =
    operator && typeof operator === "object" && "lagSlo" in operator
      ? (operator.lagSlo as Record<string, unknown>)
      : undefined;

  return {
    warning: getOptionalNumber(lagSlo?.warning),
    critical: getOptionalNumber(lagSlo?.critical)
  };
}

function hasRetentionPressure(
  latestStreamHead: Record<string, unknown> | undefined,
  stream: Record<string, unknown> | undefined
): boolean {
  const maxLen = getOptionalNumber(stream?.maxLen);
  const retentionMs = getOptionalNumber(stream?.retentionMs);
  const streamLength = getOptionalNumber(latestStreamHead?.streamLength);
  const oldestEntryAgeMs =
    getOptionalNumber(latestStreamHead?.oldestEntryAgeMs) ??
    getOptionalNumber(latestStreamHead?.replayWindowMs);

  if (maxLen !== undefined && streamLength !== undefined && streamLength >= maxLen) {
    return true;
  }

  if (
    retentionMs !== undefined &&
    oldestEntryAgeMs !== undefined &&
    oldestEntryAgeMs >= retentionMs
  ) {
    return true;
  }

  return false;
}

function deriveTradeRuntimeAlertRouting(
  alerts: Array<{ code: string; severity: "warning" | "critical" }>,
  recentDeliveries: Array<{
    completedAt?: string;
    responsePayload?: Record<string, unknown>;
  }>,
  now: Date
): {
  route: "default" | "escalation";
  reason: "none" | "critical_alert" | "repeated_alert_window";
  consecutiveAlertWindows: number;
} {
  if (alerts.some((item) => item.severity === "critical")) {
    return {
      route: "escalation",
      reason: "critical_alert",
      consecutiveAlertWindows: 1
    };
  }

  if (alerts.length === 0) {
    return {
      route: "default",
      reason: "none",
      consecutiveAlertWindows: 0
    };
  }

  const currentCodes = new Set(alerts.map((item) => item.code));
  let consecutiveAlertWindows = 1;
  const escalationWindowMs = 30 * 60_000;

  for (const delivery of recentDeliveries) {
    const completedAt = Date.parse(String(delivery.completedAt ?? ""));
    if (!Number.isFinite(completedAt) || now.getTime() - completedAt > escalationWindowMs) {
      break;
    }

    const previousAlerts = readDeliveredTradeRuntimeAlerts(delivery.responsePayload);
    if (previousAlerts.length === 0) {
      break;
    }

    const overlapsCurrent = previousAlerts.some((item) => currentCodes.has(item.code));
    if (!overlapsCurrent) {
      break;
    }

    consecutiveAlertWindows += 1;
    if (consecutiveAlertWindows >= 3) {
      return {
        route: "escalation",
        reason: "repeated_alert_window",
        consecutiveAlertWindows
      };
    }
  }

  return {
    route: "default",
    reason: "none",
    consecutiveAlertWindows
  };
}

function readDeliveredTradeRuntimeAlerts(
  responsePayload: Record<string, unknown> | undefined
): Array<{ code: string; severity?: string }> {
  const exportPayload = responsePayload?.export as Record<string, unknown> | undefined;
  const payload = exportPayload?.payload as Record<string, unknown> | undefined;
  if (!Array.isArray(payload?.alerts)) {
    return [];
  }

  return payload.alerts.filter(
    (item): item is { code: string; severity?: string } =>
      !!item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { code?: unknown }).code === "string"
  );
}

function createSchedulerSession(): OpsSessionInfo {
  return {
    sessionId: "ops-scheduler",
    userId: "ops-scheduler",
    email: "ops-scheduler@local",
    displayName: "Ops Scheduler",
    roles: ["ops_system"],
    permissions: ["ops.ledger.execute", "ops.audit.read"],
    createdAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z",
    lastSeenAt: new Date().toISOString(),
    active: true,
    status: "active"
  };
}

function hasBusinessTraceSelector(query: {
  userId?: string;
  accountId?: string;
  orderId?: string;
  tradeId?: string;
  depositId?: string;
  withdrawalId?: string;
  txHash?: string;
}) {
  return Boolean(
    query.userId ??
      query.accountId ??
      query.orderId ??
      query.tradeId ??
      query.depositId ??
      query.withdrawalId ??
      query.txHash
  );
}

function readFirstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = getOptionalString(value);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function readRecordString(
  record: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = getOptionalString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function matchesRecordValue(
  record: Record<string, unknown> | null | undefined,
  keys: string[],
  expected: string | undefined
) {
  if (!record || !expected) {
    return false;
  }

  return keys.some((key) => readRecordString(record, key) === expected);
}

function findTraceRecordById(
  items: Record<string, unknown>[],
  keys: string[],
  expected: string | undefined
) {
  if (!expected) {
    return null;
  }

  return items.find((item) => matchesRecordValue(item, keys, expected)) ?? null;
}

function findTraceSettlement(
  items: Record<string, unknown>[],
  params: {
    settlementId?: string;
    tradeId?: string;
    orderId?: string;
  }
) {
  return (
    findTraceRecordById(items, ["settlementId"], params.settlementId) ??
    findTraceRecordById(items, ["tradeId"], params.tradeId) ??
    findTraceRecordById(items, ["buyerOrderId", "sellerOrderId", "orderId"], params.orderId)
  );
}

function findTraceIndexerObservation(
  items: Record<string, unknown>[],
  params: {
    txHash?: string;
    assetCode?: string;
  }
) {
  const byTxHash = findTraceRecordById(items, ["txHash"], params.txHash);
  if (byTxHash) {
    return byTxHash;
  }

  if (!params.assetCode) {
    return null;
  }

  return items.find((item) => matchesRecordValue(item, ["assetCode"], params.assetCode)) ?? null;
}

function prioritizeTraceRecords(
  items: Record<string, unknown>[],
  predicate: (item: Record<string, unknown>) => boolean,
  limit: number
) {
  const prioritized = [...items.filter(predicate), ...items.filter((item) => !predicate(item))];
  const seen = new Set<string>();

  return prioritized.filter((item) => {
    const key = buildTraceRecordKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function buildTraceRecordKey(item: Record<string, unknown>) {
  return (
    readFirstString([
      item.accountId && item.assetCode ? `${String(item.accountId)}:${String(item.assetCode)}` : undefined,
      item.orderId,
      item.tradeId,
      item.settlementId,
      item.depositId,
      item.withdrawalId,
      item.notificationId,
      item.auditLogId,
      item.observationId,
      item.txHash,
      item.custodyTransferId,
      item.eventType && item.createdAt ? `${String(item.eventType)}:${String(item.createdAt)}` : undefined
    ]) ?? JSON.stringify(item)
  );
}

function summarizeTraceRecord(
  record: Record<string, unknown> | null | undefined,
  keys: string[]
) {
  if (!record) {
    return "当前没有匹配样本。";
  }

  const pairs = keys
    .map((key) => {
      const value = record[key];
      return value === undefined || value === null || value === "" ? null : `${key}=${String(value)}`;
    })
    .filter((item): item is string => item !== null);

  if (pairs.length > 0) {
    return pairs.join(" · ");
  }

  return JSON.stringify(record);
}

function buildBusinessTraceRoot(
  query: {
    userId?: string;
    accountId?: string;
    orderId?: string;
    tradeId?: string;
    depositId?: string;
    withdrawalId?: string;
    txHash?: string;
  },
  entities: {
    user: Record<string, unknown> | null;
    deposit: Record<string, unknown> | null;
    withdrawal: Record<string, unknown> | null;
    order: Record<string, unknown> | null;
    trade: Record<string, unknown> | null;
    settlement: Record<string, unknown> | null;
  }
) {
  if (query.withdrawalId) {
    return {
      kind: "withdrawal",
      id: query.withdrawalId,
      label: `Withdrawal ${query.withdrawalId}`,
      explanation: "从提币单据出发，继续串审核、托管广播、链上确认和账本最终出账。"
    };
  }

  if (query.depositId) {
    return {
      kind: "deposit",
      id: query.depositId,
      label: `Deposit ${query.depositId}`,
      explanation: "从充值单据出发，继续串链上观测、wallet 入账推进和 ledger 余额变化。"
    };
  }

  if (query.tradeId) {
    return {
      kind: "trade",
      id: query.tradeId,
      label: `Trade ${query.tradeId}`,
      explanation: "从成交出发，继续串 order、settlement 和 ledger 第二阶段表达。"
    };
  }

  if (query.orderId) {
    return {
      kind: "order",
      id: query.orderId,
      label: `Order ${query.orderId}`,
      explanation: "从订单出发，继续串撮合结果、成交、结算和资金影响。"
    };
  }

  if (query.userId) {
    return {
      kind: "user",
      id: query.userId,
      label: `User ${query.userId}`,
      explanation: "从用户出发，同时看资金链和交易链在后台如何投影。"
    };
  }

  if (query.accountId) {
    return {
      kind: "account",
      id: query.accountId,
      label: `Account ${query.accountId}`,
      explanation: "从 ledger account 出发，看 wallet、trading 和 ledger 如何在同一账户上交汇。"
    };
  }

  if (query.txHash) {
    return {
      kind: "tx_hash",
      id: query.txHash,
      label: `Tx ${query.txHash}`,
      explanation: "从链上 txHash 出发，看它在 wallet、indexer、custody 和 ledger 里的对应痕迹。"
    };
  }

  if (entities.withdrawal) {
    const withdrawalId = readRecordString(entities.withdrawal, "withdrawalId");
    return {
      kind: "withdrawal",
      id: withdrawalId,
      label: withdrawalId ? `Withdrawal ${withdrawalId}` : "Withdrawal trace",
      explanation: "从提币单据出发，继续串审核、托管广播、链上确认和账本最终出账。"
    };
  }

  if (entities.deposit) {
    const depositId = readRecordString(entities.deposit, "depositId");
    return {
      kind: "deposit",
      id: depositId,
      label: depositId ? `Deposit ${depositId}` : "Deposit trace",
      explanation: "从充值单据出发，继续串链上观测、wallet 入账推进和 ledger 余额变化。"
    };
  }

  if (entities.trade) {
    const tradeId = readRecordString(entities.trade, "tradeId");
    return {
      kind: "trade",
      id: tradeId,
      label: tradeId ? `Trade ${tradeId}` : "Trade trace",
      explanation: "从成交出发，继续串 order、settlement 和 ledger 第二阶段表达。"
    };
  }

  if (entities.order) {
    const orderId = readRecordString(entities.order, "orderId");
    return {
      kind: "order",
      id: orderId,
      label: orderId ? `Order ${orderId}` : "Order trace",
      explanation: "从订单出发，继续串撮合结果、成交、结算和资金影响。"
    };
  }

  if (entities.user) {
    const userId = readRecordString(entities.user, "userId");
    return {
      kind: "user",
      id: userId,
      label: userId ? `User ${userId}` : "User trace",
      explanation: "从用户出发，同时看资金链和交易链在后台如何投影。"
    };
  }

  return {
    kind: "tx_hash",
    id: query.txHash,
    label: query.txHash ? `Tx ${query.txHash}` : "Tx trace",
    explanation: "从链上 txHash 出发，看它在 wallet、indexer、custody 和 ledger 里的对应痕迹。"
  };
}

function buildBusinessTraceSteps(params: {
  user: Record<string, unknown> | null;
  deposit: Record<string, unknown> | null;
  withdrawal: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  trade: Record<string, unknown> | null;
  settlement: Record<string, unknown> | null;
  indexerObservation: Record<string, unknown> | null;
  custodyTransfer: Record<string, unknown> | null;
  reviewQueueItem: Record<string, unknown> | null;
  balances: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
}) {
  const steps = [];

  if (params.user) {
    steps.push({
      moduleId: "identity-service",
      title: "User anchor",
      panelTarget: "search-panel",
      focusTarget: "users-body",
      lines: [
        summarizeTraceRecord(params.user, ["userId", "email", "status", "userType"]),
        "这是整条 trace 的身份锚点，方便继续投影到账户、充提和交易链。"
      ]
    });
  }

  if (params.deposit || params.withdrawal || params.reviewQueueItem) {
    steps.push({
      moduleId: "wallet-service",
      title: "Wallet state machine",
      panelTarget: "search-panel",
      focusTarget: params.withdrawal ? "withdrawals-body" : "deposits-body",
      lines: [
        summarizeTraceRecord(params.deposit, ["depositId", "assetCode", "amount", "status", "txHash"]),
        summarizeTraceRecord(params.withdrawal, [
          "withdrawalId",
          "assetCode",
          "amount",
          "status",
          "reviewStatus"
        ]),
        summarizeTraceRecord(params.reviewQueueItem, [
          "withdrawalId",
          "status",
          "reviewStatus",
          "reviewedAt"
        ])
      ]
    });
  }

  if (params.order || params.trade) {
    steps.push({
      moduleId: "order-service",
      title: "Order and trade projection",
      panelTarget: "search-panel",
      focusTarget: "spot-orders-body",
      lines: [
        summarizeTraceRecord(params.order, [
          "orderId",
          "market",
          "side",
          "status",
          "filledQuantity"
        ]),
        summarizeTraceRecord(params.trade, [
          "tradeId",
          "market",
          "price",
          "quantity",
          "settlementId"
        ]),
        "这里负责解释订单状态与成交回报，不直接替代最终账务表达。"
      ]
    });
  }

  if (params.settlement) {
    steps.push({
      moduleId: "settlement-service",
      title: "Settlement second phase",
      panelTarget: "search-panel",
      focusTarget: "spot-settlements-body",
      lines: [
        summarizeTraceRecord(params.settlement, [
          "settlementId",
          "tradeId",
          "market",
          "status",
          "quoteAmount",
          "feeAmount"
        ]),
        "这里把“成交已发生”和“资金已完成第二阶段结算”明确分开。"
      ]
    });
  }

  if (params.balances.length > 0) {
    steps.push({
      moduleId: "ledger-service",
      title: "Ledger balance fact",
      panelTarget: "search-panel",
      focusTarget: "balances-body",
      lines: [
        ...params.balances
          .slice(0, 2)
          .map((item) => summarizeTraceRecord(item, ["accountId", "assetCode", "available", "locked"])),
        "ledger 是最终资金事实源，适合用来确认 available / locked 是否和前序状态机一致。"
      ]
    });
  }

  if (params.indexerObservation) {
    steps.push({
      moduleId: "blockchain-indexer",
      title: "Chain observation",
      panelTarget: "alerts-panel",
      focusTarget: "pending-deposits-body",
      lines: [
        summarizeTraceRecord(params.indexerObservation, [
          "observationId",
          "network",
          "assetCode",
          "status",
          "txHash"
        ]),
        "这一步负责把链上事实推进到 wallet 状态机。"
      ]
    });
  }

  if (params.custodyTransfer) {
    steps.push({
      moduleId: "custody-adapter",
      title: "Custody broadcast",
      panelTarget: "custody-panel",
      focusTarget: "custody-overview",
      lines: [
        summarizeTraceRecord(params.custodyTransfer, [
          "custodyTransferId",
          "status",
          "txHash",
          "providerName"
        ]),
        "提币类 trace 要看这里，确认广播与回查是否已经接上链。"
      ]
    });
  }

  if (params.notifications.length > 0 || params.auditLogs.length > 0) {
    steps.push({
      moduleId: "api-gateway",
      title: "Notification and audit projection",
      panelTarget: "feed-panel",
      focusTarget: "notifications-body",
      lines: [
        ...params.notifications
          .slice(0, 2)
          .map((item) => summarizeTraceRecord(item, ["notificationId", "eventType", "status", "withdrawalId"])),
        ...params.auditLogs
          .slice(0, 1)
          .map((item) => summarizeTraceRecord(item, ["auditLogId", "action", "operatorId", "withdrawalId"])),
        "最后回到通知与审计，确认前后台看到的是同一笔业务。"
      ]
    });
  }

  return steps;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeAlertSource(source: string, payload: Record<string, unknown>) {
  const alerts = Array.isArray(payload.alerts)
    ? payload.alerts.filter((item): item is string => typeof item === "string")
    : [];

  return {
    source,
    status: payload.status === "alert" ? "alert" : "ok",
    alerts,
    summary: payload
  };
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "unknown ops action failure";
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }

  return Math.max(Math.trunc(offset), 0);
}

function dedupeIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
