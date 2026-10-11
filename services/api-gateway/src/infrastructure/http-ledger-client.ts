import { ApiGatewayError } from "../domain/errors.js";
import type {
  GatewayAccountStatement,
  GatewayAccountStatementQuery,
  GatewayJournalQuery,
  GatewayLedgerAccount,
  GatewayLedgerJournal,
  LedgerGatewayClient,
  PagedResult
} from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpLedgerClient implements LedgerGatewayClient {
  constructor(private readonly baseUrl: string) {}

  async getAccount(accountId: string): Promise<GatewayLedgerAccount> {
    return this.fetchJson(`/api/v1/ledger/accounts/${accountId}`);
  }

  async createAccount(command: {
    accountId: string;
    userId: string;
    accountType: GatewayLedgerAccount["accountType"];
  }): Promise<GatewayLedgerAccount> {
    return this.fetchJson("/api/v1/ledger/accounts", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listBalances(query: {
    userId: string;
    accountId?: string;
    assetCode?: string;
    accountType?: string;
    accountStatus?: "active" | "suspended" | "closed";
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/ledger/balances?${toQuery(query)}`);
  }

  async listJournalsWithEntries(query: GatewayJournalQuery): Promise<GatewayLedgerJournal[]> {
    // The list endpoint only returns summaries; load each journal for its entries.
    const summaries = await this.fetchJson<Array<{ journalId: string }>>(
      `/api/v1/ledger/journals?${toQuery({ ...query })}`
    );
    return Promise.all(
      summaries.map((summary) =>
        this.fetchJson<GatewayLedgerJournal>(
          `/api/v1/ledger/journals/${encodeURIComponent(summary.journalId)}`
        )
      )
    );
  }

  async getAccountStatement(
    accountId: string,
    query: GatewayAccountStatementQuery
  ): Promise<GatewayAccountStatement> {
    return this.fetchJson(
      `/api/v1/ledger/accounts/${encodeURIComponent(accountId)}/statement?${toQuery({ ...query })}`
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
      throw new ApiGatewayError(
        "LEDGER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Ledger service rejected request: ${payload}`
      );
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
