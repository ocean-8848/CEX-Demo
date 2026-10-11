import type {
  OpsAutomationExecutionQuery,
  OpsProcessRecoveryJobsCommand,
  OpsSettlementClient,
  OpsTradeEventBusCheckpointQuery,
  OpsTradeSettlementQuery,
  OpsTradeSettlementRecoveryJobQuery
} from "../domain/clients.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpSettlementOpsClient implements OpsSettlementClient {
  constructor(private readonly baseUrl: string) {}

  async listTradeSettlements(query: OpsTradeSettlementQuery): Promise<Record<string, unknown>[]> {
    const path = `/api/v1/settlement/trades?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  async getTradeSettlementReport(query: OpsTradeSettlementQuery): Promise<Record<string, unknown>> {
    const path = `/api/v1/settlement/trades/report?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async listTradeSettlementRecoveryJobs(
    query: OpsTradeSettlementRecoveryJobQuery
  ): Promise<Record<string, unknown>[]> {
    const path = `/api/v1/settlement/recovery-jobs?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  async getTradeEventBusReport(
    query: OpsTradeEventBusCheckpointQuery
  ): Promise<Record<string, unknown>> {
    const path = `/api/v1/settlement/event-bus?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async listTradeEventConsumerCheckpoints(
    query: OpsTradeEventBusCheckpointQuery
  ): Promise<Record<string, unknown>[]> {
    const path = `/api/v1/settlement/event-bus/checkpoints?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  async processTradeEventSubscriptionCycle(command: {
    market?: string;
    allowGap?: boolean;
    afterStreamEntryId?: string;
    limit?: number;
    overlapCount?: number;
  }): Promise<Record<string, unknown>> {
    const path = "/api/v1/settlement/event-bus/process";
    const body = JSON.stringify(command);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: {
          "content-type": "application/json"
        }
      }),
      body
    });
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async getTradeSettlementRecoveryGovernanceReport(): Promise<Record<string, unknown>> {
    const path = "/api/v1/settlement/recovery-governance";
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async listAutomationExecutions(
    query: OpsAutomationExecutionQuery
  ): Promise<Record<string, unknown>[]> {
    const path = `/api/v1/settlement/automation-executions?${toQuery(query as unknown as Record<string, unknown>)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  async processTradeSettlementRecoveryJobs(
    command: OpsProcessRecoveryJobsCommand
  ): Promise<Record<string, unknown>> {
    const path = "/api/v1/settlement/recovery-jobs/process";
    const body = JSON.stringify(command);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: {
          "content-type": "application/json"
        }
      }),
      body
    });
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async recoverTradeSettlement(tradeId: string): Promise<Record<string, unknown>> {
    const path = `/api/v1/settlement/trades/${tradeId}/recover`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Settlement service rejected request: ${await response.text()}`);
    }

    return (await response.json()) as Record<string, unknown>;
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
