import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseFilters
} from "@nestjs/common";

import type {
  ApproveWithdrawalRequestDto,
  ConfirmDepositRequestDto,
  ConfirmWithdrawalRequestDto,
  CreateWithdrawalAddressBookEntryRequestDto,
  CreateDepositAddressRequestDto,
  DeliverWalletNotificationsRequestDto,
  ListDepositAddressesQueryDto,
  ListWalletNotificationsQueryDto,
  ListWithdrawalAuditLogsQueryDto,
  ListWithdrawalAddressBookQueryDto,
  ListDepositsQueryDto,
  ListWithdrawalsQueryDto,
  MarkWalletNotificationsReadRequestDto,
  ReconcileStaleWithdrawalsRequestDto,
  RejectWithdrawalRequestDto,
  RequestWithdrawalRequestDto
} from "./dto.js";
import { isWithdrawalRiskLevel, type WithdrawalRiskLevel } from "../domain/withdrawal-risk.js";
import { WalletExceptionFilter } from "./wallet-exception.filter.js";
import { WalletHttpService } from "./wallet-http.service.js";

@UseFilters(WalletExceptionFilter)
@Controller("/api/v1/wallet")
export class WalletController {
  constructor(private readonly walletHttpService: WalletHttpService) {}

  @Post("/deposit-addresses")
  async createDepositAddress(@Body() body: CreateDepositAddressRequestDto) {
    return this.walletHttpService.createDepositAddress(body);
  }

