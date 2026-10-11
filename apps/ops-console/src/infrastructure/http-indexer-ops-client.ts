import type {
  OpsIndexerBacklogRepairCommand,
  OpsClosePendingDepositCommand,
  OpsIndexerClient,
  OpsIndexerPendingDepositQuery,
  OpsIndexerReplayCommand,
  OpsReplayPendingDepositCommand
} from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpIndexerOpsClient implements OpsIndexerClient {
  constructor(private readonly baseUrl: string) {}

  async getOpsOverview(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/indexer/ops/overview");
  }

  async replay(command: OpsIndexerReplayCommand): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/indexer/ops/replay", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async repairBacklog(
    command: OpsIndexerBacklogRepairCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/indexer/ops/backlog/repair", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listPendingDeposits(
    query: OpsIndexerPendingDepositQuery
  ): Promise<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    return this.fetchJson(`/api/v1/indexer/ops/pending-deposits?${toQuery({ ...query })}`);
  }

  async replayPendingDeposit(
    command: OpsReplayPendingDepositCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/indexer/ops/pending-deposits/${command.observationId}/replay`,
      {
        method: "POST",
        body: JSON.stringify({
          confirmations: command.confirmations,
          blockNumber: command.blockNumber,
          blockHash: command.blockHash,
          operatedBy: command.operatedBy,
          note: command.note
        })
      }
    );
  }

  async closePendingDeposit(
    command: OpsClosePendingDepositCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/indexer/ops/pending-deposits/${command.observationId}/close`,
      {
        method: "POST",
        body: JSON.stringify({
          operatedBy: command.operatedBy,
          note: command.note
        })
      }
    );
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      body: init?.body,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody: init?.body as Buffer | string | undefined,
        headers: {
          "content-type": "application/json",
          ...((init?.headers ?? {}) as Record<string, string>)
        }
      })
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        "INDEXER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Indexer service rejected request: ${payload}`
      );
    }

    return (await response.json()) as T;
  }
}

function toQuery(query: { [key: string]: unknown }): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
}
