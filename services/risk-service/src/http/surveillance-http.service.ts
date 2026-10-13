import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { SurveillanceService, readSurveillanceThresholdsFromEnv } from "../application/surveillance-service.js";
import type { SurveillanceRepository } from "../domain/surveillance-repository.js";
import { HttpOrderActivityClient } from "../infrastructure/http-order-activity-client.js";
import { InMemorySurveillanceRepository } from "../infrastructure/in-memory-surveillance-repository.js";
import { PostgresSurveillanceRepository } from "../infrastructure/postgres-surveillance-repository.js";
import { createRiskPool } from "../infrastructure/postgres.js";

/**
 * A9 market surveillance wiring. The scan job runs every
 * RISK_SURVEILLANCE_INTERVAL_MS (default 60s) unless
 * RISK_SURVEILLANCE_ENABLED=false; ops can also trigger a scan.
 */
@Injectable()
export class SurveillanceHttpService implements OnModuleInit, OnModuleDestroy {
  readonly service: SurveillanceService;
  private readonly repository: SurveillanceRepository;
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;

  constructor() {
    this.repository =
      process.env.RISK_SURVEILLANCE_STORE === "memory" || process.env.RISK_MARKET_STATUS_STORE === "memory"
        ? new InMemorySurveillanceRepository()
        : new PostgresSurveillanceRepository(createRiskPool());
    this.service = new SurveillanceService(
      this.repository,
      new HttpOrderActivityClient(process.env.ORDER_SERVICE_BASE_URL ?? "http://127.0.0.1:3009"),
      { thresholds: readSurveillanceThresholdsFromEnv() }
    );
  }

  onModuleInit(): void {
    if (process.env.RISK_SURVEILLANCE_ENABLED === "false") {
      return;
    }
    const intervalMs = Number(process.env.RISK_SURVEILLANCE_INTERVAL_MS ?? "60000");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    const run = () => {
      void this.service.scan("automatic");
    };
    // Give order-service a moment to come up on a fresh stack start.
    this.firstRun = setTimeout(run, Math.min(intervalMs, 10_000));
    this.timer = setInterval(run, intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.firstRun) {
      clearTimeout(this.firstRun);
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.repository instanceof PostgresSurveillanceRepository) {
      await this.repository.close();
    }
  }
}
