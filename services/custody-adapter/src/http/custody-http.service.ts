import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Network } from "@web3-cex/domain";
import type { Pool } from "pg";

import { CustodyApplicationService } from "../application/custody-application-service.js";
import { CustodyFaultLab } from "../application/custody-fault-lab.js";
import {
  defaultCustodyAlertThresholds,
  evaluateCustodyAlertThresholds,
  type CustodyAlertThresholds,
  type CustodyOpsOverview,
  type CustodyOpsReport,
  type CustodyWorkerScheduleSnapshot
} from "../application/custody-ops.js";
import { CustodyProviderHealthWorker } from "../application/custody-provider-health-worker.js";
import {
  CustodyProviderRuntimeRegistry,
  type CustodyProviderRouteRuntimeSnapshot
} from "../application/custody-provider-runtime-registry.js";
import { CustodyTransferSyncWorker } from "../application/custody-transfer-sync-worker.js";
import type { CustodyRepository } from "../domain/repository.js";
import type {
  CreateTransferCommand,
  CustodyTransferRecord,
  RetryTransferCommand,
  SyncTransferStatusCommand
} from "../domain/types.js";
import { CustodyOpsReporter } from "../infrastructure/custody-ops-reporter.js";
import { createCustodyProviderStack } from "../infrastructure/custody-runtime-factory.js";
import { InMemoryCustodyRepository } from "../infrastructure/in-memory-custody-repository.js";
import { createCustodyPool } from "../infrastructure/postgres.js";
import { PostgresCustodyRepository } from "../infrastructure/postgres-custody-repository.js";

