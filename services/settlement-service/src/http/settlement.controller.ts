import { Body, Controller, Get, Post, Param, Query, UseFilters } from "@nestjs/common";

import type {
  ConsumeTradeExecutionEventRequestDto,
  ListSettlementsQueryDto,
  PauseSettlementConsumerRequestDto,
  ProcessSettlementRecoveryJobsRequestDto,
  ProcessTradeEventSubscriptionRequestDto,
  ReplayTradeExecutionEventsRequestDto,
  SettleTradeRequestDto,
  SettlementAutomationExecutionsQueryDto,
  SettlementRecoveryJobsQueryDto,
  TradeEventBusCheckpointsQueryDto
} from "./dto.js";
import { SettlementExceptionFilter } from "./settlement-exception.filter.js";
import { SettlementHttpService } from "./settlement-http.service.js";

@UseFilters(SettlementExceptionFilter)
@Controller("/api/v1/settlement")
export class SettlementController {
  constructor(private readonly settlementHttpService: SettlementHttpService) {}

  @Post("/trades/settle")
  async settleTrade(@Body() body: SettleTradeRequestDto) {
    return this.settlementHttpService.settleTrade(body);
  }

  @Get("/trades")
  async listSettlements(@Query() query: ListSettlementsQueryDto) {
    return this.settlementHttpService.listSettlements({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/trades/report")
  async getSettlementReport(@Query() query: ListSettlementsQueryDto) {
    return this.settlementHttpService.getSettlementReport({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/recovery-jobs")
  async listRecoveryJobs(@Query() query: SettlementRecoveryJobsQueryDto) {
    return this.settlementHttpService.listRecoveryJobs({
      tradeId: query.tradeId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/recovery-governance")
  async getRecoveryGovernanceReport() {
    return this.settlementHttpService.getRecoveryGovernanceReport();
  }

  @Get("/automation-executions")
  async listAutomationExecutions(@Query() query: SettlementAutomationExecutionsQueryDto) {
    return this.settlementHttpService.listAutomationExecutions({
      executionType: query.executionType,
      status: query.status,
      trigger: query.trigger,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/event-bus")
  async getTradeEventBusReport(@Query() query: TradeEventBusCheckpointsQueryDto) {
    return this.settlementHttpService.getTradeEventBusReport({
      consumerId: query.consumerId,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/event-bus/checkpoints")
  async listTradeEventConsumerCheckpoints(@Query() query: TradeEventBusCheckpointsQueryDto) {
    return this.settlementHttpService.listTradeEventConsumerCheckpoints({
      consumerId: query.consumerId,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/events/trade-executed")
  async consumeTradeExecutionEvent(@Body() body: ConsumeTradeExecutionEventRequestDto) {
    return this.settlementHttpService.consumeTradeExecutionEvent({
      consumerId: body.consumerId,
      event: body.event as unknown as Parameters<
        SettlementHttpService["consumeTradeExecutionEvent"]
      >[0]["event"],
      allowGap: body.allowGap
    });
  }

  @Post("/events/trade-executed/replay")
  async replayTradeExecutionEvents(@Body() body: ReplayTradeExecutionEventsRequestDto) {
    return this.settlementHttpService.replayTradeExecutionEvents({
      consumerId: body.consumerId,
      events: body.events as unknown as Parameters<
        SettlementHttpService["replayTradeExecutionEvents"]
      >[0]["events"],
      allowGap: body.allowGap
    });
  }

  @Post("/event-bus/process")
  async processTradeEventSubscriptionCycle(
    @Body() body: ProcessTradeEventSubscriptionRequestDto
  ) {
    return this.settlementHttpService.processTradeEventSubscriptionCycle({
      market: body?.market,
      allowGap: body?.allowGap,
      afterStreamEntryId: body?.afterStreamEntryId,
      limit: parseOptionalNumber(body?.limit),
      overlapCount: parseOptionalNumber(body?.overlapCount)
    });
  }

  @Get("/lab/consumer")
  async getConsumerLabState() {
    return this.settlementHttpService.getConsumerLabState();
  }

  @Post("/lab/consumer/pause")
  async pauseConsumer(@Body() body: PauseSettlementConsumerRequestDto) {
    const durationSeconds = parseOptionalNumber(
      body?.durationSeconds === undefined ? undefined : String(body.durationSeconds)
    );
    return this.settlementHttpService.pauseConsumer({
      durationMs: durationSeconds !== undefined ? durationSeconds * 1000 : undefined,
      reason: body?.reason,
      requestedBy: body?.requestedBy
    });
  }

  @Post("/lab/consumer/resume")
  async resumeConsumer() {
    return this.settlementHttpService.resumeConsumer();
  }

  @Post("/recovery-jobs/process")
  async processRecoveryJobs(@Body() body: ProcessSettlementRecoveryJobsRequestDto) {
    return this.settlementHttpService.processRecoveryJobs(parseOptionalNumber(body.limit));
  }

  @Post("/trades/:tradeId/recover")
  async recoverTrade(@Param("tradeId") tradeId: string) {
    return this.settlementHttpService.recoverTrade(tradeId);
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
