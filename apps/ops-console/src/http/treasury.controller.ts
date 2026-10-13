import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";
import {
  TREASURY_EXECUTE_PERMISSION,
  TREASURY_READ_PERMISSION,
  TREASURY_REVIEW_PERMISSION
} from "../domain/treasury.js";
import { CurrentOpsSession, RequireOpsPermissions } from "./ops-auth.decorator.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

type Body_ = Record<string, unknown> | undefined;

/** 风控与运维 → 钱包与储备金. */
@UseFilters(OpsConsoleExceptionFilter)
@UseGuards(OpsAuthGuard)
@Controller("/api/v1/ops/treasury")
export class TreasuryController {
  constructor(private readonly opsConsoleHttpService: OpsConsoleHttpService) {}

  private get treasury() {
    return this.opsConsoleHttpService.treasury;
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/overview")
  async getOverview() {
    return this.treasury.getOverview();
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/transfers")
  async listTransfers(@Query() query: Record<string, string | undefined>) {
    return this.treasury.listTransfers({
      kind: query.kind || undefined,
      status: query.status || undefined,
      statuses: query.statuses || undefined,
      assetCode: query.assetCode || undefined,
      limit: query.limit || undefined,
      offset: query.offset || undefined
    });
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/transfers/:transferId")
  async getTransfer(@Param("transferId") transferId: string) {
    return this.treasury.getTransfer(transferId);
  }

  @RequireOpsPermissions(TREASURY_EXECUTE_PERMISSION)
  @Post("/transfers")
  async proposeTransfer(@CurrentOpsSession() session: OpsSessionInfo, @Body() body: Body_) {
    return this.treasury.proposeTransfer(session, {
      kind: text(body?.kind),
      assetCode: text(body?.assetCode),
      network: text(body?.network) || undefined,
      amount: text(body?.amount),
      reason: text(body?.reason) || undefined
    });
  }

  @RequireOpsPermissions(TREASURY_REVIEW_PERMISSION)
  @Post("/transfers/:transferId/approve")
  async approveTransfer(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("transferId") transferId: string,
    @Body() body: Body_
  ) {
    return this.treasury.approveTransfer(session, transferId, { note: text(body?.note) || text(body?.reason) || undefined });
  }

  @RequireOpsPermissions(TREASURY_REVIEW_PERMISSION)
  @Post("/transfers/:transferId/reject")
  async rejectTransfer(
    @CurrentOpsSession() session: OpsSessionInfo,
    @Param("transferId") transferId: string,
    @Body() body: Body_
  ) {
    return this.treasury.rejectTransfer(session, transferId, { reason: text(body?.reason) || undefined });
  }

  @RequireOpsPermissions(TREASURY_EXECUTE_PERMISSION)
  @Post("/transfers/:transferId/retry")
  async retryTransfer(@CurrentOpsSession() session: OpsSessionInfo, @Param("transferId") transferId: string) {
    return this.treasury.retryTransfer(session, transferId);
  }

  @RequireOpsPermissions(TREASURY_EXECUTE_PERMISSION)
  @Post("/sweeps/run")
  async runSweeps(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.treasury.runSweeps(session);
  }

  @RequireOpsPermissions(TREASURY_EXECUTE_PERMISSION)
  @Post("/watermarks/evaluate")
  async evaluateWatermarks(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.treasury.evaluateWatermarks(session);
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/reconciliation")
  async getReconciliation() {
    return this.treasury.getReconciliation();
  }

  @RequireOpsPermissions(TREASURY_EXECUTE_PERMISSION)
  @Post("/proof-of-reserves/snapshots")
  async generateProofOfReserves(@CurrentOpsSession() session: OpsSessionInfo) {
    return this.treasury.generateProofOfReserves(session);
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/proof-of-reserves/snapshots")
  async listProofOfReservesSnapshots(@Query("limit") limit?: string) {
    const parsed = Number(limit);
    return this.treasury.listProofOfReservesSnapshots(Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
  }

  @RequireOpsPermissions(TREASURY_READ_PERMISSION)
  @Get("/proof-of-reserves/snapshots/:snapshotId")
  async getProofOfReservesSnapshot(@Param("snapshotId") snapshotId: string) {
    return this.treasury.getProofOfReservesSnapshot(snapshotId);
  }
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
