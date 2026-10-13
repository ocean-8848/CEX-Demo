import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";

import type { GatewayPrincipal, GatewayStatementCategory } from "../domain/types.js";
import {
  CurrentGatewayAuth,
  PublicGatewayRoute,
  RequireApiKeyScope,
  SessionOnlyRoute
} from "./api-gateway-auth.decorator.js";
import { ApiGatewayAuthGuard } from "./api-gateway-auth.guard.js";
import { ApiGatewayAuditInterceptor } from "./api-gateway-audit.interceptor.js";
import { ApiGatewayControlSwitchGuard, ControlledWrite } from "./api-gateway-control-switch.guard.js";
import { ApiGatewayExceptionFilter } from "./api-gateway-exception.filter.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";
import { GatewayIdempotentRoute } from "./api-gateway-idempotency.decorator.js";
import { ApiGatewayIdempotencyInterceptor } from "./api-gateway-idempotency.interceptor.js";
import { ApiGatewayRateLimitGuard } from "./api-gateway-rate-limit.guard.js";
import { type ClientIpRequest, resolveSessionIp } from "./client-ip.js";
import type {
  CreateApiKeyRequestDto,
  CreateCustomerSessionRequestDto,
  CreateDepositAddressRequestDto,
  CreateSpotOrderRequestDto,
  CreateWithdrawalAddressBookEntryRequestDto,
  GetLedgerStatementQueryDto,
  ListBalancesQueryDto,
  ListDepositAddressesQueryDto,
  ListDepositsQueryDto,
  ListSpotOrdersQueryDto,
  ListSpotTradesQueryDto,
  ListWalletNotificationsQueryDto,
  ListWithdrawalAddressBookQueryDto,
  ListWithdrawalsQueryDto,
  RegisterCustomerRequestDto,
  RequestWithdrawalRequestDto,
  SubmitKycRequestDto,
  TwoFactorCodeRequestDto,
  ValidateWithdrawalRequestDto
} from "./dto.js";

@UseFilters(ApiGatewayExceptionFilter)
@UseGuards(ApiGatewayAuthGuard, ApiGatewayRateLimitGuard, ApiGatewayControlSwitchGuard)
@UseInterceptors(ApiGatewayAuditInterceptor, ApiGatewayIdempotencyInterceptor)
@Controller("/api/v1/gateway")
export class ApiGatewayController {
  constructor(private readonly apiGatewayHttpService: ApiGatewayHttpService) {}

  @PublicGatewayRoute()
  @Post("/auth/register")
  async registerCustomer(@Body() body: RegisterCustomerRequestDto) {
    return this.apiGatewayHttpService.registerCustomer(body);
  }

  @PublicGatewayRoute()
  @Post("/auth/sessions")
  async createCustomerSession(
    @Body() body: CreateCustomerSessionRequestDto,
    @Req() request: ClientIpRequest,
    @Headers("user-agent") userAgent?: string
  ) {
    return this.apiGatewayHttpService.createCustomerSession({
      ...body,
      userAgent,
      ipAddress: resolveSessionIp(request)
    });
  }

  @Get("/auth/me")
  async getCurrentAuth(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return principal;
  }

  @SessionOnlyRoute()
  @Post("/auth/logout")
  async logout(@Headers("authorization") authorization?: string) {
    return this.apiGatewayHttpService.logoutCustomerSession(readBearerToken(authorization));
  }

  @SessionOnlyRoute()
  @GatewayIdempotentRoute()
  @Post("/auth/api-keys")
  async createApiKey(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: CreateApiKeyRequestDto
  ) {
    return this.apiGatewayHttpService.createApiKey(principal, body);
  }

  @SessionOnlyRoute()
  @Get("/auth/api-keys")
  async listApiKeys(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.listApiKeys(principal);
  }

  @SessionOnlyRoute()
  @Post("/auth/api-keys/:apiKeyId/revoke")
  async revokeApiKey(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("apiKeyId") apiKeyId: string
  ) {
    return this.apiGatewayHttpService.revokeApiKey(principal, apiKeyId);
  }

  // M4-1 self-service 2FA: session-only, so an API key can never turn 2FA off.
  @SessionOnlyRoute()
  @Get("/auth/two-factor")
  async getTwoFactorStatus(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.getTwoFactorStatus(principal);
  }

