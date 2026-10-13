import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { isAssetCode } from "@web3-cex/domain";

import { ReconciliationJob } from "../application/reconciliation-job.js";
import {
  HttpOrderLockExpectationClient,
  HttpWithdrawalPauseClient
} from "../infrastructure/http-reconciliation-clients.js";
import { ReconciliationDriftLab } from "../infrastructure/reconciliation-drift-lab.js";
import {
  InMemoryReconciliationRunRepository,
  PostgresReconciliationRunRepository
} from "../infrastructure/reconciliation-run-repositories.js";
import { LedgerHttpService } from "./ledger-http.service.js";

const logger = new Logger("Reconciliation");

/**
 * Hosts the scheduled reconciliation job inside ledger-service.
 * RECONCILIATION_INTERVAL_SECONDS=0 (the code default) disables the schedule;
 * `pnpm demo:up` / `stack:start` pass 30.
 */
@Injectable()
export class ReconciliationJobService implements OnModuleInit, OnModuleDestroy {
  readonly job: ReconciliationJob | null;
  readonly driftLab: ReconciliationDriftLab | null;
  private readonly runs: { list(limit: number): Promise<unknown[]> };
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;

  constructor(ledgerHttpService: LedgerHttpService) {
    const { pool, reporter } = ledgerHttpService.getOpsInfrastructure();
    this.driftLab = pool ? new ReconciliationDriftLab(pool) : null;
    const runs = pool
      ? new PostgresReconciliationRunRepository(pool, readInt("RECONCILIATION_HISTORY_LIMIT", 2000, 10))
      : new InMemoryReconciliationRunRepository();
    this.runs = runs;
    this.job = reporter
      ? new ReconciliationJob({
          ledger: reporter,
          orders: new HttpOrderLockExpectationClient(
            process.env.LEDGER_ORDER_SERVICE_URL ?? "http://127.0.0.1:3009"
          ),
          withdrawals: new HttpWithdrawalPauseClient(
            process.env.LEDGER_RISK_SERVICE_URL ?? "http://127.0.0.1:3008"
          ),
          runs,
          config: {
            intervalSeconds: readInt("RECONCILIATION_INTERVAL_SECONDS", 0, 0),
            graceMs: readInt("RECONCILIATION_ORDER_LOCK_GRACE_SECONDS", 15, 0) * 1000,
            breakerEnabled: (process.env.RECONCILIATION_BREAKER_ENABLED ?? "true") !== "false",
            confirmations: readInt("RECONCILIATION_BREAKER_CONFIRMATIONS", 2, 1)
          },
          log: (level, message) => {
            if (level === "error") {
              logger.error(message);
            } else if (level === "warn") {
              logger.warn(message);
            } else {
              logger.log(message);
            }
          }
        })
      : null;
  }

  onModuleInit(): void {
    const job = this.job;
    const intervalSeconds = job?.config.intervalSeconds ?? 0;
    if (!job || intervalSeconds <= 0) {
      return;
    }
    // Other services start after ledger-service; wait before the first run.
    const initialDelaySeconds = readInt("RECONCILIATION_INITIAL_DELAY_SECONDS", intervalSeconds, 0);
    const schedule = (delayMs: number) => job.setNextRunAt(new Date(Date.now() + delayMs).toISOString());
    const tick = () => {
      schedule(intervalSeconds * 1000);
      void job.runOnce("scheduled").catch((error) => logger.error(`scheduled run failed: ${String(error)}`));
    };
    schedule(initialDelaySeconds * 1000);
    this.initialTimer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, intervalSeconds * 1000);
      this.timer.unref?.();
    }, initialDelaySeconds * 1000);
    this.initialTimer.unref?.();
    logger.log(`scheduled every ${intervalSeconds}s (first run in ${initialDelaySeconds}s)`);
  }

  onModuleDestroy(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async listRuns(limit: number) {
    return this.runs.list(Math.min(Math.max(Math.trunc(limit), 1), 200));
  }

  isLabAsset(assetCode: unknown): assetCode is string {
    return typeof assetCode === "string" && isAssetCode(assetCode);
  }
}

function readInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), min) : fallback;
}
