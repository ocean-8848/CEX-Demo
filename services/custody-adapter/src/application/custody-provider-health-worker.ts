import { CustodyError } from "../domain/errors.js";
import type { CustodyProviderResolver } from "../domain/provider.js";
import type { CustodyProviderHealthcheckResult } from "../domain/types.js";
import { CustodyProviderRuntimeRegistry } from "./custody-provider-runtime-registry.js";

interface WorkerOptions {
  now?: () => Date;
}

export class CustodyProviderHealthWorker {
  private readonly now: () => Date;

  constructor(
    private readonly providerResolver: CustodyProviderResolver,
    private readonly runtimeRegistry: CustodyProviderRuntimeRegistry,
    options: WorkerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<{
    checkedCount: number;
    healthyCount: number;
    degradedCount: number;
    unhealthyCount: number;
    failedCount: number;
    routes: string[];
  }> {
    const seen = new Set<string>();
    const reports: CustodyProviderHealthcheckResult[] = [];
    let failedCount = 0;

    for (const route of this.providerResolver.listProviderRoutes()) {
      const key = `${route.providerName}:${route.network}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const provider = this.providerResolver.getProviderByName(route.providerName);

      if (!provider.supportsNetwork(route.network)) {
        const unsupported: CustodyProviderHealthcheckResult = {
          providerName: provider.providerName,
          network: route.network,
          status: "unhealthy",
          errorCode: "PROVIDER_UNSUPPORTED_NETWORK",
          errorMessage: `Provider ${provider.providerName} is not configured for ${route.network}`
        };
        this.runtimeRegistry.recordHealthcheck(unsupported);
        reports.push(unsupported);
        failedCount += 1;
        continue;
      }

      const startedAt = this.now().getTime();

      try {
        const report = await provider.checkHealth({
          network: route.network
        });
        const normalizedReport: CustodyProviderHealthcheckResult = {
          ...report,
          latencyMs: report.latencyMs ?? this.now().getTime() - startedAt
        };
        this.runtimeRegistry.recordHealthcheck(normalizedReport);
        reports.push(normalizedReport);
      } catch (error) {
        const custodyError =
          error instanceof CustodyError
            ? error
            : new CustodyError(
                "PROVIDER_HEALTHCHECK_FAILED",
                error instanceof Error ? error.message : "Failed to check provider health"
              );
        const failedReport: CustodyProviderHealthcheckResult = {
          providerName: provider.providerName,
          network: route.network,
          status: "unhealthy",
          latencyMs: this.now().getTime() - startedAt,
          errorCode: custodyError.code,
          errorMessage: custodyError.message,
          metadata: {
            checkedAt: this.now().toISOString()
          }
        };
        this.runtimeRegistry.recordHealthcheck(failedReport);
        reports.push(failedReport);
        failedCount += 1;
      }
    }

    return {
      checkedCount: reports.length,
      healthyCount: reports.filter((report) => report.status === "healthy").length,
      degradedCount: reports.filter((report) => report.status === "degraded").length,
      unhealthyCount: reports.filter((report) => report.status === "unhealthy").length,
      failedCount,
      routes: reports.map((report) => `${report.providerName}:${report.network}`)
    };
  }
}
