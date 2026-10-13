import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import {
  DEFAULT_TRADE_EVENT_VERSION_GATE,
  listSpotMarkets,
  TRADE_EXECUTED_EVENT_SCHEMAS,
  type SpotMarket,
  type TradeEventVersionGate
} from "@web3-cex/domain";

import { FeeTierService } from "../application/fee-tier-service.js";
import { OrderApplicationService } from "../application/order-application-service.js";
import { OrderOpsService } from "../application/order-ops-service.js";
import { OrderRecoveryWorker } from "../application/order-recovery-worker.js";
import { StopOrderTriggerWorker } from "../application/stop-order-trigger-worker.js";
import { OrderServiceError } from "../domain/errors.js";
import type {
  MaintainOrderTradeEventStreamCommand,
  OrderEventPublisher,
  OrderTradeEventStreamQuery,
  ReplayOrderTradeEventStreamCommand,
  TrimOrderTradeEventStreamCommand
} from "../domain/event-publisher.js";
import type {
  CancelSpotOrderCommand,
  CreateSpotOrderCommand,
  ListSpotOrderAutomationExecutionsQuery,
  ListSpotOrdersQuery,
  ListSpotOrderRecoveryJobsQuery,
  ListSpotTradesQuery
} from "../domain/types.js";
import type { SurveillanceDataSource } from "../domain/surveillance-data.js";
import { InMemoryFeeTierRepository } from "../infrastructure/in-memory-fee-tier-repository.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";
import { PostgresFeeTierRepository } from "../infrastructure/postgres-fee-tier-repository.js";
import {
  PostgresSurveillanceDataSource,
  RepositorySurveillanceDataSource
} from "../infrastructure/surveillance-data-sources.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { HttpRiskClient } from "../infrastructure/http-risk-client.js";
import { HttpSettlementClient } from "../infrastructure/http-settlement-client.js";
import { createOrderPool } from "../infrastructure/postgres.js";
import { PostgresOrderRepository } from "../infrastructure/postgres-order-repository.js";
import { createOrderRedisClient } from "../infrastructure/order-redis.js";
import { RedisOrderEventPublisher } from "../infrastructure/redis-order-event-publisher.js";
import { TcpMatchingEngineClient } from "../infrastructure/tcp-matching-engine-client.js";