  @SessionOnlyRoute()
  @Post("/auth/two-factor/enroll")
  async enrollTwoFactor(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.enrollTwoFactor(principal);
  }

  @SessionOnlyRoute()
  @Post("/auth/two-factor/enable")
  async enableTwoFactor(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: TwoFactorCodeRequestDto
  ) {
    return this.apiGatewayHttpService.enableTwoFactor(principal, body?.code);
  }

  @SessionOnlyRoute()
  @Post("/auth/two-factor/disable")
  async disableTwoFactor(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: TwoFactorCodeRequestDto
  ) {
    return this.apiGatewayHttpService.disableTwoFactor(principal, body?.code);
  }

  @SessionOnlyRoute()
  @Post("/auth/two-factor/recovery-codes")
  async regenerateRecoveryCodes(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: TwoFactorCodeRequestDto
  ) {
    return this.apiGatewayHttpService.regenerateRecoveryCodes(principal, body?.code);
  }

  // Login history and device management: session-only, an API key cannot
  // revoke the owner's browser sessions.
  @SessionOnlyRoute()
  @Get("/auth/login-events")
  async listLoginEvents(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.apiGatewayHttpService.listLoginEvents(principal, {
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset)
    });
  }

  @SessionOnlyRoute()
  @Get("/auth/devices")
  async listDevices(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.listDevices(principal);
  }

  @SessionOnlyRoute()
  @Post("/auth/devices/:deviceId/revoke")
  async revokeDevice(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("deviceId") deviceId: string
  ) {
    return this.apiGatewayHttpService.revokeDevice(principal, deviceId);
  }

  // M4-4 KYC tier (demo data only).
  @SessionOnlyRoute()
  @Get("/auth/kyc")
  async getKycProfile(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.getKycProfile(principal);
  }

  @SessionOnlyRoute()
  @Post("/auth/kyc/requests")
  async submitKycRequest(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: SubmitKycRequestDto
  ) {
    return this.apiGatewayHttpService.submitKycRequest(principal, body ?? {});
  }

  @Get("/proof-of-reserves")
  async getProofOfReserves(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.getProofOfReserves(principal);
  }

  @Get("/withdrawals/limits")
  async getWithdrawalLimits(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.getWithdrawalLimits(principal);
  }

  @Get("/accounts/spot")
  async getSpotAccount(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.ensureSpotAccount(principal);
  }

  @Get("/balances")
  async listBalances(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListBalancesQueryDto
  ) {
    return this.apiGatewayHttpService.listBalances(principal, {
      accountId: query.accountId,
      assetCode: query.assetCode,
      accountType: query.accountType,
      accountStatus: query.accountStatus,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @RequireApiKeyScope("read")
  @Post("/deposit-addresses")
  @GatewayIdempotentRoute()
  async createDepositAddress(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: CreateDepositAddressRequestDto
  ) {
    return this.apiGatewayHttpService.createDepositAddress(principal, body);
  }

  @Get("/deposit-addresses")
  async listDepositAddresses(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListDepositAddressesQueryDto
  ) {
    return this.apiGatewayHttpService.listDepositAddresses(principal, {
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      address: query.address,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/deposits")
  async listDeposits(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListDepositsQueryDto
  ) {
    return this.apiGatewayHttpService.listDeposits(principal, {
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
  async getDeposit(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("depositId") depositId: string
  ) {
    return this.apiGatewayHttpService.getDeposit(principal, depositId);
  }

  @Get("/withdrawals")
  async listWithdrawals(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListWithdrawalsQueryDto
  ) {
    return this.apiGatewayHttpService.listWithdrawals(principal, {
      ledgerAccountId: query.ledgerAccountId,
      assetCode: query.assetCode,
      network: query.network,
      status: query.status,
      reviewStatus: query.reviewStatus,
      txHash: query.txHash,
      toAddress: query.toAddress,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/withdrawals/:withdrawalId")
  async getWithdrawal(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("withdrawalId") withdrawalId: string
  ) {
    return this.apiGatewayHttpService.getWithdrawal(principal, withdrawalId);
  }

  @RequireApiKeyScope("withdraw")
  @ControlledWrite("withdrawal")
  @Post("/withdrawals/validate")
  async validateWithdrawal(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: ValidateWithdrawalRequestDto
  ) {
    return this.apiGatewayHttpService.validateWithdrawal(principal, body);
  }

  @RequireApiKeyScope("withdraw")
  @ControlledWrite("withdrawal")
  @Post("/withdrawals/request")
  @GatewayIdempotentRoute()
  async requestWithdrawal(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: RequestWithdrawalRequestDto
  ) {
    return this.apiGatewayHttpService.requestWithdrawal(principal, body);
  }

  @Get("/withdrawal-address-book")
  async listWithdrawalAddressBook(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListWithdrawalAddressBookQueryDto
  ) {
    return this.apiGatewayHttpService.listWithdrawalAddressBook(principal, {
      network: query.network,
      address: query.address,
      isWhitelisted: parseOptionalBoolean(query.isWhitelisted),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @RequireApiKeyScope("withdraw")
  @Post("/withdrawal-address-book")
  @GatewayIdempotentRoute()
  async createWithdrawalAddressBookEntry(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: CreateWithdrawalAddressBookEntryRequestDto
  ) {
    return this.apiGatewayHttpService.createWithdrawalAddressBookEntry(principal, body);
  }

  @Get("/notifications")
  async listWalletNotifications(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListWalletNotificationsQueryDto
  ) {
    return this.apiGatewayHttpService.listWalletNotifications(principal, {
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

  // --- M4-2 notification center ---------------------------------------------

  @Get("/notifications/unread-count")
  async countUnreadWalletNotifications(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.countUnreadWalletNotifications(principal);
  }

  // Read markers only change the caller's own inbox, so "read" scope suffices.
  @RequireApiKeyScope("read")
  @Post("/notifications/read-all")
  async markAllWalletNotificationsRead(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return this.apiGatewayHttpService.markAllWalletNotificationsRead(principal);
  }

  @RequireApiKeyScope("read")
  @Post("/notifications/:notificationId/read")
  async markWalletNotificationRead(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("notificationId") notificationId: string
  ) {
    return this.apiGatewayHttpService.markWalletNotificationRead(principal, notificationId);
  }

  // --- M4-5 asset statement ---------------------------------------------------

  @Get("/ledger/entries")
  async getLedgerStatement(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: GetLedgerStatementQueryDto
  ) {
    return this.apiGatewayHttpService.getLedgerStatement(principal, {
      assetCode: query.assetCode || undefined,
      category: (query.category || undefined) as GatewayStatementCategory | undefined,
      businessType: query.businessType || undefined,
      includeLockEvents: parseOptionalBoolean(query.includeLockEvents),
      from: query.from || undefined,
      to: query.to || undefined,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @ControlledWrite("spot_order")
  @Post("/orders")
  @GatewayIdempotentRoute()
  async createOrder(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Body() body: CreateSpotOrderRequestDto,
    @Headers("idempotency-key") headerIdempotencyKey?: string
  ) {
    // Accept the key from either the body or the standard Idempotency-Key header,
    // so API clients don't have to send it twice.
    const idempotencyKey = body.idempotencyKey?.trim() || headerIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException(
        "idempotencyKey is required (request body field or Idempotency-Key header)"
      );
    }
    return this.apiGatewayHttpService.createOrder(principal, { ...body, idempotencyKey });
  }

  @Get("/orders")
  async listOrders(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListSpotOrdersQueryDto
  ) {
    return this.apiGatewayHttpService.listOrders(principal, {
      accountId: query.accountId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/orders/:orderId")
  async getOrder(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("orderId") orderId: string
  ) {
    return this.apiGatewayHttpService.getOrder(principal, orderId);
  }

  @Post("/orders/:orderId/cancel")
  async cancelOrder(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("orderId") orderId: string
  ) {
    return this.apiGatewayHttpService.cancelOrder(principal, orderId);
  }

  @Get("/trades")
  async listTrades(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Query() query: ListSpotTradesQueryDto
  ) {
    return this.apiGatewayHttpService.listTrades(principal, {
      market: query.market,
      orderId: query.orderId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/trades/:tradeId/journals")
  async getTradeJournals(
    @CurrentGatewayAuth() principal: GatewayPrincipal,
    @Param("tradeId") tradeId: string
  ) {
    return this.apiGatewayHttpService.getTradeJournals(principal, tradeId);
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

function readBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

