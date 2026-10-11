import type { OpsCustodyClient } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpCustodyOpsClient implements OpsCustodyClient {
  constructor(private readonly baseUrl: string) {}

  async getProviderHealth(): Promise<Record<string, unknown>[]> {
    return this.fetchJson("/api/v1/custody/providers/health");
  }

  async runProviderHealthChecks(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/custody/providers/health/check", {
      method: "POST"
    });
  }

  async getOpsOverview(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/custody/ops/overview");
  }

  async getTransfer(custodyTransferId: string): Promise<Record<string, unknown> | null> {
    const path = `/api/v1/custody/transfers/${custodyTransferId}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });

    if (response.status === 404) {
      return null;
    }

    return this.parseResponse<Record<string, unknown>>(response);
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
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

    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        "CUSTODY_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Custody adapter rejected request: ${payload}`
      );
    }

    return (await response.json()) as T;
  }
}
