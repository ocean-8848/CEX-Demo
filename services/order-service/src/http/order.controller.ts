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
import { isSpotMarket, listSpotMarkets, type SpotMarket } from "@web3-cex/domain";

import type {
  AcknowledgeTradeSettlementRequestDto,
  CancelSpotOrderRequestDto,
  CreateSpotOrderRequestDto,
  DeadLetterBatchTemplateQueryDto,
  DeadLetterReportQueryDto,
  MaintainOrderEventStreamRequestDto,
  ListSpotOrdersQueryDto,
  ListSpotTradesQueryDto,
  OrderEventStreamQueryDto,
  OrderAutomationExecutionsQueryDto,
  OrderOpsQueryDto,
  OrderRecoveryJobsQueryDto,
  ProcessRecoveryJobsRequestDto,
  ReplayOrderEventStreamRequestDto,
  TrimOrderEventStreamRequestDto,
  RequeueDeadLetterJobsRequestDto
} from "./dto.js";
import { OrderExceptionFilter } from "./order-exception.filter.js";
import { OrderHttpService } from "./order-http.service.js";

@UseFilters(OrderExceptionFilter)
@Controller("/api/v1/orders")
export class OrderController {
  constructor(private readonly orderHttpService: OrderHttpService) {}

  @Post()
  async createOrder(@Body() body: CreateSpotOrderRequestDto) {
    return this.orderHttpService.createOrder(body);
  }

  @Post("/:orderId/cancel")
  async cancelOrder(
    @Param("orderId") orderId: string,
    @Body() body: CancelSpotOrderRequestDto
  ) {
    return this.orderHttpService.cancelOrder({
      orderId,
      userId: body.userId
    });
  }

