import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";
import { OPS_RISK_MANAGE, OPS_RISK_READ } from "../domain/risk-security.js";
import { CurrentOpsSession, RequireOpsPermissions } from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

interface AddBlacklistBody {
  network?: string;
  address?: string;
  category?: string;
  reason?: string;
}

/**
 * 用户与资产 → 地址黑名单 (simplified KYT) and the login history / devices
 * section of the user drawer.
 */
@UseFilters(OpsConsoleExceptionFilter)
@UseGuards(OpsAuthGuard)
@Controller("/api/v1/ops")
export class OpsRiskSecurityController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  private get service() {
    return this.opsConsoleHttpService.riskSecurity;
  }

  @RequireOpsPermissions(OPS_RISK_READ)
  @Get("/risk/address-blacklist")
  async listAddressBlacklist(
    @Query("network") network?: string,
    @Query("address") address?: string,
    @Query("status") status?: string,
    @Query("category") category?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.service.listAddressBlacklist({
      network: network || undefined,
      address: address || undefined,
      status: status || undefined,
      category: category || undefined,
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset)
    });
  }

  @RequireOpsPermissions(OPS_RISK_READ)
  @Get("/risk/address-labels")
  async listAddressRiskLabels() {
    return this.service.listAddressRiskLabels();
  }

  @RequireOpsPermissions(OPS_RISK_MANAGE)
  @Post("/risk/address-blacklist")
  async addAddressBlacklistEntry(@CurrentOpsSession() session: OpsSessionInfo, @Body() body: AddBlacklistBody) {
    return this.service.addAddressBlacklistEntry(session, {
      network: body?.network ?? "",
      address: body?.address ?? "",
      category: body?.category ?? "",
      reason: body?.reason ?? ""
    });
  }

  @RequireOpsPermissions(OPS_RISK_MANAGE)
  @Post("/risk/address-blacklist/:entryId/remove")
  async removeAddressBlacklistEntry(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("entryId") entryId: string,
    @Body() body: { reason?: string }
  ) {
    return this.service.removeAddressBlacklistEntry(session, { entryId, reason: body?.reason ?? "" });
  }

  @RequireOpsPermissions("ops.users.read")
  @Get("/users/:userId/login-events")
  async listUserLoginEvents(
    @Param("userId") userId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.service.listUserLoginEvents(userId, {
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset)
    });
  }

  @RequireOpsPermissions("ops.users.read")
  @Get("/users/:userId/devices")
  async listUserDevices(@Param("userId") userId: string) {
    return this.service.listUserDevices(userId);
  }

  @RequireOpsPermissions("ops.users.freeze")
  @Post("/users/:userId/devices/:deviceId/revoke")
  async revokeUserDevice(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("userId") userId: string,
    @Param("deviceId") deviceId: string
  ) {
    return this.service.revokeUserDevice(session, userId, deviceId);
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