@Injectable()
export class OrderHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly applicationService: OrderApplicationService;
  /** A7 VIP fee tiers (resolution, overrides, audit). */
  readonly feeTiers: FeeTierService;
  /** A9 read-only activity window for risk-service surveillance. */
  readonly surveillanceData: SurveillanceDataSource;
  private readonly opsService: OrderOpsService;
  private readonly recoveryWorker: OrderRecoveryWorker;
  private readonly stopOrderTriggerWorker: StopOrderTriggerWorker;
  private readonly eventPublisher?: OrderEventPublisher;
  private readonly pool?: Pool;
  private readonly redisClient?: RedisClientType;
  private readonly tradeEventVersionGate: TradeEventVersionGate;
  private readonly eventPublisherMode: string;
  private readonly eventChannel: string;
  private readonly settlementMode: "sync" | "async";
  private readonly eventStreamRetentionMs?: number;
  private readonly eventStreamTrimCooldownMs: number;
  private readonly eventStreamAutoTrimEnabled: boolean;
  private readonly eventStreamLagWarningThreshold: number;
  private readonly eventStreamLagCriticalThreshold: number;
  private readonly eventStreamPressureWarningRatio: number;
  private readonly eventStreamMaintenanceRunForever: boolean;
  private readonly eventStreamMaintenanceIntervalMs: number;
  private readonly eventArchiveEnabled: boolean;
  private readonly eventArchiveMaxLen: number;
  private recoveryTimer?: NodeJS.Timeout;
  private eventStreamMaintenanceTimer?: NodeJS.Timeout;
  private engineSyncTimer?: NodeJS.Timeout;

  constructor() {
    const repositoryMode = process.env.ORDER_SERVICE_REPOSITORY ?? "postgres";
    this.tradeEventVersionGate = readTradeEventVersionGateFromEnv("ORDER");
    this.eventPublisherMode = process.env.ORDER_EVENT_PUBLISHER ?? "redis_stream";
    this.eventChannel = process.env.ORDER_EVENT_CHANNEL ?? "web3-cex:trading.events";
    this.settlementMode =
      process.env.ORDER_SETTLEMENT_MODE === "sync" ? "sync" : "async";
    this.eventStreamRetentionMs = readOptionalPositiveInteger(
      process.env.ORDER_EVENT_STREAM_RETENTION_MS
    );
    this.eventStreamTrimCooldownMs =
      readOptionalPositiveInteger(process.env.ORDER_EVENT_STREAM_TRIM_COOLDOWN_MS) ?? 60_000;
    this.eventStreamAutoTrimEnabled =
      process.env.ORDER_EVENT_STREAM_AUTO_TRIM === "false" ? false : true;
    this.eventStreamLagWarningThreshold =
      readOptionalPositiveInteger(process.env.ORDER_EVENT_STREAM_LAG_WARNING_THRESHOLD) ?? 10;
    this.eventStreamLagCriticalThreshold =
      readOptionalPositiveInteger(process.env.ORDER_EVENT_STREAM_LAG_CRITICAL_THRESHOLD) ?? 50;
    this.eventStreamPressureWarningRatio = readRatio(
      process.env.ORDER_EVENT_STREAM_PRESSURE_WARNING_RATIO,
      0.8
    );
    this.eventStreamMaintenanceRunForever =
      process.env.ORDER_EVENT_STREAM_MAINTENANCE_RUN_FOREVER === "false" ? false : true;
    this.eventStreamMaintenanceIntervalMs =
      readOptionalPositiveInteger(process.env.ORDER_EVENT_STREAM_MAINTENANCE_INTERVAL_MS) ??
      this.eventStreamTrimCooldownMs;
    this.eventArchiveEnabled =
      process.env.ORDER_EVENT_ARCHIVE_ENABLED === "false" ? false : true;
    this.eventArchiveMaxLen =
      readOptionalPositiveInteger(process.env.ORDER_EVENT_ARCHIVE_STREAM_MAX_LEN) ?? 50_000;
    const repository =
      repositoryMode === "memory"
        ? new InMemoryOrderRepository()
        : (() => {
            this.pool = createOrderPool();
            return new PostgresOrderRepository(this.pool, this.pool);
          })();

    this.feeTiers = new FeeTierService(
      this.pool
        ? new PostgresFeeTierRepository(this.pool)
        : new InMemoryFeeTierRepository(() => repository.listTrades({})),
      { cacheMs: Number(process.env.ORDER_FEE_TIER_CACHE_MS ?? "30000") }
    );
    this.surveillanceData = this.pool
      ? new PostgresSurveillanceDataSource(this.pool)
      : new RepositorySurveillanceDataSource(repository);

    const redisUrl = process.env.ORDER_EVENT_REDIS_URL ?? "redis://127.0.0.1:6379";
    if (this.eventPublisherMode === "redis" || this.eventPublisherMode === "redis_stream") {
        this.redisClient = createOrderRedisClient(redisUrl);
    }
    this.eventPublisher = this.redisClient
      ? new RedisOrderEventPublisher(this.redisClient, this.eventChannel, {
          mode: this.eventPublisherMode,
          streamPrefix:
            process.env.ORDER_EVENT_STREAM_PREFIX ?? "web3-cex:trade-events",
          streamMaxLen: Number(process.env.ORDER_EVENT_STREAM_MAX_LEN ?? "10000"),
          streamRetentionMs: this.eventStreamRetentionMs,
          streamTrimCooldownMs: this.eventStreamTrimCooldownMs,
          streamPressureWarningRatio: this.eventStreamPressureWarningRatio,
          archiveEnabled: this.eventArchiveEnabled,
          archivePrefix:
            process.env.ORDER_EVENT_ARCHIVE_STREAM_PREFIX ??
            "web3-cex:trade-events:archive",
          archiveMaxLen: this.eventArchiveMaxLen,
          autoTrim: this.eventStreamAutoTrimEnabled
        })
      : undefined;

    this.applicationService = new OrderApplicationService(
      repository,
      new HttpRiskClient(process.env.RISK_SERVICE_BASE_URL ?? "http://127.0.0.1:3008"),
      new HttpLedgerClient(process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001"),
      new HttpSettlementClient(
        process.env.SETTLEMENT_SERVICE_BASE_URL ?? "http://127.0.0.1:3010"
      ),
      new TcpMatchingEngineClient(
        process.env.MATCHING_ENGINE_HOST ?? "127.0.0.1",
        Number(process.env.MATCHING_ENGINE_PORT ?? "3011")
      ),
      {
        settlementMode: this.settlementMode,
        tradeEventVersionGate: this.tradeEventVersionGate,
        eventPublisher: this.eventPublisher,
        feeTierResolver: process.env.ORDER_FEE_TIERS_ENABLED === "false" ? undefined : this.feeTiers
      }
    );
    this.opsService = new OrderOpsService(
      repository,
      new TcpMatchingEngineClient(
        process.env.MATCHING_ENGINE_HOST ?? "127.0.0.1",
        Number(process.env.MATCHING_ENGINE_PORT ?? "3011")
      )
    );
    this.recoveryWorker = new OrderRecoveryWorker(this.applicationService, {
      pollIntervalMs: Number(process.env.ORDER_RECOVERY_POLL_INTERVAL_MS ?? "5000"),
      batchSize: Number(process.env.ORDER_RECOVERY_BATCH_SIZE ?? "20"),
      leaseRenewIntervalMs: Number(
        process.env.ORDER_RECOVERY_LEASE_RENEW_INTERVAL_MS ?? "5000"
      ),
      createWorkerId: () =>
        process.env.ORDER_RECOVERY_WORKER_ID?.trim() ||
        `order-recovery:http:${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now()}`
    });
    this.stopOrderTriggerWorker = new StopOrderTriggerWorker(this.applicationService, {
      pollIntervalMs: Number(process.env.ORDER_STOP_TRIGGER_POLL_INTERVAL_MS ?? "1000")
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.redisClient && !this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
    // Restore engine sequences/books before taking traffic, then keep checking
    // so an engine restart (or the fault lab's reset) heals within seconds.
    const engineSyncIntervalMs = Number(process.env.ORDER_ENGINE_SYNC_INTERVAL_MS ?? "2000");
    await this.syncEngineState();
    if (engineSyncIntervalMs > 0) {
      this.engineSyncTimer = setInterval(() => {
        void this.syncEngineState();
      }, engineSyncIntervalMs);
    }
    // Stop orders: watch the last trade price and submit triggered orders.
    this.stopOrderTriggerWorker.start();
    if (process.env.ORDER_RECOVERY_RUN_FOREVER === "true") {
      const intervalMs = Number(process.env.ORDER_RECOVERY_POLL_INTERVAL_MS ?? "5000");
      this.recoveryTimer = setInterval(() => {
        void this.recoveryWorker.runOnce(undefined, "automatic");
      }, intervalMs);
    }
    if (
      this.eventPublisher &&
      this.eventPublisherMode === "redis_stream" &&
      this.eventStreamMaintenanceRunForever
    ) {
      this.eventStreamMaintenanceTimer = setInterval(() => {
        void this.runTradeEventStreamMaintenance({
          trigger: "automatic"
        }).catch((error) => {
          console.warn(
            `trade event stream maintenance cycle failed: ${
              error instanceof Error ? error.message : "unknown maintenance error"
            }`
          );
        });
      }, this.eventStreamMaintenanceIntervalMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopOrderTriggerWorker.stop();
    if (this.engineSyncTimer) {
      clearInterval(this.engineSyncTimer);
      this.engineSyncTimer = undefined;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.eventStreamMaintenanceTimer) {
      clearInterval(this.eventStreamMaintenanceTimer);
      this.eventStreamMaintenanceTimer = undefined;
    }
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
    await this.pool?.end();
  }

  async createOrder(command: CreateSpotOrderCommand) {
    return this.applicationService.createOrder(command);
  }

  async cancelOrder(command: CancelSpotOrderCommand) {
    return this.applicationService.cancelOrder(command);
  }

  async getOrder(orderId: string) {
    return this.applicationService.getOrder(orderId);
  }

  async listOrders(query: ListSpotOrdersQuery) {
    return this.applicationService.listOrders(query);
  }

  async listTrades(query: ListSpotTradesQuery) {
    return this.applicationService.listTrades(query);
  }

  async getTrade(tradeId: string) {
    return this.applicationService.getTrade(tradeId);
  }

  async listTradeEvents(query: ListSpotTradesQuery) {
    return this.applicationService.listTradeEvents(query);
  }

  async acknowledgeTradeSettlement(command: { tradeId: string; settlementId: string }) {
    return this.applicationService.acknowledgeTradeSettlement(command);
  }

  async listAutomationExecutions(query: ListSpotOrderAutomationExecutionsQuery) {
    return this.applicationService.listAutomationExecutions(query);
  }

  async getTradeEventBusReport() {
    const publisherReport = await this.eventPublisher?.getReport?.();
    const [latestMaintenanceCycle] = await this.applicationService.listAutomationExecutions({
      executionType: "event_stream_maintenance_cycle",
      limit: 1,
      offset: 0
    });

    return {
      generatedAt: new Date().toISOString(),
      publisher: {
        mode: publisherReport?.mode ?? this.eventPublisherMode,
        enabled:
          publisherReport?.enabled ??
          (this.eventPublisherMode === "redis" || this.eventPublisherMode === "redis_stream"
            ? !!this.redisClient
            : true),
        channel: this.eventChannel
      },
      stream: publisherReport?.stream ?? {
        enabled: false,
        heads: []
      },
      operator: {
        autoTrimEnabled: this.eventStreamAutoTrimEnabled,
        retentionMs: this.eventStreamRetentionMs,
        trimCooldownMs: this.eventStreamTrimCooldownMs,
        maintenanceRunForever: this.eventStreamMaintenanceRunForever,
        maintenanceIntervalMs: this.eventStreamMaintenanceIntervalMs,
        pressureWarningRatio: this.eventStreamPressureWarningRatio,
        archive: {
          enabled: this.eventArchiveEnabled,
          maxLen: this.eventArchiveMaxLen,
          prefix:
            process.env.ORDER_EVENT_ARCHIVE_STREAM_PREFIX ??
            "web3-cex:trade-events:archive"
        },
        lagSlo: {
          warning: this.eventStreamLagWarningThreshold,
          critical: this.eventStreamLagCriticalThreshold
        },
        strategies: [
          "stream_replay",
          "stream_trim",
          "stream_maintenance",
          "stream_archive",
          "subscriber_process_cycle",
          "self_heal"
        ],
        latestMaintenanceCycle
      },
      settlementMode: this.settlementMode,
      versionGate: this.tradeEventVersionGate,
      schemas: TRADE_EXECUTED_EVENT_SCHEMAS
    };
  }

  async listTradeEventStreamEntries(query: OrderTradeEventStreamQuery) {
    return (await this.eventPublisher?.listStreamEntries?.(query)) ?? [];
  }

  async replayTradeEventStream(command: ReplayOrderTradeEventStreamCommand) {
    return (
      (await this.eventPublisher?.replayStreamEntries?.(command)) ?? {
        market: command.market,
        replayedCount: 0,
        publishToChannel: command.publishToChannel !== false,
        entries: []
      }
    );
  }

  async trimTradeEventStream(command: TrimOrderTradeEventStreamCommand) {
    return (
      (await this.eventPublisher?.trimStreamEntries?.(command)) ?? {
        strategy: command.strategy ?? "auto",
        dryRun: command.dryRun === true,
        trims: []
      }
    );
  }

  async runTradeEventStreamMaintenance(
    command: MaintainOrderTradeEventStreamCommand & {
      trigger?: "automatic" | "manual" | "template";
    } = {}
  ) {
    const startedAt = new Date();

    try {
      const result =
        (await this.eventPublisher?.maintainStreamEntries?.(command)) ?? {
          dryRun: command.dryRun === true,
          force: command.force === true,
          cycleStartedAt: startedAt.toISOString(),
          cycleCompletedAt: new Date().toISOString(),
          pressureWarningRatio: this.eventStreamPressureWarningRatio,
          markets: []
        };
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "event_stream_maintenance_cycle",
        status: "succeeded",
        trigger: command.trigger ?? "manual",
        market: command.market,
        targetId: command.market,
        summary: result,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      return result;
    } catch (error) {
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "event_stream_maintenance_cycle",
        status: "failed",
        trigger: command.trigger ?? "manual",
        market: command.market,
        targetId: command.market,
        summary: {},
        errorMessage: error instanceof Error ? error.message : "unknown event stream maintenance error",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      throw error;
    }
  }

  async syncEngineState() {
    const results = [];
    for (const market of listSpotMarkets({ includeDelisted: true })) {
      try {
        const result = await this.opsService.syncEngineState(market);
        if (result.restored) {
          console.warn(
            `matching-engine ${market} was behind; restored next execution sequence ${result.nextExecutionSequence} and replayed ${result.replayedOrderCount} open orders`
          );
        }
        results.push(result);
      } catch (error) {
        // Engine down: keep serving reads, the next tick retries.
        results.push({ market, restored: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async getOpsOverview(market: Parameters<OrderOpsService["getOverview"]>[0]) {
    return {
      ...(await this.opsService.getOverview(market)),
      stopTrigger: this.stopOrderTriggerWorker.getStatus()
    };
  }

  /** Runs one stop-trigger pass immediately (ops / tests); the worker also polls. */
  async runStopOrderTriggers() {
    return this.stopOrderTriggerWorker.runOnce();
  }

  async getOpsAnomalies(market: Parameters<OrderOpsService["getAnomalies"]>[0]) {
    return this.opsService.getAnomalies(market);
  }

  async injectEngineReset(
    market: Parameters<OrderOpsService["injectEngineReset"]>[0],
    options: { resetSequences?: boolean }
  ) {
    if (process.env.ORDER_FAULT_LAB_ENABLED === "false") {
      throw new OrderServiceError(
        "ORDER_FAULT_LAB_DISABLED",
        403,
        "Fault lab is disabled (ORDER_FAULT_LAB_ENABLED=false)"
      );
    }
    const result = await this.opsService.injectEngineReset(market, options);
    console.warn(
      `fault lab: matching-engine ${market} book reset (resetSequences=${String(result.resetSequences)}, dropped ${result.droppedBookOrderCount} orders)`
    );
    return result;
  }

  async replayEngineBook(market: Parameters<OrderOpsService["replayEngineBook"]>[0]) {
    const startedAt = new Date();
    try {
      const result = await this.opsService.replayEngineBook(market);
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "manual_engine_replay",
        status: "succeeded",
        trigger: "manual",
        market,
        targetId: market,
        summary: result,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      return result;
    } catch (error) {
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "manual_engine_replay",
        status: "failed",
        trigger: "manual",
        market,
        targetId: market,
        summary: {},
        errorMessage: error instanceof Error ? error.message : "unknown replay error",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      throw error;
    }
  }

  async listRecoveryJobs(query: ListSpotOrderRecoveryJobsQuery) {
    return this.applicationService.listRecoveryJobs(query);
  }

  async listDeadLetterJobs(query: Omit<ListSpotOrderRecoveryJobsQuery, "deadLettered">) {
    return this.applicationService.listDeadLetterRecoveryJobs(query);
  }

  async getRecoveryMetrics() {
    return this.applicationService.getRecoveryMetrics();
  }

  async getRecoveryGovernanceReport() {
    return this.recoveryWorker.getGovernanceReport();
  }

  async getDeadLetterReport(query: { market?: string; limit?: number; templateLimit?: number }) {
    return this.recoveryWorker.getDeadLetterReport({
      market: query.market as Parameters<OrderRecoveryWorker["getDeadLetterReport"]>[0]["market"],
      limit: query.limit,
      templateLimit: query.templateLimit
    });
  }

  async getDeadLetterBatchTemplates(query: { market?: string; limit?: number }) {
    return this.recoveryWorker.getDeadLetterBatchTemplates({
      market: query.market as Parameters<
        OrderRecoveryWorker["getDeadLetterBatchTemplates"]
      >[0]["market"],
      limit: query.limit
    });
  }

  async processRecoveryJobs(limit?: number) {
    return this.recoveryWorker.runOnce(limit, "manual");
  }

  async recoverJob(jobId: string) {
    return this.applicationService.recoverOrder(jobId);
  }

  async requeueDeadLetterJobs(query: { market?: string; limit?: number }) {
    return this.applicationService.batchRequeueDeadLetterJobs({
      market: query.market as Parameters<
        OrderApplicationService["batchRequeueDeadLetterJobs"]
      >[0]["market"],
      limit: query.limit
    });
  }

  async requeueDeadLetterJob(jobId: string) {
    return this.applicationService.requeueDeadLetterJob(jobId);
  }
}

function readTradeEventVersionGateFromEnv(prefix: string): TradeEventVersionGate {
  const minimumProtocolVersion =
    process.env[`${prefix}_TRADE_EVENT_PROTOCOL_MIN`] ??
    DEFAULT_TRADE_EVENT_VERSION_GATE.minimumProtocolVersion;
  const maximumProtocolVersion =
    process.env[`${prefix}_TRADE_EVENT_PROTOCOL_MAX`] ??
    DEFAULT_TRADE_EVENT_VERSION_GATE.maximumProtocolVersion;
  const supportedProtocolVersions = (
    process.env[`${prefix}_TRADE_EVENT_PROTOCOLS`] ??
    DEFAULT_TRADE_EVENT_VERSION_GATE.supportedProtocolVersions.join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    minimumProtocolVersion,
    maximumProtocolVersion,
    supportedProtocolVersions
  };
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.max(Math.trunc(parsed), 1);
}

function readRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? Number.NaN);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 0.1), 1);
}