  @Get()
  async listOrders(@Query() query: ListSpotOrdersQueryDto) {
    return this.orderHttpService.listOrders({
      userId: query.userId,
      accountId: query.accountId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/:orderId")
  async getOrder(@Param("orderId") orderId: string) {
    const order = await this.orderHttpService.getOrder(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return order;
  }
}

@UseFilters(OrderExceptionFilter)
@Controller("/api/v1/trades")
export class TradeController {
  constructor(private readonly orderHttpService: OrderHttpService) {}

  @Get()
  async listTrades(@Query() query: ListSpotTradesQueryDto) {
    return this.orderHttpService.listTrades({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      executionBatchId: query.executionBatchId,
      executionSequenceFrom: parseOptionalNumber(query.executionSequenceFrom),
      executionSequenceTo: parseOptionalNumber(query.executionSequenceTo),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/events")
  async listTradeEvents(@Query() query: ListSpotTradesQueryDto) {
    return this.orderHttpService.listTradeEvents({
      userId: query.userId,
      market: query.market,
      orderId: query.orderId,
      executionBatchId: query.executionBatchId,
      executionSequenceFrom: parseOptionalNumber(query.executionSequenceFrom),
      executionSequenceTo: parseOptionalNumber(query.executionSequenceTo),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  // Declared after "/events" so the literal route keeps priority.
  @Get("/:tradeId")
  async getTrade(@Param("tradeId") tradeId: string) {
    const trade = await this.orderHttpService.getTrade(tradeId);
    if (!trade) {
      throw new NotFoundException(`Trade ${tradeId} not found`);
    }

    return trade;
  }

  @Post("/:tradeId/settlement")
  async acknowledgeTradeSettlement(
    @Param("tradeId") tradeId: string,
    @Body() body: AcknowledgeTradeSettlementRequestDto
  ) {
    return this.orderHttpService.acknowledgeTradeSettlement({
      tradeId,
      settlementId: body.settlementId
    });
  }
}

@UseFilters(OrderExceptionFilter)
@Controller("/api/v1/orders/ops")
export class OrderOpsController {
  constructor(private readonly orderHttpService: OrderHttpService) {}

  @Get("/overview")
  async getOverview(@Query() query: OrderOpsQueryDto) {
    return this.orderHttpService.getOpsOverview(requireMarket(query.market));
  }

  @Get("/anomalies")
  async getAnomalies(@Query() query: OrderOpsQueryDto) {
    return this.orderHttpService.getOpsAnomalies(requireMarket(query.market));
  }

  @Post("/replay-engine")
  async replayEngineBook(@Body() body: OrderOpsQueryDto) {
    return this.orderHttpService.replayEngineBook(requireMarket(body.market));
  }

  /** Runs one stop-order trigger pass now (the worker also polls on its own). */
  @Post("/stop-orders/trigger")
  async runStopOrderTriggers() {
    return this.orderHttpService.runStopOrderTriggers();
  }

  @Post("/lab/engine-reset")
  async injectEngineReset(
    @Body() body: OrderOpsQueryDto & { resetSequences?: boolean | string }
  ) {
    return this.orderHttpService.injectEngineReset(requireMarket(body.market), {
      resetSequences: body.resetSequences === true || body.resetSequences === "true"
    });
  }

  @Get("/recovery-jobs")
  async listRecoveryJobs(@Query() query: OrderRecoveryJobsQueryDto) {
    return this.orderHttpService.listRecoveryJobs({
      orderId: query.orderId,
      market: query.market,
      status: query.status,
      deadLettered: parseOptionalBoolean(query.deadLettered),
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/recovery-metrics")
  async getRecoveryMetrics() {
    return this.orderHttpService.getRecoveryMetrics();
  }

  @Get("/recovery-governance")
  async getRecoveryGovernanceReport() {
    return this.orderHttpService.getRecoveryGovernanceReport();
  }

  @Get("/automation-executions")
  async listAutomationExecutions(@Query() query: OrderAutomationExecutionsQueryDto) {
    return this.orderHttpService.listAutomationExecutions({
      executionType: query.executionType,
      status: query.status,
      trigger: query.trigger,
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/event-bus")
  async getTradeEventBusReport() {
    return this.orderHttpService.getTradeEventBusReport();
  }

  @Get("/event-bus/streams")
  async getTradeEventStreamReport() {
    return this.orderHttpService.getTradeEventBusReport();
  }

  @Get("/event-bus/streams/events")
  async listTradeEventStreamEntries(@Query() query: OrderEventStreamQueryDto) {
    if (!query.market) {
      throw new BadRequestException("market is required");
    }

    return this.orderHttpService.listTradeEventStreamEntries({
      market: query.market,
      afterStreamEntryId: query.afterStreamEntryId,
      fromStreamEntryId: query.fromStreamEntryId,
      toStreamEntryId: query.toStreamEntryId,
      executionSequenceFrom: parseOptionalNumber(query.executionSequenceFrom),
      limit: parseOptionalNumber(query.limit),
      overlapCount: parseOptionalNumber(query.overlapCount),
      direction: query.direction
    });
  }

  @Post("/event-bus/streams/replay")
  async replayTradeEventStream(@Body() body: ReplayOrderEventStreamRequestDto) {
    return this.orderHttpService.replayTradeEventStream({
      market: body.market,
      afterStreamEntryId: body.afterStreamEntryId,
      fromStreamEntryId: body.fromStreamEntryId,
      toStreamEntryId: body.toStreamEntryId,
      executionSequenceFrom: body.executionSequenceFrom,
      limit: body.limit,
      overlapCount: body.overlapCount,
      direction: body.direction,
      publishToChannel: body.publishToChannel
    });
  }

  @Post("/event-bus/streams/trim")
  async trimTradeEventStream(@Body() body: TrimOrderEventStreamRequestDto) {
    return this.orderHttpService.trimTradeEventStream({
      market: body.market,
      strategy: body.strategy,
      maxLen: body.maxLen,
      retentionMs: body.retentionMs,
      minStreamEntryId: body.minStreamEntryId,
      dryRun: body.dryRun,
      limit: body.limit
    });
  }

  @Post("/event-bus/streams/maintenance")
  async maintainTradeEventStream(@Body() body: MaintainOrderEventStreamRequestDto) {
    return this.orderHttpService.runTradeEventStreamMaintenance({
      market: body.market,
      dryRun: body.dryRun,
      force: body.force,
      limit: body.limit
    });
  }

  @Get("/dead-letter-jobs")
  async listDeadLetterJobs(@Query() query: OrderRecoveryJobsQueryDto) {
    return this.orderHttpService.listDeadLetterJobs({
      orderId: query.orderId,
      market: query.market,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/dead-letter-report")
  async getDeadLetterReport(@Query() query: DeadLetterReportQueryDto) {
    return this.orderHttpService.getDeadLetterReport({
      market: query.market,
      limit: parseOptionalNumber(query.limit),
      templateLimit: parseOptionalNumber(query.templateLimit)
    });
  }

  @Get("/dead-letter-templates")
  async getDeadLetterBatchTemplates(@Query() query: DeadLetterBatchTemplateQueryDto) {
    return this.orderHttpService.getDeadLetterBatchTemplates({
      market: query.market,
      limit: parseOptionalNumber(query.limit)
    });
  }

  @Post("/recovery-jobs/process")
  async processRecoveryJobs(@Body() body: ProcessRecoveryJobsRequestDto) {
    return this.orderHttpService.processRecoveryJobs(parseOptionalNumber(body.limit));
  }

  @Post("/recovery-jobs/:jobId/recover")
  async recoverJob(@Param("jobId") jobId: string) {
    return this.orderHttpService.recoverJob(jobId);
  }

  @Post("/dead-letter-jobs/requeue")
  async requeueDeadLetterJobs(@Body() body: RequeueDeadLetterJobsRequestDto) {
    return this.orderHttpService.requeueDeadLetterJobs({
      market: body.market,
      limit: parseOptionalNumber(body.limit)
    });
  }

  @Post("/dead-letter-jobs/:jobId/requeue")
  async requeueDeadLetterJob(@Param("jobId") jobId: string) {
    return this.orderHttpService.requeueDeadLetterJob(jobId);
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

// Book-level ops queries are per market; without one the matching engine
// rejects the command and the caller used to get an opaque 500.
function requireMarket(market: string | undefined): SpotMarket {
  if (!market || !isSpotMarket(market)) {
    throw new BadRequestException(
      `market is required (one of ${listSpotMarkets({ includeDelisted: true }).join(", ")})`
    );
  }
  return market as SpotMarket;
}
