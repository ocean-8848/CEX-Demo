import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards
} from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";
import type {
  OpsActionAuditLogsQueryDto,
  OpsAutomationExecutionsQueryDto,
  OpsApproveWithdrawalRequestDto,
  OpsBalanceSearchQueryDto,
  OpsBatchApproveWithdrawalsRequestDto,
  OpsBusinessTraceQueryDto,
  OpsBatchClosePendingDepositsRequestDto,
  OpsBatchRejectWithdrawalsRequestDto,
  OpsBatchReplayPendingDepositsRequestDto,
  OpsDashboardQueryDto,
  OpsDeliverNotificationsRequestDto,
  OpsDrainLedgerOutboxRequestDto,
  OpsDepositSearchQueryDto,
  OpsExecuteTemplateRequestDto,
  OpsExecutionHistoryQueryDto,
  OpsExecutionHistoryDiffQueryDto,
  OpsExecutionSchedulesQueryDto,
  OpsFreezeUserRequestDto,
  OpsKycRequestsQueryDto,
  OpsReviewKycRequestDto,
  OpsSetKycTierRequestDto,
  OpsSetMarketStatusRequestDto,
  OpsIndexerPendingDepositsQueryDto,
  OpsLedgerReconciliationQueryDto,
  OpsLedgerReplayQueryDto,
  OpsLoginRequestDto,
  OpsNotificationsQueryDto,
  OpsClosePendingDepositRequestDto,
  OpsReconcileStaleWithdrawalsRequestDto,
  OpsRepairIndexerBacklogRequestDto,
  OpsProcessRecoveryJobsRequestDto,
  OpsRejectWithdrawalRequestDto,
  OpsReplayPendingDepositRequestDto,
  OpsReplayIndexerRequestDto,
  OpsReviewQueueQueryDto,
  OpsSpotOrderSearchQueryDto,
  OpsSpotRecoveryJobQueryDto,
  OpsSpotTradeSearchQueryDto,
  OpsTradeOpsQueryDto,
  OpsTradeDeadLetterReportQueryDto,
  OpsTradeRuntimeAlertDeliveryRequestDto,
  OpsTradeRuntimeDrilldownQueryDto,
  OpsTradeRuntimeReportQueryDto,
  OpsReplayTradeEventStreamRequestDto,
  OpsProcessTradeEventSubscriptionRequestDto,
  OpsMaintainTradeEventStreamRequestDto,
  OpsSelfHealTradeEventBusRequestDto,
  OpsTrimTradeEventStreamRequestDto,
  OpsRunExecutionSchedulesRequestDto,
  OpsTradeSettlementRecoveryJobQueryDto,
  OpsTradeSettlementSearchQueryDto,
  OpsUserSearchQueryDto,
  OpsWithdrawalAddressBookQueryDto,
  OpsWithdrawalAuditLogsQueryDto
} from "./dto.js";
import {
  CurrentOpsSession,
  RequireOpsPermissions
} from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";
import { buildSessionCookies, clearSessionCookies, wantsCookieSession } from "./ops-session-cookie.js";

const COOKIE_SECURE = process.env.OPS_COOKIE_SECURE === "true";

