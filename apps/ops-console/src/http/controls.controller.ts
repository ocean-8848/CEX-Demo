import { Body, Controller, Get, Post, Query, UseFilters, UseGuards } from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";
import { CONTROLS_MANAGE_PERMISSION } from "../domain/controls.js";
import { CurrentOpsSession, RequireOpsPermissions } from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

/**
 * 系统运维 → 紧急开关 and 账本对账 → 定时对账 / 熔断. Every ops role can read;
 * switching needs ops.controls.manage (ops_admin), running a reconciliation
 * needs ops.ledger.execute. Changes go to the ops action audit log.
 */
@UseFilters(OpsConsoleExceptionFilter)
@UseGuards(OpsAuthGuard)
@Controller("/api/v1/ops")
export class ControlsController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  private get controls() {
    return this.opsConsoleHttpService.controls;
  }

  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/controls")
  async getControls() {
    return this.controls.getControls();
  }

  /** `{ scope, assetCode?, enabled, reason }` — reason is required both ways. */
  @RequireOpsPermissions(CONTROLS_MANAGE_PERMISSION)
  @Post("/controls")
  async setControl(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: { scope?: string; assetCode?: string; enabled?: unknown; reason?: string }
  ) {
    return this.controls.setControl(session, {
      scope: body?.scope,
      assetCode: typeof body?.assetCode === "string" ? body.assetCode : undefined,
      enabled: body?.enabled,
      reason: typeof body?.reason === "string" ? body.reason : undefined
    });
  }

  @RequireOpsPermissions("ops.ledger.read")
  @Get("/ledger/reconciliation/runs")
  async listReconciliationRuns(@Query("limit") limit?: string) {
    const parsed = Number(limit ?? "20");
    return this.controls.getReconciliation(Number.isFinite(parsed) ? parsed : 20);
  }

  @RequireOpsPermissions("ops.ledger.execute")
  @Post("/ledger/reconciliation/jobs/run")
  async runReconciliationJob(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.controls.runReconciliation(session);
  }
}
