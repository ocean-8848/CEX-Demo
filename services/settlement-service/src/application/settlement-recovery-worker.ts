import type { SpotMarket } from "@web3-cex/domain";

import { SettlementApplicationService } from "./settlement-application-service.js";
import type {
  ListSettlementRecoveryJobsQuery,
  SettlementAutomationTrigger,
  SettlementRecoveryGovernanceReport,
  SettlementRecoveryJob,
  SettlementRecoveryLeaseWorkerSummary
} from "../domain/types.js";

export interface SettlementRecoveryWorkerOptions {
  now?: () => Date;
  createWorkerId?: () => string;
  pollIntervalMs?: number;
  batchSize?: number;
  leaseRenewIntervalMs?: number;
  pageSize?: number;
}

export class SettlementRecoveryWorker {
  private readonly now: () => Date;
  private readonly createWorkerId: () => string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly pageSize: number;

  constructor(
    private readonly applicationService: SettlementApplicationService,
    options: SettlementRecoveryWorkerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createWorkerId =
      options.createWorkerId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return `settlement-recovery:${crypto.randomUUID()}`;
        }

        return `settlement-recovery:${Date.now()}`;
      });
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 20;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 5_000;
    this.pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 100), 20), 200);
  }

  async runOnce(
    limit = this.batchSize,
    trigger: SettlementAutomationTrigger = "automatic"
  ) {
    const workerId = this.createWorkerId();
    const cycleStartedAt = this.now();
    const claimedJobs = await this.applicationService.claimRecoveryJobs(limit, workerId);
    let completedCount = 0;
    let failedCount = 0;

    for (const job of claimedJobs) {
      await this.applicationService.renewRecoveryLease(job.tradeId, workerId);

      const renewalTimer = setInterval(() => {
        void this.applicationService.renewRecoveryLease(job.tradeId, workerId).catch(() => {});
      }, this.leaseRenewIntervalMs);

      try {
        await this.applicationService.processClaimedRecoveryJob(job.tradeId, workerId);
        completedCount += 1;
      } catch {
        failedCount += 1;
      } finally {
        clearInterval(renewalTimer);
      }
    }

    const cycleCompletedAt = this.now();
    const summary = {
      workerId,
      claimedCount: claimedJobs.length,
      processedCount: claimedJobs.length,
      completedCount,
      failedCount,
      tradeIds: claimedJobs.map((job) => job.tradeId),
      cycleStartedAt: cycleStartedAt.toISOString(),
      cycleCompletedAt: cycleCompletedAt.toISOString(),
      cycleDurationMs: cycleCompletedAt.getTime() - cycleStartedAt.getTime()
    };

    await this.applicationService.persistAutomationExecutionSafely({
      executionType: "recovery_cycle",
      status:
        summary.failedCount > 0
          ? summary.completedCount > 0
            ? "partial"
            : "failed"
          : "succeeded",
      trigger,
      workerId,
      summary,
      startedAt: summary.cycleStartedAt,
      completedAt: summary.cycleCompletedAt,
      durationMs: summary.cycleDurationMs
    });

    return summary;
  }

  async runForever(onCycle?: (summary: Record<string, unknown>) => void): Promise<never> {
    for (;;) {
      const summary = await this.runOnce(this.batchSize, "automatic");
      onCycle?.({
        ...summary,
        processedAt: this.now().toISOString()
      });
      await sleep(this.pollIntervalMs);
    }
  }

  async getGovernanceReport(): Promise<SettlementRecoveryGovernanceReport> {
    const generatedAt = this.now().toISOString();
    const [metrics, processingJobs] = await Promise.all([
      this.applicationService.getRecoveryMetrics(),
      this.collectJobs({ status: "processing" })
    ]);

    const workers = new Map<string, SettlementRecoveryLeaseWorkerSummary>();
    const expiredLeases: SettlementRecoveryGovernanceReport["expiredLeases"] = [];
    const orphanedLeases: SettlementRecoveryGovernanceReport["orphanedLeases"] = [];

    for (const job of processingJobs) {
      if (!job.leaseOwner) {
        orphanedLeases.push(mapLeaseJob(job));
        continue;
      }

      const worker = workers.get(job.leaseOwner) ?? {
        workerId: job.leaseOwner,
        leasedJobs: 0,
        expiredJobs: 0,
        markets: []
      };
      worker.leasedJobs += 1;
      if (!worker.markets.includes(job.market)) {
        worker.markets.push(job.market);
      }
      worker.lastHeartbeatAt = maxIso(worker.lastHeartbeatAt, job.leaseHeartbeatAt);
      worker.nextLeaseExpiryAt = minIso(worker.nextLeaseExpiryAt, job.leaseExpiresAt);

      if (job.leaseExpiresAt && job.leaseExpiresAt <= generatedAt) {
        worker.expiredJobs += 1;
        expiredLeases.push(mapLeaseJob(job));
      }
      workers.set(job.leaseOwner, worker);
    }

    return {
      generatedAt,
      metrics,
      activeWorkers: [...workers.values()].sort((left, right) =>
        left.workerId.localeCompare(right.workerId)
      ),
      expiredLeases: expiredLeases.sort(sortByLeaseUrgency),
      orphanedLeases: orphanedLeases.sort(sortByLeaseUrgency)
    };
  }

  private async collectJobs(
    query: Omit<ListSettlementRecoveryJobsQuery, "limit" | "offset">
  ): Promise<SettlementRecoveryJob[]> {
    const jobs: SettlementRecoveryJob[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.applicationService.listRecoveryJobs({
        ...query,
        limit: this.pageSize,
        offset
      });
      jobs.push(...page);
      if (page.length < this.pageSize) {
        return jobs;
      }
      offset += this.pageSize;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mapLeaseJob(job: SettlementRecoveryJob) {
  return {
    jobId: job.jobId,
    tradeId: job.tradeId,
    market: job.market,
    leaseOwner: job.leaseOwner,
    leaseHeartbeatAt: job.leaseHeartbeatAt,
    leaseExpiresAt: job.leaseExpiresAt,
    attemptCount: job.attemptCount,
    lastError: job.lastError
  };
}

function sortByLeaseUrgency(
  left: SettlementRecoveryGovernanceReport["expiredLeases"][number],
  right: SettlementRecoveryGovernanceReport["expiredLeases"][number]
): number {
  const leftLease = left.leaseExpiresAt ?? "";
  const rightLease = right.leaseExpiresAt ?? "";
  return leftLease.localeCompare(rightLease) || left.jobId.localeCompare(right.jobId);
}

function minIso(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  return candidate < current ? candidate : current;
}

function maxIso(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  return candidate > current ? candidate : current;
}
