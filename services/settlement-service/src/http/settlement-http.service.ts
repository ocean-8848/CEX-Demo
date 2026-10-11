import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import {
  DEFAULT_TRADE_EVENT_VERSION_GATE,
  type TradeEventVersionGate
} from "@web3-cex/domain";
import type { RedisClientType } from "redis";

import { SettlementApplicationService } from "../application/settlement-application-service.js";
import { SettlementRecoveryWorker } from "../application/settlement-recovery-worker.js";
import { SettlementTradeEventSubscriber } from "../application/settlement-trade-event-subscriber.js";
import { SettlementConsumerPauseControl } from "../application/settlement-consumer-pause.js";
import { SettlementServiceError } from "../domain/errors.js";
import type {
  ConsumeTradeExecutionEventCommand,
  ListSettlementAutomationExecutionsQuery,
  ListTradeEventConsumerCheckpointsQuery,
  ListSettlementRecoveryJobsQuery,
  ListTradeSettlementsQuery,
  ReplayTradeExecutionEventsCommand,
  SettleTradeCommand
} from "../domain/types.js";
import { InMemorySettlementRepository } from "../infrastructure/in-memory-settlement-repository.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { HttpOrderEventClient } from "../infrastructure/http-order-event-client.js";
import { createSettlementPool } from "../infrastructure/postgres.js";
import { PostgresSettlementRepository } from "../infrastructure/postgres-settlement-repository.js";
import {
  RedisOrderEventClient,
  createSettlementRedisClient,
  resolveTradeEventStreamMarkets
} from "../infrastructure/redis-order-event-client.js";

