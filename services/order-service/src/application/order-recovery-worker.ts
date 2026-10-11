import type { SpotMarket } from "@web3-cex/domain";

import { OrderApplicationService } from "./order-application-service.js";
import type {
  ListSpotOrderRecoveryJobsQuery,
  SpotOrderRecoveryDeadLetterBatchTemplate,
  SpotOrderRecoveryDeadLetterReport,
  SpotOrderAutomationTrigger,
  SpotOrderRecoveryGovernanceReport,
  SpotOrderRecoveryJob,
  SpotOrderRecoveryLeaseWorkerSummary
} from "../domain/types.js";

export interface OrderRecoveryWorkerOptions {
  now?: () => Date;
  createWorkerId?: () => string;
  pollIntervalMs?: number;
  batchSize?: number;
  leaseRenewIntervalMs?: number;
  pageSize?: number;
}

export class OrderRecoveryWorker {
  private readonly now: () => Date;
  private readonly createWorkerId: () => string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly pageSize: number;

  constructor(
    private readonly applicationService: OrderApplicationService,
    options: OrderRecoveryWorkerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createWorkerId =
      options.createWorkerId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return `order-recovery:${crypto.randomUUID()}`;
        }

        return `order-recovery:${Date.now()}`;
      });
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 20;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 5_000;
    this.pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 100), 20), 200);
  }

  async runOnce(
    limit = this.batchSize,
    trigger: SpotOrderAutomationTrigger = "automatic"
  ) {
    const workerId = this.createWorkerId();
    const cycleStartedAt = this.now();
    const claimedJobs = await this.applicationService.claimRecoveryJobs(limit, workerId);
    let completedCount = 0;
    let failedCount = 0;
    let deadLetteredCount = 0;
    let leaseRenewedCount = 0;

    for (const job of claimedJobs) {
      await this.applicationService.renewRecoveryLease(job.jobId, workerId);
      leaseRenewedCount += 1;

      const renewalTimer = setInterval(() => {
        void this.applicationService
          .renewRecoveryLease(job.jobId, workerId)
          .then(() => {
            leaseRenewedCount += 1;
          })
          .catch(() => {});
      }, this.leaseRenewIntervalMs);

      try {
        const result = await this.applicationService.processClaimedRecoveryJob(job.jobId, workerId);
        if (result.status === "completed") {
          completedCount += 1;
        } else {
          failedCount += 1;
          if (result.deadLetteredAt) {
            deadLetteredCount += 1;
          }
        }
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
      deadLetteredCount,
      leaseRenewedCount,
      jobIds: claimedJobs.map((job) => job.jobId),
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

  async getGovernanceReport(): Promise<SpotOrderRecoveryGovernanceReport> {
    const generatedAt = this.now().toISOString();
    const [metrics, processingJobs, deadLetterJobs] = await Promise.all([
      this.applicationService.getRecoveryMetrics(),
      this.collectJobs({ status: "processing" }),
      this.collectJobs({ deadLettered: true, status: "failed" })
    ]);

    const workers = new Map<string, SpotOrderRecoveryLeaseWorkerSummary>();
    const expiredLeases: SpotOrderRecoveryGovernanceReport["expiredLeases"] = [];
    const orphanedLeases: SpotOrderRecoveryGovernanceReport["orphanedLeases"] = [];

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

    const backlogByMarket = new Map<SpotMarket, number>();
    let oldestDeadLetteredAt: string | undefined;
    for (const job of deadLetterJobs) {
      backlogByMarket.set(job.market, (backlogByMarket.get(job.market) ?? 0) + 1);
      oldestDeadLetteredAt = minIso(oldestDeadLetteredAt, job.deadLetteredAt);
    }

    return {
      generatedAt,
      metrics,
      activeWorkers: [...workers.values()].sort((left, right) =>
        left.workerId.localeCompare(right.workerId)
      ),
      expiredLeases: expiredLeases.sort(sortByLeaseUrgency),
      orphanedLeases: orphanedLeases.sort(sortByLeaseUrgency),
      deadLetterBacklog: {
        totalJobs: deadLetterJobs.length,
        oldestDeadLetteredAt,
        byMarket: [...backlogByMarket.entries()]
          .map(([market, jobCount]) => ({ market, jobCount }))
          .sort((left, right) => right.jobCount - left.jobCount || left.market.localeCompare(right.market))
      }
    };
  }

  async getDeadLetterReport(query: {
    market?: SpotMarket;
    limit?: number;
    templateLimit?: number;
  }): Promise<SpotOrderRecoveryDeadLetterReport> {
    const jobs = await this.collectJobs({
      deadLettered: true,
      status: "failed",
      market: query.market
    });
    const groups = new Map<string, SpotOrderRecoveryDeadLetterReport["entries"][number]>();

    for (const job of jobs) {
      const errorKey = normalizeErrorKey(job.lastError);
      const groupKey = `${job.market}:${job.stage}:${errorKey}`;
      const existing = groups.get(groupKey) ?? {
        market: job.market,
        stage: job.stage,
        errorKey,
        jobCount: 0,
        maxAttemptCount: 0,
        oldestDeadLetteredAt: job.deadLetteredAt,
        mostRecentDeadLetteredAt: job.deadLetteredAt,
        sampleJobIds: []
      };
      existing.jobCount += 1;
      existing.maxAttemptCount = Math.max(existing.maxAttemptCount, job.attemptCount);
      existing.oldestDeadLetteredAt = minIso(existing.oldestDeadLetteredAt, job.deadLetteredAt);
      existing.mostRecentDeadLetteredAt = maxIso(
        existing.mostRecentDeadLetteredAt,
        job.deadLetteredAt
      );
      if (existing.sampleJobIds.length < 5) {
        existing.sampleJobIds.push(job.jobId);
      }
      groups.set(groupKey, existing);
    }

    const entries = [...groups.values()]
      .sort((left, right) => right.jobCount - left.jobCount || left.market.localeCompare(right.market))
      .slice(0, Math.max(query.limit ?? 20, 1));

    return {
      generatedAt: this.now().toISOString(),
      totalJobs: jobs.length,
      entries,
      templates: this.buildDeadLetterBatchTemplates(jobs, query.templateLimit)
    };
  }

  async getDeadLetterBatchTemplates(query: {
    market?: SpotMarket;
    limit?: number;
  }): Promise<SpotOrderRecoveryDeadLetterBatchTemplate[]> {
    const jobs = await this.collectJobs({
      deadLettered: true,
      status: "failed",
      market: query.market
    });
    return this.buildDeadLetterBatchTemplates(jobs, query.limit);
  }

  private async collectJobs(
    query: Omit<ListSpotOrderRecoveryJobsQuery, "limit" | "offset">
  ): Promise<SpotOrderRecoveryJob[]> {
    const jobs: SpotOrderRecoveryJob[] = [];
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

  private buildDeadLetterBatchTemplates(
    jobs: SpotOrderRecoveryJob[],
    limit = 5
  ): SpotOrderRecoveryDeadLetterBatchTemplate[] {
    const maxTemplates = Math.max(limit, 1);
    const marketCounts = new Map<SpotMarket, number>();
    for (const job of jobs) {
      marketCounts.set(job.market, (marketCounts.get(job.market) ?? 0) + 1);
    }

    const templates: SpotOrderRecoveryDeadLetterBatchTemplate[] = [];
    if (jobs.length > 0) {
      templates.push({
        templateId: "dead-letter:all",
        description: "全量死信批量重入队模板",
        endpoint: "/api/v1/orders/ops/dead-letter-jobs/requeue",
        method: "POST",
        payload: {
          limit: Math.min(jobs.length, this.batchSize)
        }
      });
    }

    for (const [market, jobCount] of [...marketCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, Math.max(maxTemplates - templates.length, 0))) {
      templates.push({
        templateId: `dead-letter:${market}`,
        description: `${market} 死信批量重入队模板`,
        endpoint: "/api/v1/orders/ops/dead-letter-jobs/requeue",
        method: "POST",
        payload: {
          market,
          limit: Math.min(jobCount, this.batchSize)
        }
      });
    }

    return templates.slice(0, maxTemplates);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeErrorKey(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 120 ? normalized.slice(0, 120) : normalized;
}

function mapLeaseJob(job: SpotOrderRecoveryJob) {
  return {
    jobId: job.jobId,
    orderId: job.orderId,
    market: job.market,
    leaseOwner: job.leaseOwner,
    leaseHeartbeatAt: job.leaseHeartbeatAt,
    leaseExpiresAt: job.leaseExpiresAt,
    attemptCount: job.attemptCount,
    lastError: job.lastError
  };
}

function sortByLeaseUrgency(
  left: SpotOrderRecoveryGovernanceReport["expiredLeases"][number],
  right: SpotOrderRecoveryGovernanceReport["expiredLeases"][number]
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
