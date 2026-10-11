import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseFilters
} from "@nestjs/common";
import type { Network } from "@web3-cex/domain";

import type {
  ClearFaultInjectionRequestDto,
  CreateTransferRequestDto,
  InjectFaultRequestDto,
  ProbeBroadcastRequestDto,
  RetryTransferRequestDto,
  SyncTransferStatusRequestDto
} from "./dto.js";
import { CustodyExceptionFilter } from "./custody-exception.filter.js";
import { CustodyHttpService } from "./custody-http.service.js";

@UseFilters(CustodyExceptionFilter)
@Controller("/api/v1/custody")
export class CustodyController {
  constructor(private readonly custodyHttpService: CustodyHttpService) {}

  @Post("/transfers")
  async createTransfer(@Body() body: CreateTransferRequestDto) {
    return this.custodyHttpService.createTransfer(body);
  }

  @Post("/transfers/:custodyTransferId/retry")
  async retryTransfer(
    @Param("custodyTransferId") custodyTransferId: string,
    @Body() body: RetryTransferRequestDto
  ) {
    return this.custodyHttpService.retryTransfer({
      custodyTransferId,
      ...body
    });
  }

  @Post("/transfers/:custodyTransferId/sync-status")
  async syncTransferStatus(
    @Param("custodyTransferId") custodyTransferId: string,
    @Body() body: SyncTransferStatusRequestDto
  ) {
    return this.custodyHttpService.syncTransferStatus({
      custodyTransferId,
      ...body
    });
  }

  @Get("/transfers/:custodyTransferId")
  async getTransfer(@Param("custodyTransferId") custodyTransferId: string) {
    const transfer = await this.custodyHttpService.getTransfer(custodyTransferId);

    if (!transfer) {
      throw new NotFoundException(`Transfer ${custodyTransferId} not found`);
    }

    return transfer;
  }

  @Post("/providers/health/check")
  async runProviderHealthChecks() {
    return this.custodyHttpService.runProviderHealthChecks();
  }

  @Get("/providers/health")
  async getProviderHealth() {
    return this.custodyHttpService.getProviderHealth();
  }

  @Get("/ops/overview")
  async getOpsOverview() {
    return this.custodyHttpService.getOpsOverview();
  }

  @Get("/ops/report")
  async getOpsReport() {
    return this.custodyHttpService.getOpsReport();
  }

  @Get("/lab/state")
  async getFaultLabState(@Query("network") network?: string) {
    return this.custodyHttpService.getFaultLabState(parseNetwork(network));
  }

  @Post("/lab/failure-injection")
  async injectProviderFailure(@Body() body: InjectFaultRequestDto) {
    const durationSeconds = Number(body?.durationSeconds);
    return this.custodyHttpService.injectProviderFailure({
      providerName: body?.providerName,
      durationMs:
        Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : undefined,
      reason: body?.reason,
      requestedBy: body?.requestedBy
    });
  }

  @Post("/lab/failure-injection/clear")
  async clearProviderFailure(@Body() body: ClearFaultInjectionRequestDto) {
    return this.custodyHttpService.clearProviderFailure(body?.providerName || undefined);
  }

  @Post("/lab/probe-broadcast")
  async probeBroadcast(@Body() body: ProbeBroadcastRequestDto) {
    const count = Number(body?.count);
    return this.custodyHttpService.probeBroadcast({
      network: parseNetwork(body?.network),
      count: Number.isFinite(count) && count > 0 ? count : undefined
    });
  }
}

function parseNetwork(value: string | undefined): Network | undefined {
  return value === "ethereum" || value === "bsc" || value === "base" ? value : undefined;
}