@Injectable()
export class CustodyHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustodyHttpService.name);
  private readonly applicationService: CustodyApplicationService;
  private readonly repository: CustodyRepository;
  private readonly pool?: Pool;
  private readonly syncWorker: CustodyTransferSyncWorker;
  private readonly healthWorker: CustodyProviderHealthWorker;
  private readonly opsReporter?: CustodyOpsReporter;
  private readonly runtimeRegistry: CustodyProviderRuntimeRegistry;
  private readonly faultLab: CustodyFaultLab;
  private readonly syncScheduleEnabled: boolean;
  private readonly healthScheduleEnabled: boolean;
  private readonly syncPollIntervalMs: number;
  private readonly healthIntervalMs: number;
  private syncTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private syncRunning = false;
  private healthRunning = false;
  private readonly syncScheduleState: CustodyWorkerScheduleSnapshot;
  private readonly healthScheduleState: CustodyWorkerScheduleSnapshot;

  constructor() {
    const repositoryMode = process.env.CUSTODY_REPOSITORY ?? "postgres";
    const { providerResolver, runtimeRegistry, faultInjector } = createCustodyProviderStack(
      process.env
    );
    this.runtimeRegistry = runtimeRegistry;
    this.syncScheduleEnabled = parseBoolean(process.env.CUSTODY_AUTO_SYNC_ENABLED, true);
    this.healthScheduleEnabled = parseBoolean(
      process.env.CUSTODY_PROVIDER_HEALTHCHECK_ENABLED,
      true
    );
    this.syncPollIntervalMs = parseNumber(process.env.CUSTODY_SYNC_POLL_INTERVAL_MS, 5_000);
    this.healthIntervalMs = parseNumber(
      process.env.CUSTODY_PROVIDER_HEALTHCHECK_INTERVAL_MS,
      30_000
    );
    this.syncScheduleState = {
      workerName: "transfer_sync",
      enabled: this.syncScheduleEnabled,
      intervalMs: this.syncPollIntervalMs,
      running: false
    };
    this.healthScheduleState = {
      workerName: "provider_healthcheck",
      enabled: this.healthScheduleEnabled,
      intervalMs: this.healthIntervalMs,
      running: false
    };

    if (repositoryMode === "memory") {
      this.repository = new InMemoryCustodyRepository();
    } else {
      this.pool = createCustodyPool();
      this.repository = new PostgresCustodyRepository(this.pool, this.pool);
      this.opsReporter = new CustodyOpsReporter(this.pool, this.runtimeRegistry);
    }

    this.applicationService = new CustodyApplicationService(
      this.repository,
      providerResolver,
      {
        maxBroadcastAttempts: parseNumber(process.env.CUSTODY_MAX_BROADCAST_ATTEMPTS, 3),
        retryDelayMs: parseNumber(process.env.CUSTODY_RETRY_DELAY_MS, 60_000),
        runtimeRegistry: this.runtimeRegistry
      }
    );
    this.syncWorker = new CustodyTransferSyncWorker(this.repository, this.applicationService, {
      batchSize: parseNumber(process.env.CUSTODY_SYNC_BATCH_SIZE, 100),
      syncIntervalMs: parseNumber(process.env.CUSTODY_SYNC_INTERVAL_MS, 30_000)
    });
    this.healthWorker = new CustodyProviderHealthWorker(providerResolver, this.runtimeRegistry);
    this.faultLab = new CustodyFaultLab(
      faultInjector,
      providerResolver,
      this.runtimeRegistry,
      this.healthWorker
    );
  }

  getFaultLabState(network?: Network) {
    return this.faultLab.getState(network);
  }

  injectProviderFailure(command: {
    providerName?: string;
    durationMs?: number;
    reason?: string;
    requestedBy?: string;
  }) {
    const result = this.faultLab.inject(command);
    this.logger.warn(
      `fault lab: ${result.injection.providerName} broadcasts fail until ${result.injection.expiresAt}`
    );
    return result;
  }

  async clearProviderFailure(providerName?: string) {
    return this.faultLab.clear(providerName);
  }

  async probeBroadcast(command: { network?: Network; count?: number }) {
    return this.faultLab.probeBroadcast(command);
  }

  async onModuleInit(): Promise<void> {
    if (this.healthScheduleEnabled) {
      if (parseBoolean(process.env.CUSTODY_PROVIDER_HEALTHCHECK_RUN_ON_START, true)) {
        await this.runScheduledHealthCheck();
      }

      this.healthTimer = setInterval(() => {
        void this.runScheduledHealthCheck();
      }, this.healthIntervalMs);
    }

    if (this.syncScheduleEnabled) {
      if (parseBoolean(process.env.CUSTODY_AUTO_SYNC_RUN_ON_START, true)) {
        await this.runScheduledSync();
      }

      this.syncTimer = setInterval(() => {
        void this.runScheduledSync();
      }, this.syncPollIntervalMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    await this.pool?.end();
  }

  async createTransfer(command: CreateTransferCommand): Promise<CustodyTransferRecord> {
    return this.applicationService.createTransfer(command);
  }

  async retryTransfer(command: RetryTransferCommand): Promise<CustodyTransferRecord> {
    return this.applicationService.retryTransfer(command);
  }

  async syncTransferStatus(command: SyncTransferStatusCommand): Promise<CustodyTransferRecord> {
    return this.applicationService.syncTransferStatus(command);
  }

  async getTransfer(custodyTransferId: string): Promise<CustodyTransferRecord | null> {
    return this.applicationService.getTransfer(custodyTransferId);
  }

  async runProviderHealthChecks() {
    return this.healthWorker.runOnce();
  }

  async getProviderHealth(): Promise<CustodyProviderRouteRuntimeSnapshot[]> {
    return this.runtimeRegistry.listRouteSnapshots();
  }

  async getOpsOverview(): Promise<CustodyOpsOverview> {
    const thresholds = loadAlertThresholds();
    const schedules = this.getScheduleSnapshots();

    if (this.opsReporter) {
      return this.opsReporter.buildOpsOverview({
        generatedAt: new Date().toISOString(),
        thresholds,
        schedules
      });
    }

    const routes = this.runtimeRegistry.listRouteSnapshots();
    return evaluateCustodyAlertThresholds(
      {
        generatedAt: new Date().toISOString(),
        backlog: {
          pendingSyncCount: 0,
          retryableCount: 0,
          failedCount: 0
        },
        routes,
        schedules,
        openCircuitCount: routes.filter((route) => route.circuitState === "open").length,
        unhealthyRouteCount: routes.filter((route) => route.healthStatus === "unhealthy").length
      },
      thresholds
    );
  }

  async getOpsReport(): Promise<CustodyOpsReport> {
    const generatedAt = new Date().toISOString();
    const thresholds = loadAlertThresholds();
    const schedules = this.getScheduleSnapshots();
    const windowHours = parseNumber(process.env.CUSTODY_REPORT_WINDOW_HOURS, 24);

    if (this.opsReporter) {
      return this.opsReporter.buildOpsReport({
        generatedAt,
        thresholds,
        schedules,
        windowHours
      });
    }

    return {
      generatedAt,
      windowHours,
      overview: await this.getOpsOverview(),
      providerSla: this.runtimeRegistry.listRouteSnapshots().map((route) => ({
        providerName: route.providerName,
        network: route.network,
        priority: route.priority,
        healthStatus: route.healthStatus,
        circuitState: route.circuitState,
        transferCount: 0,
        confirmedCount: 0,
        failedCount: 0,
        pendingCount: 0,
        broadcastAttemptCount: route.broadcastSuccessCount + route.broadcastFailureCount,
        broadcastSuccessRate: buildRate(
          route.broadcastSuccessCount,
          route.broadcastSuccessCount + route.broadcastFailureCount
        ),
        syncAttemptCount: route.syncSuccessCount + route.syncFailureCount,
        syncSuccessRate: buildRate(
          route.syncSuccessCount,
          route.syncSuccessCount + route.syncFailureCount
        ),
        retryAttemptCount: route.broadcastFailureCount,
        routeSelectionCount: route.routeSelectionCount,
        lastSelectionAt: route.lastSelectionAt,
        lastSuccessAt: route.lastSuccessAt,
        lastFailureAt: route.lastFailureAt,
        lastHealthCheckedAt: route.lastHealthCheckedAt,
        lastHealthLatencyMs: route.lastHealthLatencyMs
      }))
    };
  }

  private async runScheduledSync(): Promise<void> {
    if (this.syncRunning) {
      return;
    }

    this.syncRunning = true;
    this.syncScheduleState.running = true;
    this.syncScheduleState.lastStartedAt = new Date().toISOString();
    const startedAt = Date.now();

    try {
      const result = await this.syncWorker.runOnce();
      this.syncScheduleState.lastSucceededAt = new Date().toISOString();
      this.syncScheduleState.lastErrorMessage = undefined;
      this.syncScheduleState.lastResult = result as Record<string, unknown>;
      if (result.failedCount > 0 || result.retriedCount > 0 || result.syncedCount > 0) {
        this.logger.log(`custody sync cycle ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.syncScheduleState.lastFailedAt = new Date().toISOString();
      this.syncScheduleState.lastErrorMessage =
        error instanceof Error ? error.message : "Scheduled custody sync failed";
      this.logger.error(
        error instanceof Error ? error.message : "Scheduled custody sync failed"
      );
    } finally {
      this.syncRunning = false;
      this.syncScheduleState.running = false;
      this.syncScheduleState.lastFinishedAt = new Date().toISOString();
      this.syncScheduleState.lastDurationMs = Date.now() - startedAt;
    }
  }

  private async runScheduledHealthCheck(): Promise<void> {
    if (this.healthRunning) {
      return;
    }

    this.healthRunning = true;
    this.healthScheduleState.running = true;
    this.healthScheduleState.lastStartedAt = new Date().toISOString();
    const startedAt = Date.now();

    try {
      const result = await this.healthWorker.runOnce();
      this.healthScheduleState.lastSucceededAt = new Date().toISOString();
      this.healthScheduleState.lastErrorMessage = undefined;
      this.healthScheduleState.lastResult = result as Record<string, unknown>;
      if (result.failedCount > 0 || result.unhealthyCount > 0 || result.degradedCount > 0) {
        this.logger.warn(`custody health cycle ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.healthScheduleState.lastFailedAt = new Date().toISOString();
      this.healthScheduleState.lastErrorMessage =
        error instanceof Error ? error.message : "Scheduled custody health check failed";
      this.logger.error(
        error instanceof Error ? error.message : "Scheduled custody health check failed"
      );
    } finally {
      this.healthRunning = false;
      this.healthScheduleState.running = false;
      this.healthScheduleState.lastFinishedAt = new Date().toISOString();
      this.healthScheduleState.lastDurationMs = Date.now() - startedAt;
    }
  }

  private getScheduleSnapshots(): CustodyWorkerScheduleSnapshot[] {
    return [
      { ...this.healthScheduleState },
      { ...this.syncScheduleState }
    ];
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === "true";
}

function loadAlertThresholds(): CustodyAlertThresholds {
  const defaults = defaultCustodyAlertThresholds();

  return {
    maxPendingSyncCount: parseNumber(
      process.env.CUSTODY_ALERT_MAX_PENDING_SYNC_COUNT,
      defaults.maxPendingSyncCount
    ),
    maxRetryableCount: parseNumber(
      process.env.CUSTODY_ALERT_MAX_RETRYABLE_COUNT,
      defaults.maxRetryableCount
    ),
    maxFailedCount: parseNumber(
      process.env.CUSTODY_ALERT_MAX_FAILED_COUNT,
      defaults.maxFailedCount
    ),
    maxOldestPendingSyncAgeSeconds: parseNumber(
      process.env.CUSTODY_ALERT_MAX_OLDEST_PENDING_SYNC_AGE_SECONDS,
      defaults.maxOldestPendingSyncAgeSeconds
    ),
    maxOpenCircuitCount: parseNumber(
      process.env.CUSTODY_ALERT_MAX_OPEN_CIRCUIT_COUNT,
      defaults.maxOpenCircuitCount
    ),
    maxUnhealthyRouteCount: parseNumber(
      process.env.CUSTODY_ALERT_MAX_UNHEALTHY_ROUTE_COUNT,
      defaults.maxUnhealthyRouteCount
    )
  };
}

function buildRate(successCount: number, totalCount: number): number | undefined {
  if (totalCount <= 0) {
    return undefined;
  }

  return Number(((successCount / totalCount) * 100).toFixed(2));
}