@Injectable()
export class SettlementHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly applicationService: SettlementApplicationService;
  private readonly recoveryWorker: SettlementRecoveryWorker;
  private readonly pool?: Pool;
  private readonly tradeEventRedisClient?: RedisClientType;
  private readonly tradeEventVersionGate: TradeEventVersionGate;
  private readonly tradeEventSubscriberMode: "redis_stream" | "disabled";
  private readonly tradeEventSubscriber?: SettlementTradeEventSubscriber;
  private readonly tradeEventClient?: HttpOrderEventClient | RedisOrderEventClient;
  private readonly consumerPause: SettlementConsumerPauseControl;
  private recoveryTimer?: NodeJS.Timeout;
  private tradeEventSubscriberTimer?: NodeJS.Timeout;
  private tradeEventSubscriberCycleRunning = false;

  constructor() {
    const repositoryMode = process.env.SETTLEMENT_REPOSITORY ?? "postgres";
    this.tradeEventVersionGate = readTradeEventVersionGateFromEnv("SETTLEMENT");
    this.tradeEventSubscriberMode =
      process.env.SETTLEMENT_EVENT_SUBSCRIBER === "disabled" ? "disabled" : "redis_stream";
    const repository =
      repositoryMode === "memory"
        ? new InMemorySettlementRepository()
        : (() => {
            this.pool = createSettlementPool();
            return new PostgresSettlementRepository(this.pool, this.pool);
          })();

    this.applicationService = new SettlementApplicationService(
      repository,
      new HttpLedgerClient(process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001"),
      {
        tradeEventVersionGate: this.tradeEventVersionGate
      }
    );

    this.recoveryWorker = new SettlementRecoveryWorker(this.applicationService, {
      pollIntervalMs: Number(process.env.SETTLEMENT_RECOVERY_POLL_INTERVAL_MS ?? "5000"),
      batchSize: Number(process.env.SETTLEMENT_RECOVERY_BATCH_SIZE ?? "20"),
      leaseRenewIntervalMs: Number(
        process.env.SETTLEMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS ?? "5000"
      ),
      createWorkerId: () =>
        process.env.SETTLEMENT_RECOVERY_WORKER_ID?.trim() ||
        `settlement-recovery:http:${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now()}`
    });

    this.consumerPause = new SettlementConsumerPauseControl({
      enabled: process.env.SETTLEMENT_FAULT_LAB_ENABLED !== "false",
      defaultDurationMs: Number(process.env.SETTLEMENT_CONSUMER_PAUSE_DEFAULT_MS ?? "120000"),
      maxDurationMs: Number(process.env.SETTLEMENT_CONSUMER_PAUSE_MAX_MS ?? "600000")
    });

    if (this.tradeEventSubscriberMode === "redis_stream") {
      const pollIntervalMs = Number(
        process.env.SETTLEMENT_EVENT_SUBSCRIBER_POLL_INTERVAL_MS ?? "5000"
      );
      const batchSize = Number(process.env.SETTLEMENT_EVENT_SUBSCRIBER_BATCH_SIZE ?? "50");
      const orderServiceBaseUrl =
        process.env.SETTLEMENT_ORDER_SERVICE_BASE_URL ?? "http://127.0.0.1:3009";
      const transport = process.env.SETTLEMENT_ORDER_EVENT_TRANSPORT ?? "redis_stream";
      const orderEventClient =
        transport === "http"
          ? new HttpOrderEventClient(orderServiceBaseUrl)
          : (() => {
              this.tradeEventRedisClient = createSettlementRedisClient(
                process.env.SETTLEMENT_EVENT_REDIS_URL ?? "redis://127.0.0.1:6379"
              );
              return new RedisOrderEventClient(
                this.tradeEventRedisClient,
                orderServiceBaseUrl,
                {
                  streamPrefix:
                    process.env.SETTLEMENT_EVENT_STREAM_PREFIX ?? "web3-cex:trade-events"
                }
              );
            })();
      this.tradeEventClient = orderEventClient;
      this.tradeEventSubscriber = new SettlementTradeEventSubscriber(
        this.applicationService,
        orderEventClient,
        {
          consumerId:
            process.env.SETTLEMENT_EVENT_CONSUMER_ID?.trim() || "settlement-service",
          pollIntervalMs,
          batchSize,
          overlapCount: Number(
            process.env.SETTLEMENT_EVENT_SUBSCRIBER_OVERLAP_COUNT ?? String(batchSize)
          ),
          pauseControl: this.consumerPause
        }
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.tradeEventRedisClient && !this.tradeEventRedisClient.isOpen) {
      await this.tradeEventRedisClient.connect();
    }

    if (process.env.SETTLEMENT_RECOVERY_RUN_FOREVER === "true") {
      const intervalMs = Number(process.env.SETTLEMENT_RECOVERY_POLL_INTERVAL_MS ?? "5000");
      this.recoveryTimer = setInterval(() => {
        void this.recoveryWorker.runOnce(undefined, "automatic");
      }, intervalMs);
    }

    if (
      this.tradeEventSubscriber &&
      (process.env.SETTLEMENT_EVENT_SUBSCRIBER_RUN_FOREVER ?? "true") === "true"
    ) {
      this.scheduleTradeEventSubscriberCycle("automatic");
      this.tradeEventSubscriberTimer = setInterval(() => {
        this.scheduleTradeEventSubscriberCycle("automatic");
      }, this.tradeEventSubscriber.getPollIntervalMs());
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.tradeEventSubscriberTimer) {
      clearInterval(this.tradeEventSubscriberTimer);
      this.tradeEventSubscriberTimer = undefined;
    }
    if (this.tradeEventRedisClient?.isOpen) {
      await this.tradeEventRedisClient.quit();
    }
    await this.pool?.end();
  }

  async settleTrade(command: SettleTradeCommand) {
    return this.applicationService.settleTrade(command);
  }

  async listSettlements(query: ListTradeSettlementsQuery) {
    return this.applicationService.listSettlements(query);
  }

  async getSettlementReport(query: ListTradeSettlementsQuery) {
    return this.applicationService.getSettlementReport(query);
  }

  async listRecoveryJobs(query: ListSettlementRecoveryJobsQuery) {
    return this.applicationService.listRecoveryJobs(query);
  }

  async getRecoveryGovernanceReport() {
    return this.recoveryWorker.getGovernanceReport();
  }

  async listAutomationExecutions(query: ListSettlementAutomationExecutionsQuery) {
    return this.applicationService.listAutomationExecutions(query);
  }

  async getTradeEventBusReport(query: ListTradeEventConsumerCheckpointsQuery = {}) {
    const baseReport = await this.applicationService.getTradeEventBusReport(query);
    const streamHeads = await this.listTradeEventStreamHeads(query.market);
    const checkpointLag = baseReport.checkpoints.map((checkpoint) => {
      const streamHead = streamHeads.find((item) => item.market === checkpoint.market);
      const latestExecutionSequence =
        typeof streamHead?.latestExecutionSequence === "number"
          ? streamHead.latestExecutionSequence
          : undefined;

      return {
        ...checkpoint,
        latestExecutionSequence,
        latestReplayCursor: streamHead?.latestReplayCursor,
        executionSequenceLag:
          latestExecutionSequence !== undefined
            ? Math.max(latestExecutionSequence - checkpoint.lastExecutionSequence, 0)
            : undefined,
        streamUpToDate:
          checkpoint.lastStreamEntryId !== undefined &&
          checkpoint.lastStreamEntryId === streamHead?.latestStreamEntryId
      };
    });

    return {
      ...baseReport,
      streamHeads,
      checkpointLag,
      subscriber: this.tradeEventSubscriber
        ? await this.tradeEventSubscriber.getReport(this.tradeEventSubscriberMode)
        : {
            enabled: false,
            mode: "disabled" as const,
            consumerId:
              process.env.SETTLEMENT_EVENT_CONSUMER_ID?.trim() || "settlement-service",
            batchSize: 0,
            overlapCount: 0,
            pollIntervalMs: 0,
            markets: []
          }
    };
  }

  async listTradeEventConsumerCheckpoints(query: ListTradeEventConsumerCheckpointsQuery) {
    return this.applicationService.listTradeEventConsumerCheckpoints(query);
  }

  async consumeTradeExecutionEvent(command: ConsumeTradeExecutionEventCommand) {
    return this.applicationService.consumeTradeExecutionEvent(command);
  }

  async replayTradeExecutionEvents(command: ReplayTradeExecutionEventsCommand) {
    return this.applicationService.replayTradeExecutionEvents(command);
  }

  async processTradeEventSubscriptionCycle(command: {
    market?: SettleTradeCommand["market"];
    allowGap?: boolean;
    afterStreamEntryId?: string;
    limit?: number;
    overlapCount?: number;
  }) {
    if (!this.tradeEventSubscriber) {
      throw new SettlementServiceError(
        "SETTLEMENT_EVENT_SUBSCRIBER_DISABLED",
        409,
        "Trade event subscriber is disabled"
      );
    }

    if (this.consumerPause.isPaused()) {
      throw new SettlementServiceError(
        "SETTLEMENT_EVENT_SUBSCRIBER_PAUSED",
        409,
        "Trade event consumer is paused by the fault lab; resume it first"
      );
    }

    if (this.tradeEventSubscriberCycleRunning) {
      throw new SettlementServiceError(
        "SETTLEMENT_EVENT_SUBSCRIBER_BUSY",
        409,
        "Trade event subscriber cycle is already running"
      );
    }

    this.tradeEventSubscriberCycleRunning = true;
    try {
      return await this.tradeEventSubscriber.runOnce({
        market: command.market,
        allowGap: command.allowGap,
        afterStreamEntryId: command.afterStreamEntryId,
        limit: command.limit,
        overlapCount: command.overlapCount,
        trigger: "manual"
      });
    } finally {
      this.tradeEventSubscriberCycleRunning = false;
    }
  }

  /** Fault lab: consumer pause state plus per-market "executed but not settled" lag. */
  async getConsumerLabState() {
    const report = await this.getTradeEventBusReport({ consumerId: this.readConsumerId() });
    return {
      consumerId: this.readConsumerId(),
      subscriberEnabled: Boolean(this.tradeEventSubscriber),
      pause: this.consumerPause.getState(),
      lag: (report.checkpointLag ?? []).map((checkpoint) => ({
        market: checkpoint.market,
        lastExecutionSequence: checkpoint.lastExecutionSequence,
        latestExecutionSequence: checkpoint.latestExecutionSequence,
        executionSequenceLag: checkpoint.executionSequenceLag,
        streamUpToDate: checkpoint.streamUpToDate,
        updatedAt: checkpoint.updatedAt
      }))
    };
  }

  async pauseConsumer(command: { durationMs?: number; reason?: string; requestedBy?: string }) {
    if (!this.tradeEventSubscriber) {
      throw new SettlementServiceError(
        "SETTLEMENT_EVENT_SUBSCRIBER_DISABLED",
        409,
        "Trade event subscriber is disabled"
      );
    }
    const pause = this.consumerPause.pause(command);
    console.warn(
      `settlement trade event consumer paused until ${pause.expiresAt} (${pause.reason ?? "fault lab"})`
    );
    return this.getConsumerLabState();
  }

  async resumeConsumer() {
    this.consumerPause.resume("manual");
    // Catch up straight away instead of waiting for the next poll.
    this.scheduleTradeEventSubscriberCycle("automatic");
    return this.getConsumerLabState();
  }

  async processRecoveryJobs(limit?: number) {
    return this.recoveryWorker.runOnce(limit, "manual");
  }

  async recoverTrade(tradeId: string) {
    const startedAt = new Date();
    try {
      const result = await this.applicationService.recoverTrade(tradeId);
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "manual_replay",
        status: "succeeded",
        trigger: "manual",
        market: result.market,
        targetId: tradeId,
        summary: {
          tradeId,
          settlementId: result.settlementId,
          status: result.status
        },
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      return result;
    } catch (error) {
      await this.applicationService.persistAutomationExecutionSafely({
        executionType: "manual_replay",
        status: "failed",
        trigger: "manual",
        targetId: tradeId,
        summary: { tradeId },
        errorMessage: error instanceof Error ? error.message : "unknown settlement replay error",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      throw error;
    }
  }

  private readConsumerId(): string {
    return (
      this.tradeEventSubscriber?.getConsumerId() ??
      (process.env.SETTLEMENT_EVENT_CONSUMER_ID?.trim() || "settlement-service")
    );
  }

  private scheduleTradeEventSubscriberCycle(trigger: "automatic"): void {
    if (!this.tradeEventSubscriber || this.tradeEventSubscriberCycleRunning) {
      return;
    }

    this.tradeEventSubscriberCycleRunning = true;
    void this.tradeEventSubscriber
      .runOnce({ trigger })
      .catch((error) => {
        console.warn(
          `settlement trade event subscription cycle failed: ${readErrorMessage(error)}`
        );
      })
      .finally(() => {
        this.tradeEventSubscriberCycleRunning = false;
      });
  }

  private async listTradeEventStreamHeads(
    market?: ListTradeEventConsumerCheckpointsQuery["market"]
  ) {
    if (!this.tradeEventClient?.getTradeEventStreamHead) {
      return [];
    }

    const markets = resolveTradeEventStreamMarkets(market);
    const heads = await Promise.all(
      markets.map((item) => this.tradeEventClient?.getTradeEventStreamHead?.(item))
    );
    return heads.filter((item): item is NonNullable<typeof item> => item !== null && item !== undefined);
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown settlement subscription error";
}
