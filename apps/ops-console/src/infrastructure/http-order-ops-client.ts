import type {
  OpsAutomationExecutionQuery,
  OpsMaintainTradeEventStreamCommand,
  OpsOrderClient,
  OpsProcessRecoveryJobsCommand,
  OpsReplayTradeEventStreamCommand,
  OpsSpotRecoveryJobQuery,
  OpsSpotOrderQuery,
  OpsSpotTradeQuery,
  OpsTradeDeadLetterReportQuery,
  OpsTradeEventStreamQuery,
  OpsTradeOpsQuery,
  OpsTrimTradeEventStreamCommand
} from "../domain/clients.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpOrderOpsClient implements OpsOrderClient {
  constructor(private readonly baseUrl: string) {}

  async listSpotOrders(query: OpsSpotOrderQuery): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async listSpotTrades(query: OpsSpotTradeQuery): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/trades?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async getTradeEventBusReport(): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/event-bus`);
  }

  async listTradeEventStreamEntries(
    query: OpsTradeEventStreamQuery
  ): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders/ops/event-bus/streams/events?${toQuery(
        query as unknown as Record<string, unknown>
      )}`
    );
  }

  async replayTradeEventStream(
    command: OpsReplayTradeEventStreamCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/event-bus/streams/replay`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async trimTradeEventStream(
    command: OpsTrimTradeEventStreamCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/event-bus/streams/trim`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async maintainTradeEventStream(
    command: OpsMaintainTradeEventStreamCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/event-bus/streams/maintenance`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async getTradeOpsOverview(query: OpsTradeOpsQuery): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/orders/ops/overview?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async getTradeOpsAnomalies(query: OpsTradeOpsQuery): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders/ops/anomalies?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async replayEngineBook(command: OpsTradeOpsQuery): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/replay-engine`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listRecoveryJobs(query: OpsSpotRecoveryJobQuery): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders/ops/recovery-jobs?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async getRecoveryMetrics(): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/recovery-metrics`);
  }

  async getRecoveryGovernanceReport(): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/recovery-governance`);
  }

  async getDeadLetterReport(
    query: OpsTradeDeadLetterReportQuery
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/orders/ops/dead-letter-report?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async listAutomationExecutions(
    query: OpsAutomationExecutionQuery
  ): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders/ops/automation-executions?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async listDeadLetterJobs(query: OpsSpotRecoveryJobQuery): Promise<Record<string, unknown>[]> {
    return this.fetchJson(
      `/api/v1/orders/ops/dead-letter-jobs?${toQuery(query as unknown as Record<string, unknown>)}`
    );
  }

  async processRecoveryJobs(
    command: OpsProcessRecoveryJobsCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/recovery-jobs/process`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async recoverJob(jobId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/recovery-jobs/${jobId}/recover`, {
      method: "POST"
    });
  }

  async requeueDeadLetterJob(jobId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/dead-letter-jobs/${jobId}/requeue`, {
      method: "POST"
    });
  }

  async batchRequeueDeadLetterJobs(command: {
    market?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/orders/ops/dead-letter-jobs/requeue`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody: init?.body as Buffer | string | undefined,
        headers: {
          "content-type": "application/json"
        }
      }),
      body: init?.body
    });

    if (!response.ok) {
      throw new Error(`Order service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }
}

function toQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}
