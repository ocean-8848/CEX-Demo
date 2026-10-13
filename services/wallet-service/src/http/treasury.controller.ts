import { Body, Controller, Get, Param, Post, Query, UseFilters } from "@nestjs/common";

import type { ListTreasuryTransfersQuery, TreasuryTransferKind, TreasuryTransferStatus } from "../domain/treasury-types.js";
import { TreasuryExceptionFilter } from "./treasury-exception.filter.js";
import { TreasuryHttpService } from "./treasury-http.service.js";

type Body_ = Record<string, unknown> | undefined;

/**
 * Custody layering, sweeps, hot-wallet watermarks, wallet-vs-ledger
 * reconciliation and proof of reserves. Internal only (HMAC guard as every
 * wallet route): ops-console operates it, demo-simulator drives the sweep /
 * watermark jobs and reports chain confirmations, api-gateway reads a user's
 * own proof.
 */
@UseFilters(TreasuryExceptionFilter)
@Controller("/api/v1/wallet/treasury")
export class TreasuryController {
  constructor(private readonly treasuryHttpService: TreasuryHttpService) {}

  private get treasury() {
    return this.treasuryHttpService.treasury;
  }

  @Get("/overview")
  async getOverview() {
    return this.treasury.getOverview();
  }

  @Get("/transfers")
  async listTransfers(@Query() query: Record<string, string | undefined>) {
    const statuses = query.statuses ? (query.statuses.split(",").filter(Boolean) as TreasuryTransferStatus[]) : undefined;
    const filter: ListTreasuryTransfersQuery = {
      kind: (query.kind || undefined) as TreasuryTransferKind | undefined,
      status: (query.status || undefined) as TreasuryTransferStatus | undefined,
      statuses,
      assetCode: query.assetCode || undefined,
      network: (query.network || undefined) as ListTreasuryTransfersQuery["network"],
      txHash: query.txHash || undefined,
      limit: optionalNumber(query.limit),
      offset: optionalNumber(query.offset)
    };
    return this.treasury.listTransfers(filter);
  }

  @Post("/transfers")
  async proposeTransfer(@Body() body: Body_) {
    return this.treasury.proposeTransfer({
      kind: text(body?.kind),
      assetCode: text(body?.assetCode),
      network: text(body?.network) || undefined,
      amount: text(body?.amount),
      requestedBy: text(body?.requestedBy),
      reason: text(body?.reason) || undefined
    });
  }

  @Post("/transfers/confirm")
  async confirmTransfer(@Body() body: Body_) {
    return this.treasury.confirmTransfer({
      network: text(body?.network),
      txHash: text(body?.txHash),
      confirmations: Number(body?.confirmations ?? 0),
      blockNumber: optionalNumber(body?.blockNumber)
    });
  }

  @Get("/transfers/:transferId")
  async getTransfer(@Param("transferId") transferId: string) {
    return this.treasury.getTransfer(transferId);
  }

  @Post("/transfers/:transferId/approve")
  async approveTransfer(@Param("transferId") transferId: string, @Body() body: Body_) {
    return this.treasury.approveTransfer(transferId, {
      reviewedBy: text(body?.reviewedBy),
      note: text(body?.note) || undefined
    });
  }

  @Post("/transfers/:transferId/reject")
  async rejectTransfer(@Param("transferId") transferId: string, @Body() body: Body_) {
    return this.treasury.rejectTransfer(transferId, {
      reviewedBy: text(body?.reviewedBy),
      reason: text(body?.reason) || undefined
    });
  }

  @Post("/transfers/:transferId/retry")
  async retryTransfer(@Param("transferId") transferId: string, @Body() body: Body_) {
    return this.treasury.retryTransfer(transferId, { requestedBy: text(body?.requestedBy) || "system" });
  }

  @Post("/sweeps/run")
  async runSweeps(@Body() body: Body_) {
    return this.treasury.runSweeps({ requestedBy: text(body?.requestedBy) || undefined });
  }

  @Post("/watermarks/evaluate")
  async evaluateWatermarks(@Body() body: Body_) {
    return this.treasury.evaluateWatermarks({ requestedBy: text(body?.requestedBy) || undefined });
  }

  @Post("/genesis")
  async recordGenesis(@Body() body: Body_) {
    return this.treasury.recordGenesis({
      assetCode: text(body?.assetCode),
      network: text(body?.network) || undefined,
      walletType: text(body?.walletType),
      amount: text(body?.amount),
      reference: text(body?.reference),
      requestedBy: text(body?.requestedBy) || undefined,
      note: text(body?.note) || undefined
    });
  }

  @Get("/reconciliation")
  async getReconciliation() {
    return this.treasury.getReconciliation();
  }

  @Post("/proof-of-reserves/snapshots")
  async generateProofOfReserves(@Body() body: Body_) {
    return this.treasury.generateProofOfReserves({ generatedBy: text(body?.generatedBy) || undefined });
  }

  @Get("/proof-of-reserves/snapshots")
  async listProofOfReservesSnapshots(@Query("limit") limit?: string) {
    return { items: await this.treasury.listProofOfReservesSnapshots(optionalNumber(limit) ?? 20) };
  }

  @Get("/proof-of-reserves/snapshots/:snapshotId")
  async getProofOfReservesSnapshot(@Param("snapshotId") snapshotId: string) {
    return this.treasury.getProofOfReservesSnapshot(snapshotId);
  }

  @Get("/proof-of-reserves/me")
  async getUserProof(@Query("userId") userId?: string) {
    return this.treasury.getUserProof(userId ?? "");
  }
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