  @Get("/deposit-addresses")
  async listDepositAddresses(@Query() query: ListDepositAddressesQueryDto) {
    return this.walletHttpService.listDepositAddresses({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      address: query.address,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/withdrawal-address-book")
  async createWithdrawalAddressBookEntry(
    @Body() body: CreateWithdrawalAddressBookEntryRequestDto
  ) {
    return this.walletHttpService.createWithdrawalAddressBookEntry(body);
  }

  @Get("/withdrawal-address-book")
  async listWithdrawalAddressBookEntries(@Query() query: ListWithdrawalAddressBookQueryDto) {
    return this.walletHttpService.listWithdrawalAddressBookEntries({
      userId: query.userId,
      network: query.network,
      address: query.address,
      isWhitelisted: parseOptionalBoolean(query.isWhitelisted),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/withdrawal-address-book/:addressBookId/whitelist")
  async whitelistWithdrawalAddress(@Param("addressBookId") addressBookId: string) {
    return this.walletHttpService.whitelistWithdrawalAddress(addressBookId);
  }

  @Post("/withdrawal-address-book/:addressBookId/unwhitelist")
  async unwhitelistWithdrawalAddress(@Param("addressBookId") addressBookId: string) {
    return this.walletHttpService.unwhitelistWithdrawalAddress(addressBookId);
  }

  @Post("/deposits/confirm")
  async confirmDeposit(@Body() body: ConfirmDepositRequestDto) {
    return this.walletHttpService.confirmDeposit(body);
  }

  @Get("/deposits")
  async listDeposits(@Query() query: ListDepositsQueryDto) {
    return this.walletHttpService.listDeposits({
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

  @Get("/deposits/:depositId")
  async getDeposit(@Param("depositId") depositId: string) {
    const deposit = await this.walletHttpService.getDeposit(depositId);

    if (!deposit) {
      throw new NotFoundException(`Deposit ${depositId} not found`);
    }

    return deposit;
  }

  @Post("/withdrawals/request")
  async requestWithdrawal(@Body() body: RequestWithdrawalRequestDto) {
    return this.walletHttpService.requestWithdrawal(body);
  }

  @Post("/withdrawals/validate")
  async validateWithdrawal(@Body() body: RequestWithdrawalRequestDto) {
    return this.walletHttpService.validateWithdrawalRequest(body);
  }

  @Get("/withdrawal-limits")
  async getWithdrawalLimits(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.walletHttpService.getWithdrawalLimits(userId);
  }

  @Get("/withdrawals")
  async listWithdrawals(@Query() query: ListWithdrawalsQueryDto) {
    return this.walletHttpService.listWithdrawals({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      reviewStatus: query.reviewStatus,
      txHash: query.txHash,
      toAddress: query.toAddress,
      riskLevel: parseRiskLevel(query.riskLevel),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/withdrawals/review-queue")
  async listWithdrawalReviewQueue(@Query() query: ListWithdrawalsQueryDto) {
    return this.walletHttpService.listWithdrawalReviewQueue({
      userId: query.userId,
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      txHash: query.txHash,
      toAddress: query.toAddress,
      riskLevel: parseRiskLevel(query.riskLevel),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/withdrawals/:withdrawalId")
  async getWithdrawal(@Param("withdrawalId") withdrawalId: string) {
    const withdrawal = await this.walletHttpService.getWithdrawal(withdrawalId);

    if (!withdrawal) {
      throw new NotFoundException(`Withdrawal ${withdrawalId} not found`);
    }

    return withdrawal;
  }

  @Get("/withdrawals/:withdrawalId/audit-logs")
  async listWithdrawalAuditLogs(
    @Param("withdrawalId") withdrawalId: string,
    @Query() query: ListWithdrawalAuditLogsQueryDto
  ) {
    return this.walletHttpService.listWithdrawalAuditLogs({
      withdrawalId,
      action: query.action,
      operatorId: query.operatorId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/audit-logs")
  async searchWithdrawalAuditLogs(@Query() query: ListWithdrawalAuditLogsQueryDto) {
    return this.walletHttpService.listWithdrawalAuditLogs({
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

  @Post("/withdrawals/confirm")
  async confirmWithdrawal(@Body() body: ConfirmWithdrawalRequestDto) {
    return this.walletHttpService.confirmWithdrawal(body);
  }

  @Get("/notifications/unread-count")
  async countUnreadWalletNotifications(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.walletHttpService.countUnreadWalletNotifications(userId);
  }

  @Post("/notifications/read")
  async markWalletNotificationsRead(@Body() body: MarkWalletNotificationsReadRequestDto) {
    if (!body?.userId) {
      throw new BadRequestException("userId is required");
    }
    if (body.notificationIds !== undefined && !Array.isArray(body.notificationIds)) {
      throw new BadRequestException("notificationIds must be an array");
    }
    return this.walletHttpService.markWalletNotificationsRead({
      userId: body.userId,
      notificationIds: body.notificationIds
    });
  }

  @Get("/notifications")
  async listWalletNotifications(@Query() query: ListWalletNotificationsQueryDto) {
    return this.walletHttpService.listWalletNotifications({
      userId: query.userId,
      withdrawalId: query.withdrawalId,
      depositId: query.depositId,
      eventType: query.eventType,
      status: query.status,
      channel: query.channel,
      readState:
        query.readState === "read" || query.readState === "unread" ? query.readState : undefined,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/ops/notifications/deliver")
  async deliverNotifications(@Body() body: DeliverWalletNotificationsRequestDto) {
    return this.walletHttpService.deliverNotifications(body);
  }

  @Post("/ops/withdrawals/reconcile-stale")
  async reconcileStaleWithdrawals(@Body() body: ReconcileStaleWithdrawalsRequestDto) {
    return this.walletHttpService.reconcileStaleWithdrawals(body);
  }

  @Post("/withdrawals/:withdrawalId/approve")
  async approveWithdrawal(
    @Param("withdrawalId") withdrawalId: string,
    @Body() body: ApproveWithdrawalRequestDto
  ) {
    return this.walletHttpService.approveWithdrawal({
      withdrawalId,
      ...body
    });
  }

  @Post("/withdrawals/:withdrawalId/reject")
  async rejectWithdrawal(
    @Param("withdrawalId") withdrawalId: string,
    @Body() body: RejectWithdrawalRequestDto
  ) {
    return this.walletHttpService.rejectWithdrawal({
      withdrawalId,
      ...body
    });
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseRiskLevel(value: string | undefined): WithdrawalRiskLevel | undefined {
  return isWithdrawalRiskLevel(value) ? value : undefined;
}
