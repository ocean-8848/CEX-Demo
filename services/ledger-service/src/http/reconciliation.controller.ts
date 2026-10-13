import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  ServiceUnavailableException
} from "@nestjs/common";

import { ReconciliationJobService } from "./reconciliation-job.service.js";

/**
 * Scheduled reconciliation (balance + order-vs-lock), run history and the
 * circuit breaker; plus the fault-lab drift injection used to demonstrate it.
 */
@Controller("/api/v1/ledger/ops/reconciliation")
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationJobService) {}

  private get job() {
    const job = this.reconciliation.job;
    if (!job) {
      throw new ServiceUnavailableException("Reconciliation job needs LEDGER_REPOSITORY=postgres");
    }
    return job;
  }

  /** Schedule, breaker settings, last / next run. */
  @Get("/job")
  getJob() {
    return this.job.getStatus();
  }

  /** Run history, most recent first. */
  @Get("/runs")
  async listRuns(@Query("limit") limit?: string) {
    const parsed = Number(limit ?? "20");
    const items = await this.reconciliation.listRuns(Number.isFinite(parsed) ? parsed : 20);
    return { job: this.job.getStatus(), items };
  }

  /** Runs now (joins a run that is already in progress) and returns the stored record. */
  @Post("/jobs/run")
  async runNow() {
    return this.job.runOnce("manual");
  }

  @Get("/lab/drift")
  async getDrift() {
    return this.requireLab().getState();
  }

  /** Fault lab: snapshot-only drift on the dedicated lab account. */
  @Post("/lab/drift")
  async injectDrift(@Body() body: { assetCode?: unknown; amount?: unknown }) {
    if (!this.reconciliation.isLabAsset(body?.assetCode)) {
      throw new BadRequestException("assetCode must be a configured asset");
    }
    const amount = typeof body?.amount === "string" && body.amount.trim() ? body.amount.trim() : "1";
    try {
      return await this.requireLab().inject({ assetCode: body.assetCode, amount });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post("/lab/drift/clear")
  async clearDrift() {
    return this.requireLab().clear();
  }

  private requireLab() {
    if (process.env.LEDGER_FAULT_LAB_ENABLED === "false") {
      throw new ForbiddenException({
        code: "LEDGER_FAULT_LAB_DISABLED",
        message: "The reconciliation drift lab is disabled (LEDGER_FAULT_LAB_ENABLED=false)"
      });
    }
    const lab = this.reconciliation.driftLab;
    if (!lab) {
      throw new ServiceUnavailableException("Reconciliation lab needs LEDGER_REPOSITORY=postgres");
    }
    return lab;
  }
}
