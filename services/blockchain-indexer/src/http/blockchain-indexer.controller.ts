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
  CloseDepositObservationRequestDto,
  GetScanCursorParamsDto,
  ListDepositObservationsQueryDto,
  ObserveDepositRequestDto,
  ObserveWithdrawalRequestDto,
  RepairIndexerBacklogRequestDto,
  ReplayDepositObservationRequestDto,
  ReplayEvmRequestDto,
  ScanEvmDepositsRequestDto,
  ScanEvmWithdrawalsRequestDto
} from "./dto.js";
import { BlockchainIndexerExceptionFilter } from "./blockchain-indexer-exception.filter.js";
import { BlockchainIndexerHttpService } from "./blockchain-indexer-http.service.js";

@UseFilters(BlockchainIndexerExceptionFilter)
@Controller("/api/v1/indexer")
export class BlockchainIndexerController {
  constructor(
    private readonly blockchainIndexerHttpService: BlockchainIndexerHttpService
  ) {}

  @Post("/deposits/observe")
  async observeDeposit(@Body() body: ObserveDepositRequestDto) {
    return this.blockchainIndexerHttpService.observeDeposit(body);
  }

  @Post("/evm/deposits/scan")
  async scanEvmDeposits(@Body() body: ScanEvmDepositsRequestDto) {
    return this.blockchainIndexerHttpService.scanEvmDeposits(body);
  }

  @Get("/deposits/:observationId")
  async getDepositObservation(@Param("observationId") observationId: string) {
    const observation =
      await this.blockchainIndexerHttpService.getDepositObservation(observationId);

    if (!observation) {
      throw new NotFoundException(`Observation ${observationId} not found`);
    }

    return observation;
  }

  @Get("/ops/pending-deposits")
  async listPendingDepositObservations(@Query() query: ListDepositObservationsQueryDto) {
    return this.blockchainIndexerHttpService.listDepositObservations({
      network: query.network,
      assetCode: query.assetCode,
      status: query.status ?? "pending",
      olderThanSeconds: parseOptionalNumber(query.olderThanSeconds),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/ops/pending-deposits/:observationId/replay")
  async replayDepositObservation(
    @Param("observationId") observationId: string,
    @Body() body: ReplayDepositObservationRequestDto
  ) {
    return this.blockchainIndexerHttpService.replayDepositObservation({
      observationId,
      confirmations: body.confirmations,
      blockNumber: body.blockNumber,
      blockHash: body.blockHash,
      operatedBy: body.operatedBy,
      note: body.note
    });
  }

  @Post("/ops/pending-deposits/:observationId/close")
  async closeDepositObservation(
    @Param("observationId") observationId: string,
    @Body() body: CloseDepositObservationRequestDto
  ) {
    return this.blockchainIndexerHttpService.closeDepositObservation({
      observationId,
      operatedBy: body.operatedBy,
      note: body.note
    });
  }

  @Post("/withdrawals/observe")
  async observeWithdrawal(@Body() body: ObserveWithdrawalRequestDto) {
    return this.blockchainIndexerHttpService.observeWithdrawal(body);
  }

  @Post("/evm/withdrawals/scan")
  async scanEvmWithdrawals(@Body() body: ScanEvmWithdrawalsRequestDto) {
    return this.blockchainIndexerHttpService.scanEvmWithdrawals(body);
  }

  @Get("/withdrawals/:observationId")
  async getWithdrawalObservation(@Param("observationId") observationId: string) {
    const observation =
      await this.blockchainIndexerHttpService.getWithdrawalObservation(observationId);

    if (!observation) {
      throw new NotFoundException(`Observation ${observationId} not found`);
    }

    return observation;
  }

  @Get("/cursors/:observationType/:network")
  async getScanCursor(@Param() params: GetScanCursorParamsDto) {
    const cursor = await this.blockchainIndexerHttpService.getScanCursor(
      params.observationType,
      params.network
    );

    if (!cursor) {
      throw new NotFoundException(
        `Cursor ${params.observationType}/${params.network} not found`
      );
    }

    return cursor;
  }

  @Get("/ops/overview")
  async getOpsOverview() {
    return this.blockchainIndexerHttpService.getOpsOverview();
  }

  @Post("/ops/replay")
  async replayEvm(@Body() body: ReplayEvmRequestDto) {
    return this.blockchainIndexerHttpService.replayEvm(body);
  }

  @Post("/ops/reorg/acknowledge")
  async acknowledgeReorg(@Body() body: { network?: string }) {
    const network = body?.network ?? "ethereum";
    if (network !== "ethereum" && network !== "bsc" && network !== "base") {
      throw new BadRequestException(`Unsupported network ${network}`);
    }
    return this.blockchainIndexerHttpService.acknowledgeReorg(network);
  }

  @Post("/ops/backlog/repair")
  async repairBacklog(@Body() body: RepairIndexerBacklogRequestDto) {
    return this.blockchainIndexerHttpService.repairBacklog(body);
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
