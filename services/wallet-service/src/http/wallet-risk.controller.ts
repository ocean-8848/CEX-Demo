import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseFilters } from "@nestjs/common";

import { isAddressBlacklistCategory } from "../domain/withdrawal-risk.js";
import type {
  AddAddressBlacklistEntryRequestDto,
  CreateSecurityNotificationRequestDto,
  ListAddressBlacklistQueryDto,
  RemoveAddressBlacklistEntryRequestDto
} from "./dto.js";
import { WalletExceptionFilter } from "./wallet-exception.filter.js";
import { WalletHttpService } from "./wallet-http.service.js";

/**
 * Simplified KYT (withdrawal address risk) and account-security inbox
 * notifications. Internal only: every route is protected by the global
 * internal-service HMAC guard; ops-console and identity-service are the callers.
 */
@UseFilters(WalletExceptionFilter)
@Controller("/api/v1/wallet")
export class WalletRiskController {
  constructor(private readonly walletHttpService: WalletHttpService) {}

  @Get("/risk/address-blacklist")
  async listAddressBlacklist(@Query() query: ListAddressBlacklistQueryDto) {
    return this.walletHttpService.listAddressBlacklist({
      network: query.network,
      address: query.address,
      status: query.status === "active" || query.status === "removed" ? query.status : undefined,
      category: isAddressBlacklistCategory(query.category) ? query.category : undefined,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/risk/address-blacklist")
  async addAddressBlacklistEntry(@Body() body: AddAddressBlacklistEntryRequestDto) {
    if (!body?.network || !body.address) {
      throw new BadRequestException("network and address are required");
    }
    return this.walletHttpService.addAddressBlacklistEntry({
      network: body.network,
      address: body.address,
      category: body.category ?? "",
      reason: body.reason ?? "",
      createdBy: body.createdBy
    });
  }

  @Post("/risk/address-blacklist/:entryId/remove")
  async removeAddressBlacklistEntry(
    @Param("entryId") entryId: string,
    @Body() body: RemoveAddressBlacklistEntryRequestDto
  ) {
    return this.walletHttpService.removeAddressBlacklistEntry({
      entryId,
      reason: body?.reason ?? "",
      removedBy: body?.removedBy
    });
  }

  @Get("/risk/address-labels")
  async listAddressRiskLabels() {
    return { items: this.walletHttpService.listAddressRiskLabels() };
  }

  @Post("/notifications/security")
  async createSecurityNotification(@Body() body: CreateSecurityNotificationRequestDto) {
    if (!body?.userId || body.eventType !== "security.new_device_login") {
      throw new BadRequestException("userId and eventType=security.new_device_login are required");
    }
    return this.walletHttpService.createSecurityNotification({
      userId: body.userId,
      eventType: body.eventType,
      subject: body.subject ?? "",
      body: body.body ?? "",
      payload: body.payload
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
