import type {
  OpsBalanceQuery,
  OpsLedgerDrainOutboxCommand,
  OpsLedgerReconciliationQuery,
  OpsLedgerReplayQuery,
  OpsLedgerClient,
  PagedResponse
} from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpLedgerOpsClient implements OpsLedgerClient {
  constructor(private readonly baseUrl: string) {}

  async listBalances(query: OpsBalanceQuery): Promise<PagedResponse<Record<string, unknown>>> {
    const path = `/api/v1/ledger/balances?${buildQueryString(query as QueryValueMap)}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        method: "GET",
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
      const payload = await response.text();
      throw new OpsConsoleError(
        "LEDGER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Ledger service rejected request: ${payload}`
      );
    }

    return (await response.json()) as PagedResponse<Record<string, unknown>>;
  }

  async getReconciliationReport(
    query: OpsLedgerReconciliationQuery
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/ledger/ops/reconciliation?${buildQueryString(query as QueryValueMap)}`
    );
  }

  async getReplayReport(query: OpsLedgerReplayQuery): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/ledger/ops/replay?${buildQueryString(query as unknown as QueryValueMap)}`
    );
  }

  async getOpsOverview(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/ledger/ops/overview");
  }

  async drainOutbox(
    command: OpsLedgerDrainOutboxCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/ledger/ops/outbox/drain", {
      method: "POST",
      body: JSON.stringify(command)
    });
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
        "LEDGER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Ledger service rejected request: ${payload}`
      );
    }

    return (await response.json()) as T;
  }
}

type QueryValueMap = Record<string, string | number | boolean | undefined>;

function buildQueryString(query: QueryValueMap): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    search.set(key, String(value));
  }

  return search.toString();
}