@UseFilters(OpsConsoleExceptionFilter)
@Controller("/api/v1/ops")
export class OpsConsoleController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  @Post("/auth/login")
  async login(
    @Body() body: OpsLoginRequestDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string[]): void }
  ) {
    const result = await this.opsConsoleHttpService.login(body);
    if (!wantsCookieSession(request.headers)) {
      return result;
    }
    // Browser mode: the token lives only in an HttpOnly cookie.
    response.setHeader("set-cookie", buildSessionCookies(result.token, result.expiresAt, COOKIE_SECURE));
    const { token: _token, ...session } = result;
    return session;
  }

  @UseGuards(OpsAuthGuard)
  @Get("/auth/me")
  async getCurrentSession(@CurrentOpsSession() session: OpsSessionInfo) {
    return session;
  }

  @UseGuards(OpsAuthGuard)
  @Post("/auth/logout")
  async logout(
    @Req() request: { opsSessionToken?: string },
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string[]): void }
  ) {
    response.setHeader("set-cookie", clearSessionCookies(COOKIE_SECURE));
    return this.opsConsoleHttpService.logout(request.opsSessionToken ?? "");
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/dashboard")
  async getDashboard(@Query() query: OpsDashboardQueryDto) {
    return this.opsConsoleHttpService.getDashboard({
      network: query.network,
      reviewQueueLimit: parseOptionalNumber(query.reviewQueueLimit),
      notificationsLimit: parseOptionalNumber(query.notificationsLimit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.read")
  @Get("/users")
  async listUsers(@Query() query: OpsUserSearchQueryDto) {
    return this.opsConsoleHttpService.listUsers({
      userId: query.userId,
      email: query.email,
      status: query.status,
      userType: query.userType,
      role: query.role,
      search: query.search,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  /** Markets + assets from config/markets.json for page dropdowns. */
  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/market-config")
  getMarketConfig() {
    return this.opsConsoleHttpService.getMarketConfig();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.markets.read")
  @Get("/markets")
  async listMarkets() {
    return this.opsConsoleHttpService.listMarkets();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.markets.manage")
  @Post("/markets/:market/status")
  async setMarketStatus(
    @Param("market") market: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsSetMarketStatusRequestDto
  ) {
    if (body?.status !== "listed" && body?.status !== "halted") {
      throw new BadRequestException("status must be listed or halted");
    }
    return this.opsConsoleHttpService.setMarketStatus(session, {
      market,
      status: body.status,
      reason: typeof body.reason === "string" ? body.reason : undefined
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/modules")
  async listModules() {
    return this.opsConsoleHttpService.listModuleNavigation();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/business-trace")
  async getBusinessTrace(@Query() query: OpsBusinessTraceQueryDto) {
    return this.opsConsoleHttpService.getBusinessTrace({
      userId: query.userId,
      accountId: query.accountId,
      orderId: query.orderId,
      tradeId: query.tradeId,
      depositId: query.depositId,
      withdrawalId: query.withdrawalId,
      txHash: query.txHash,
      market: query.market,
      assetCode: query.assetCode,
      limit: parseOptionalNumber(query.limit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.freeze")
  @Post("/users/:userId/freeze")
  async freezeUser(
    @Param("userId") userId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFreezeUserRequestDto
  ) {
    return this.opsConsoleHttpService.freezeUser(session, {
      userId,
      reason: body?.reason
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.freeze")
  @Post("/users/:userId/unfreeze")
  async unfreezeUser(
    @Param("userId") userId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.unfreezeUser(session, userId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.read")
  @Get("/users/:userId/kyc")
  async getUserKycProfile(@Param("userId") userId: string) {
    return this.opsConsoleHttpService.getUserKycProfile(userId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.manage")
  @Post("/users/:userId/kyc-tier")
  async setUserKycTier(
    @Param("userId") userId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsSetKycTierRequestDto
  ) {
    if (!body?.tier) {
      throw new BadRequestException("tier is required");
    }
    return this.opsConsoleHttpService.setUserKycTier(session, {
      userId,
      tier: body.tier,
      actorId: session.userId,
      reason: body.reason
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.read")
  @Get("/kyc/requests")
  async listKycRequests(@Query() query: OpsKycRequestsQueryDto) {
    return this.opsConsoleHttpService.listKycRequests({
      userId: query.userId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.manage")
  @Post("/kyc/requests/:requestId/approve")
  async approveKycRequest(
    @Param("requestId") requestId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReviewKycRequestDto
  ) {
    return this.opsConsoleHttpService.approveKycRequest(session, {
      requestId,
      reviewedBy: session.userId,
      tier: body?.tier,
      note: body?.note
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.users.manage")
  @Post("/kyc/requests/:requestId/reject")
  async rejectKycRequest(
    @Param("requestId") requestId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReviewKycRequestDto
  ) {
    return this.opsConsoleHttpService.rejectKycRequest(session, {
      requestId,
      reviewedBy: session.userId,
      note: body?.reason ?? body?.note
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/balances")
  async listBalances(@Query() query: OpsBalanceSearchQueryDto) {
    return this.opsConsoleHttpService.listBalances({
      userId: query.userId,
      accountId: query.accountId,
      assetCode: query.assetCode,
      accountType: query.accountType,
      accountStatus: query.accountStatus,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.deposits.read")
  @Get("/deposits")
  async listDeposits(@Query() query: OpsDepositSearchQueryDto) {
    return this.opsConsoleHttpService.listDeposits({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      txHash: query.txHash,
      address: query.address,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/orders")
  async listSpotOrders(@Query() query: OpsSpotOrderSearchQueryDto) {
    return this.opsConsoleHttpService.listSpotOrders({
      userId: query.userId,
      accountId: query.accountId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/trades")
  async listSpotTrades(@Query() query: OpsSpotTradeSearchQueryDto) {
    return this.opsConsoleHttpService.listSpotTrades({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/settlements")
  async listTradeSettlements(@Query() query: OpsTradeSettlementSearchQueryDto) {
    return this.opsConsoleHttpService.listTradeSettlements({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/settlements/report")
  async getTradeSettlementReport(@Query() query: OpsTradeSettlementSearchQueryDto) {
    return this.opsConsoleHttpService.getTradeSettlementReport({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/settlements/recovery-jobs")
  async listTradeSettlementRecoveryJobs(@Query() query: OpsTradeSettlementRecoveryJobQueryDto) {
    return this.opsConsoleHttpService.listTradeSettlementRecoveryJobs({
      tradeId: query.tradeId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.read")
  @Get("/withdrawals")
  async listWithdrawals(@Query() query: OpsReviewQueueQueryDto) {
    return this.opsConsoleHttpService.listWithdrawals({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      reviewStatus: query.reviewStatus,
      txHash: query.txHash,
      toAddress: query.toAddress,
      riskLevel: query.riskLevel || undefined,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.read")
  @Get("/withdrawals/review-queue")
  async listWithdrawalReviewQueue(@Query() query: OpsReviewQueueQueryDto) {
    return this.opsConsoleHttpService.listWithdrawalReviewQueue({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      txHash: query.txHash,
      toAddress: query.toAddress,
      riskLevel: query.riskLevel || undefined,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.read")
  @Get("/withdrawals/:withdrawalId")
  async getWithdrawalDetail(
    @Param("withdrawalId") withdrawalId: string,
    @Query() query: OpsWithdrawalAuditLogsQueryDto
  ) {
    return this.opsConsoleHttpService.getWithdrawalDetail(withdrawalId, {
      action: query.action,
      operatorId: query.operatorId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.read")
  @Get("/withdrawals/:withdrawalId/audit-logs")
  async listWithdrawalAuditLogs(
    @Param("withdrawalId") withdrawalId: string,
    @Query() query: OpsWithdrawalAuditLogsQueryDto
  ) {
    return this.opsConsoleHttpService.listWithdrawalAuditLogs(withdrawalId, {
      action: query.action,
      operatorId: query.operatorId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.review")
  @Post("/withdrawals/:withdrawalId/approve")
  async approveWithdrawal(
    @Param("withdrawalId") withdrawalId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsApproveWithdrawalRequestDto
  ) {
    return this.opsConsoleHttpService.approveWithdrawal(session, {
      withdrawalId,
      reviewedBy: session.userId,
      note: body.note
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.review")
  @Post("/withdrawals/:withdrawalId/reject")
  async rejectWithdrawal(
    @Param("withdrawalId") withdrawalId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsRejectWithdrawalRequestDto
  ) {
    return this.opsConsoleHttpService.rejectWithdrawal(session, {
      withdrawalId,
      reviewedBy: session.userId,
      reason: body?.reason
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.batch_review")
  @Post("/withdrawal-batches/approve")
  async batchApproveWithdrawals(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsBatchApproveWithdrawalsRequestDto
  ) {
    if (!Array.isArray(body?.withdrawalIds) || body.withdrawalIds.length === 0) {
      throw new BadRequestException("withdrawalIds must be a non-empty array");
    }

    return this.opsConsoleHttpService.batchApproveWithdrawals(session, {
      withdrawalIds: body.withdrawalIds,
      reviewedBy: session.userId,
      note: body.note
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.withdrawals.batch_review")
  @Post("/withdrawal-batches/reject")
  async batchRejectWithdrawals(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsBatchRejectWithdrawalsRequestDto
  ) {
    if (!Array.isArray(body?.withdrawalIds) || body.withdrawalIds.length === 0) {
      throw new BadRequestException("withdrawalIds must be a non-empty array");
    }

    return this.opsConsoleHttpService.batchRejectWithdrawals(session, {
      withdrawalIds: body.withdrawalIds,
      reviewedBy: session.userId,
      reason: body.reason
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.address_book.read")
  @Get("/withdrawal-address-book")
  async listWithdrawalAddressBook(@Query() query: OpsWithdrawalAddressBookQueryDto) {
    return this.opsConsoleHttpService.listWithdrawalAddressBook({
      userId: query.userId,
      network: query.network,
      address: query.address,
      isWhitelisted: parseOptionalBoolean(query.isWhitelisted),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.address_book.manage")
  @Post("/withdrawal-address-book/:addressBookId/whitelist")
  async whitelistWithdrawalAddress(
    @Param("addressBookId") addressBookId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.whitelistWithdrawalAddress(session, addressBookId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.address_book.manage")
  @Post("/withdrawal-address-book/:addressBookId/unwhitelist")
  async unwhitelistWithdrawalAddress(
    @Param("addressBookId") addressBookId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.unwhitelistWithdrawalAddress(session, addressBookId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.notifications.read")
  @Get("/notifications")
  async listNotifications(@Query() query: OpsNotificationsQueryDto) {
    return this.opsConsoleHttpService.listNotifications({
      userId: query.userId,
      withdrawalId: query.withdrawalId,
      eventType: query.eventType,
      status: query.status,
      channel: query.channel,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.notifications.manage")
  @Post("/notifications/deliver")
  async deliverNotifications(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsDeliverNotificationsRequestDto
  ) {
    return this.opsConsoleHttpService.deliverNotifications(session, body ?? {});
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.notifications.manage")
  @Post("/withdrawals/reconcile-stale")
  async reconcileStaleWithdrawals(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReconcileStaleWithdrawalsRequestDto
  ) {
    return this.opsConsoleHttpService.reconcileStaleWithdrawals(session, body ?? {});
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.read")
  @Get("/ledger/reconciliation")
  async getLedgerReconciliationReport(@Query() query: OpsLedgerReconciliationQueryDto) {
    return this.opsConsoleHttpService.getLedgerReconciliationReport({
      accountId: query.accountId,
      assetCode: query.assetCode,
      includeMatched: parseOptionalBoolean(query.includeMatched)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/ledger/reconciliation/run")
  async runLedgerReconciliation(@Body() body: OpsLedgerReconciliationQueryDto) {
    const payload = body ?? {};
    return this.opsConsoleHttpService.getLedgerReconciliationReport({
      accountId: payload.accountId,
      assetCode: payload.assetCode,
      includeMatched: parseOptionalBoolean(payload.includeMatched)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.read")
  @Get("/ledger/replay")
  async getLedgerReplayReport(@Query() query: OpsLedgerReplayQueryDto) {
    if (!query.accountId || !query.assetCode) {
      throw new BadRequestException("accountId and assetCode are required");
    }

    return this.opsConsoleHttpService.getLedgerReplayReport({
      accountId: query.accountId,
      assetCode: query.assetCode
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/ledger/replay/run")
  async runLedgerReplay(@Body() body: OpsLedgerReplayQueryDto) {
    if (!body?.accountId || !body?.assetCode) {
      throw new BadRequestException("accountId and assetCode are required");
    }

    return this.opsConsoleHttpService.getLedgerReplayReport({
      accountId: body.accountId,
      assetCode: body.assetCode
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.read")
  @Get("/ledger/overview")
  async getLedgerOpsOverview() {
    return this.opsConsoleHttpService.getLedgerOpsOverview();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/overview")
  async getTradeOpsOverview(@Query() query: OpsTradeOpsQueryDto) {
    return this.opsConsoleHttpService.getTradeOpsOverview({
      market: query.market
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/anomalies")
  async getTradeOpsAnomalies(@Query() query: OpsTradeOpsQueryDto) {
    return this.opsConsoleHttpService.getTradeOpsAnomalies({
      market: query.market
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/recovery-metrics")
  async getTradeRecoveryMetrics() {
    return this.opsConsoleHttpService.getTradeRecoveryMetrics();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/recovery-jobs")
  async listTradeRecoveryJobs(@Query() query: OpsSpotRecoveryJobQueryDto) {
    return this.opsConsoleHttpService.listTradeRecoveryJobs({
      orderId: query.orderId,
      market: query.market,
      status: query.status,
      deadLettered: parseOptionalBoolean(query.deadLettered),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/recovery-governance")
  async getTradeRecoveryGovernanceReport() {
    return this.opsConsoleHttpService.getTradeRecoveryGovernanceReport();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/dead-letter-report")
  async getTradeDeadLetterReport(@Query() query: OpsTradeDeadLetterReportQueryDto) {
    return this.opsConsoleHttpService.getTradeDeadLetterReport({
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      templateLimit: parseOptionalNumber(query.templateLimit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/automation-executions")
  async listTradeAutomationExecutions(@Query() query: OpsAutomationExecutionsQueryDto) {
    return this.opsConsoleHttpService.listTradeAutomationExecutions({
      executionType: query.executionType,
      status: query.status,
      trigger: query.trigger,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/ops/dead-letter-jobs")
  async listTradeDeadLetterJobs(@Query() query: OpsSpotRecoveryJobQueryDto) {
    return this.opsConsoleHttpService.listTradeDeadLetterJobs({
      orderId: query.orderId,
      market: query.market,
      status: query.status,
      deadLettered: true,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/settlements/recovery-governance")
  async getTradeSettlementRecoveryGovernanceReport() {
    return this.opsConsoleHttpService.getTradeSettlementRecoveryGovernanceReport();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/settlements/automation-executions")
  async listTradeSettlementAutomationExecutions(@Query() query: OpsAutomationExecutionsQueryDto) {
    return this.opsConsoleHttpService.listTradeSettlementAutomationExecutions({
      executionType: query.executionType,
      status: query.status,
      trigger: query.trigger,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/runtime-report")
  async getTradeRuntimeReport(@Query() query: OpsTradeRuntimeReportQueryDto) {
    return this.opsConsoleHttpService.getTradeRuntimeReport({
      market: query.market,
      historyLimit: parseOptionalNumber(query.historyLimit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.assets.read")
  @Get("/spot/runtime-drilldown")
  async getTradeRuntimeDrilldown(@Query() query: OpsTradeRuntimeDrilldownQueryDto) {
    return this.opsConsoleHttpService.getTradeRuntimeDrilldown({
      market: query.market,
      historyLimit: parseOptionalNumber(query.historyLimit),
      streamLimit: parseOptionalNumber(query.streamLimit),
      checkpointLimit: parseOptionalNumber(query.checkpointLimit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.alerts.read")
  @Get("/spot/runtime-alert-sinks")
  async listTradeRuntimeAlertSinks() {
    return this.opsConsoleHttpService.listTradeRuntimeAlertSinks();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/ops/replay-engine")
  async replayTradeEngineBook(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsTradeOpsQueryDto
  ) {
    return this.opsConsoleHttpService.replayTradeEngineBook(session, {
      market: body.market
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/event-bus/replay")
  async replayTradeEventStream(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReplayTradeEventStreamRequestDto
  ) {
    return this.opsConsoleHttpService.replayTradeEventStream(session, {
      market: body.market,
      afterStreamEntryId: body.afterStreamEntryId,
      fromStreamEntryId: body.fromStreamEntryId,
      toStreamEntryId: body.toStreamEntryId,
      executionSequenceFrom: body.executionSequenceFrom,
      limit: body.limit,
      overlapCount: body.overlapCount,
      direction: body.direction,
      publishToChannel: body.publishToChannel,
      processSettlement: body.processSettlement,
      allowGap: body.allowGap
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/event-bus/trim")
  async trimTradeEventStream(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsTrimTradeEventStreamRequestDto
  ) {
    return this.opsConsoleHttpService.trimTradeEventStream(session, {
      market: body.market,
      strategy: body.strategy,
      maxLen: body.maxLen,
      retentionMs: body.retentionMs,
      minStreamEntryId: body.minStreamEntryId,
      dryRun: body.dryRun,
      limit: body.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/event-bus/maintenance")
  async maintainTradeEventStream(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsMaintainTradeEventStreamRequestDto
  ) {
    return this.opsConsoleHttpService.maintainTradeEventStream(session, {
      market: body.market,
      dryRun: body.dryRun,
      force: body.force,
      limit: body.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/event-bus/self-heal")
  async selfHealTradeEventBus(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsSelfHealTradeEventBusRequestDto
  ) {
    return this.opsConsoleHttpService.selfHealTradeEventBus(session, {
      market: body.market,
      historyLimit: body.historyLimit,
      maxAcceptableLag: body.maxAcceptableLag,
      replayLimit: body.replayLimit,
      overlapCount: body.overlapCount,
      publishToChannel: body.publishToChannel,
      allowGap: body.allowGap,
      trim: body.trim,
      deliverAlerts: body.deliverAlerts,
      sinkId: body.sinkId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/event-bus/process")
  async processTradeEventSubscriptionCycle(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsProcessTradeEventSubscriptionRequestDto
  ) {
    return this.opsConsoleHttpService.processTradeEventSubscriptionCycle(session, {
      market: body.market,
      allowGap: body.allowGap,
      afterStreamEntryId: body.afterStreamEntryId,
      limit: body.limit,
      overlapCount: body.overlapCount
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/ops/recovery-jobs/process")
  async processTradeRecoveryJobs(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsProcessRecoveryJobsRequestDto
  ) {
    return this.opsConsoleHttpService.processTradeRecoveryJobs(session, {
      limit: body?.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/ops/recovery-jobs/:jobId/recover")
  async recoverTradeRecoveryJob(
    @Param("jobId") jobId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.recoverTradeRecoveryJob(session, jobId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/ops/dead-letter-jobs/process")
  async batchRequeueTradeDeadLetterJobs(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsProcessRecoveryJobsRequestDto & { market?: string }
  ) {
    return this.opsConsoleHttpService.batchRequeueTradeDeadLetterJobs(session, {
      market: body.market,
      limit: body.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/ops/dead-letter-jobs/:jobId/requeue")
  async requeueTradeDeadLetterJob(
    @Param("jobId") jobId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.requeueTradeDeadLetterJob(session, jobId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/settlements/recovery-jobs/process")
  async processTradeSettlementRecoveryJobs(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsProcessRecoveryJobsRequestDto
  ) {
    return this.opsConsoleHttpService.processTradeSettlementRecoveryJobs(session, {
      limit: body?.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/spot/settlements/:tradeId/recover")
  async recoverTradeSettlement(
    @Param("tradeId") tradeId: string,
    @CurrentOpsSession() session: OpsSessionInfo
  ) {
    return this.opsConsoleHttpService.recoverTradeSettlement(session, tradeId);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/ledger/outbox/drain")
  async drainLedgerOutbox(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsDrainLedgerOutboxRequestDto
  ) {
    return this.opsConsoleHttpService.drainLedgerOutbox(session, body ?? {});
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.read")
  @Get("/indexer/overview")
  async getIndexerOpsOverview() {
    return this.opsConsoleHttpService.getIndexerOpsOverview();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.read")
  @Get("/indexer/pending-deposits")
  async listIndexerPendingDeposits(@Query() query: OpsIndexerPendingDepositsQueryDto) {
    return this.opsConsoleHttpService.listIndexerPendingDeposits({
      network: query.network,
      assetCode: query.assetCode,
      status: query.status,
      olderThanSeconds: parseOptionalNumber(query.olderThanSeconds),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.execute")
  @Post("/indexer/replay")
  async replayIndexer(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReplayIndexerRequestDto
  ) {
    return this.opsConsoleHttpService.replayIndexer(session, body);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.execute")
  @Post("/indexer/backlog/repair")
  async repairIndexerBacklog(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsRepairIndexerBacklogRequestDto
  ) {
    return this.opsConsoleHttpService.repairIndexerBacklog(session, body);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.pending.manage")
  @Post("/indexer/pending-deposits/:observationId/replay")
  async replayIndexerPendingDeposit(
    @Param("observationId") observationId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsReplayPendingDepositRequestDto
  ) {
    return this.opsConsoleHttpService.replayIndexerPendingDeposit(session, {
      observationId,
      confirmations: body?.confirmations,
      blockNumber: body?.blockNumber,
      blockHash: body?.blockHash,
      note: body?.note,
      operatedBy: session.userId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.pending.manage")
  @Post("/indexer/pending-deposits/:observationId/close")
  async closeIndexerPendingDeposit(
    @Param("observationId") observationId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsClosePendingDepositRequestDto
  ) {
    return this.opsConsoleHttpService.closeIndexerPendingDeposit(session, {
      observationId,
      note: body?.note,
      operatedBy: session.userId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.pending.manage")
  @Post("/indexer/pending-deposit-batches/replay")
  async batchReplayIndexerPendingDeposits(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsBatchReplayPendingDepositsRequestDto
  ) {
    if (!Array.isArray(body?.observationIds) || body.observationIds.length === 0) {
      throw new BadRequestException("observationIds must be a non-empty array");
    }

    return this.opsConsoleHttpService.batchReplayIndexerPendingDeposits(session, {
      observationIds: body.observationIds,
      confirmations: body.confirmations,
      blockNumber: body.blockNumber,
      blockHash: body.blockHash,
      note: body.note,
      operatedBy: session.userId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.indexer.pending.manage")
  @Post("/indexer/pending-deposit-batches/close")
  async batchCloseIndexerPendingDeposits(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsBatchClosePendingDepositsRequestDto
  ) {
    if (!Array.isArray(body?.observationIds) || body.observationIds.length === 0) {
      throw new BadRequestException("observationIds must be a non-empty array");
    }

    return this.opsConsoleHttpService.batchCloseIndexerPendingDeposits(session, {
      observationIds: body.observationIds,
      note: body.note,
      operatedBy: session.userId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/audit-logs/withdrawals")
  async searchWithdrawalAuditLogs(@Query() query: OpsWithdrawalAuditLogsQueryDto) {
    return this.opsConsoleHttpService.searchWithdrawalAuditLogs({
      withdrawalId: query.withdrawalId,
      userId: query.userId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      reviewStatus: query.reviewStatus,
      txHash: query.txHash,
      toAddress: query.toAddress,
      action: query.action,
      operatorId: query.operatorId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/audit-logs/actions")
  async listActionAuditLogs(@Query() query: OpsActionAuditLogsQueryDto) {
    return this.opsConsoleHttpService.listActionAuditLogs({
      batchId: query.batchId,
      operatorUserId: query.operatorUserId,
      action: query.action,
      permission: query.permission,
      targetType: query.targetType,
      targetId: query.targetId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/execution-templates")
  async listExecutionTemplates() {
    return this.opsConsoleHttpService.listExecutionTemplates();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/execution-history")
  async listExecutionHistory(@Query() query: OpsExecutionHistoryQueryDto) {
    return this.opsConsoleHttpService.listExecutionHistory({
      templateId: query.templateId,
      targetId: query.targetId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/execution-history/diff")
  async getExecutionHistoryDiff(@Query() query: OpsExecutionHistoryDiffQueryDto) {
    return this.opsConsoleHttpService.getExecutionHistoryDiff({
      templateId: query.templateId,
      targetId: query.targetId,
      limit: parseOptionalNumber(query.limit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.audit.read")
  @Get("/execution-schedules")
  async listExecutionSchedules(@Query() query: OpsExecutionSchedulesQueryDto) {
    return this.opsConsoleHttpService.listExecutionSchedules({
      scheduleId: query.scheduleId,
      market: query.market,
      dueOnly: parseOptionalBoolean(query.dueOnly),
      limit: parseOptionalNumber(query.limit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/execution-schedules/run")
  async runDueExecutionSchedules(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsRunExecutionSchedulesRequestDto
  ) {
    return this.opsConsoleHttpService.runDueExecutionSchedules(session, {
      scheduleId: body?.scheduleId,
      force: body?.force,
      limit: body?.limit
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/execution-templates/:templateId/execute")
  async executeExecutionTemplate(
    @Param("templateId") templateId: string,
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsExecuteTemplateRequestDto
  ) {
    return this.opsConsoleHttpService.executeExecutionTemplate(
      session,
      templateId,
      (body ?? {}) as Record<string, unknown>
    );
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.alerts.read")
  @Get("/alerts")
  async getAlertsOverview() {
    return this.opsConsoleHttpService.getAlertsOverview();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.alerts.read")
  @Get("/spot/runtime-alerts/export")
  async exportTradeRuntimeAlerts(@Query() query: OpsTradeRuntimeReportQueryDto) {
    return this.opsConsoleHttpService.exportTradeRuntimeAlerts({
      market: query.market,
      historyLimit: parseOptionalNumber(query.historyLimit)
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.alerts.manage")
  @Post("/spot/runtime-alerts/deliver")
  async deliverTradeRuntimeAlerts(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsTradeRuntimeAlertDeliveryRequestDto
  ) {
    return this.opsConsoleHttpService.deliverTradeRuntimeAlerts(session, {
      market: body.market,
      historyLimit: body.historyLimit,
      sinkId: body.sinkId
    });
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.custody.read")
  @Get("/custody/providers/health")
  async getCustodyProviderHealth() {
    return this.opsConsoleHttpService.getCustodyProviderHealth();
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.providers.manage")
  @Post("/custody/providers/health/check")
  async runCustodyProviderHealthChecks(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.opsConsoleHttpService.runCustodyProviderHealthChecks(session);
  }

  @UseGuards(OpsAuthGuard)
  @RequireOpsPermissions("ops.custody.read")
  @Get("/custody/overview")
  async getCustodyOpsOverview() {
    return this.opsConsoleHttpService.getCustodyOpsOverview();
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

