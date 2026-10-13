import { Body, Controller, Get, Post, Query, UseFilters, UseGuards } from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";
import { FAULT_LAB_PERMISSIONS } from "../domain/fault-lab.js";
import type {
  OpsFaultLabCustodyRequestDto,
  OpsFaultLabDurationRequestDto,
  OpsFaultLabEngineResetRequestDto,
  OpsFaultLabReorgRequestDto,
  OpsFaultLabSeedDepositRequestDto
} from "./dto.js";
import { CurrentOpsSession, RequireOpsPermissions } from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

/**
 * 系统运维 → 实验室 (M3-2). Reading the lab is open to every ops role; any
 * fault or recovery action needs all FAULT_LAB_PERMISSIONS (ops_admin) and is
 * written to the ops action audit log.
 */
@UseFilters(OpsConsoleExceptionFilter)
@UseGuards(OpsAuthGuard)
@Controller("/api/v1/ops/lab")
export class FaultLabController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  private get lab() {
    return this.opsConsoleHttpService.faultLab;
  }

  @RequireOpsPermissions("ops.dashboard.read")
  @Get("/status")
  async getStatus(@Query("market") market?: string) {
    return this.lab.getStatus({ market: market || undefined });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/settlement/pause")
  async pauseSettlement(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabDurationRequestDto
  ) {
    return this.lab.pauseSettlement(session, { durationSeconds: parseOptionalNumber(body?.durationSeconds) });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/settlement/resume")
  async resumeSettlement(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.lab.resumeSettlement(session);
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/custody/inject")
  async injectCustodyFailure(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabCustodyRequestDto
  ) {
    return this.lab.injectCustodyFailure(session, {
      providerName: body?.providerName,
      durationSeconds: parseOptionalNumber(body?.durationSeconds)
    });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/custody/probe")
  async probeCustody(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabCustodyRequestDto
  ) {
    return this.lab.probeCustody(session, { count: parseOptionalNumber(body?.count) });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/custody/clear")
  async clearCustodyFailure(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabCustodyRequestDto
  ) {
    return this.lab.clearCustodyFailure(session, { providerName: body?.providerName });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/chain/halt")
  async haltChain(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabDurationRequestDto
  ) {
    return this.lab.haltChain(session, { durationSeconds: parseOptionalNumber(body?.durationSeconds) });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/chain/resume")
  async resumeChain(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.lab.resumeChain(session);
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/chain/seed-deposit")
  async seedLabDeposit(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabSeedDepositRequestDto
  ) {
    return this.lab.seedLabDeposit(session, { confirmations: parseOptionalNumber(body?.confirmations) });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/chain/reorg")
  async triggerReorg(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabReorgRequestDto
  ) {
    return this.lab.triggerReorg(session, { depth: parseOptionalNumber(body?.depth) });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/indexer/reorg-acknowledge")
  async acknowledgeReorg(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.lab.acknowledgeReorg(session);
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/engine/reset")
  async resetEngine(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: OpsFaultLabEngineResetRequestDto
  ) {
    return this.lab.resetEngine(session, {
      market: body?.market,
      resetSequences: body?.resetSequences === true || body?.resetSequences === "true"
    });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/reconciliation/drift")
  async injectReconciliationDrift(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Body() body: { assetCode?: string; amount?: string | number }
  ) {
    return this.lab.injectReconciliationDrift(session, {
      assetCode: typeof body?.assetCode === "string" ? body.assetCode : undefined,
      amount: body?.amount === undefined ? undefined : String(body.amount)
    });
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/reconciliation/clear")
  async clearReconciliationDrift(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.lab.clearReconciliationDrift(session);
  }

  @RequireOpsPermissions(...FAULT_LAB_PERMISSIONS)
  @Post("/recover-all")
  async recoverAll(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.lab.recoverAll(session);
  }
}

function parseOptionalNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
