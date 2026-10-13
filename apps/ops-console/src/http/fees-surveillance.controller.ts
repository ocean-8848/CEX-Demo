import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from "@nestjs/common";

import {
  FEE_TIER_MANAGE_PERMISSION,
  SURVEILLANCE_MANAGE_PERMISSION,
  SURVEILLANCE_READ_PERMISSION
} from "../application/fees-surveillance-application-service.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import { CurrentOpsSession, RequireOpsPermissions } from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

/**
 * 用户详情 → 手续费等级 (A7) and 风控与运维 → 市场监控 (A9). Writes are
 * written to the ops action audit log.
 */
@UseFilters(OpsConsoleExceptionFilter)
@UseGuards(OpsAuthGuard)
@Controller("/api/v1/ops")
export class FeesSurveillanceController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  private get service() {
    return this.opsConsoleHttpService.feesSurveillance;
  }

  @RequireOpsPermissions("ops.users.read")
  @Get("/fee-tiers")
  async getFeeTierConfig() {
    return this.service.getFeeTierConfig();
  }

  @RequireOpsPermissions("ops.users.read")
  @Get("/users/:userId/fee-tier")
  async getUserFeeTier(@Param("userId") userId: string) {
    return this.service.getUserFeeTier(userId);
  }

  @RequireOpsPermissions(FEE_TIER_MANAGE_PERMISSION)
  @Post("/users/:userId/fee-tier/override")
  async setFeeTierOverride(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("userId") userId: string,
    @Body() body: { tier?: string; note?: string }
  ) {
    return this.service.setFeeTierOverride(session, userId, body ?? {});
  }

  @RequireOpsPermissions(FEE_TIER_MANAGE_PERMISSION)
  @Post("/users/:userId/fee-tier/override/clear")
  async clearFeeTierOverride(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("userId") userId: string,
    @Body() body: { note?: string }
  ) {
    return this.service.clearFeeTierOverride(session, userId, body ?? {});
  }

  @RequireOpsPermissions(SURVEILLANCE_READ_PERMISSION)
  @Get("/surveillance/overview")
  async getSurveillanceOverview() {
    return this.service.getSurveillanceOverview();
  }

  @RequireOpsPermissions(SURVEILLANCE_READ_PERMISSION)
  @Get("/surveillance/alerts")
  async listSurveillanceAlerts(
    @Query()
    query: {
      type?: string;
      status?: string;
      market?: string;
      userId?: string;
      includeMarketMakers?: string;
      limit?: string;
      offset?: string;
    }
  ) {
    return this.service.listSurveillanceAlerts({
      type: query.type,
      status: query.status,
      market: query.market,
      userId: query.userId,
      includeMarketMakers: query.includeMarketMakers,
      limit: query.limit,
      offset: query.offset
    });
  }

  @RequireOpsPermissions(SURVEILLANCE_READ_PERMISSION)
  @Get("/surveillance/alerts/:alertId")
  async getSurveillanceAlert(@Param("alertId") alertId: string) {
    return this.service.getSurveillanceAlert(alertId);
  }

  @RequireOpsPermissions(SURVEILLANCE_MANAGE_PERMISSION)
  @Post("/surveillance/alerts/:alertId/status")
  async updateSurveillanceAlertStatus(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("alertId") alertId: string,
    @Body() body: { status?: string; note?: string }
  ) {
    return this.service.updateSurveillanceAlertStatus(session, alertId, body ?? {});
  }

  @RequireOpsPermissions(SURVEILLANCE_MANAGE_PERMISSION)
  @Post("/surveillance/scan")
  async runSurveillanceScan(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.service.runSurveillanceScan(session);
  }
}
