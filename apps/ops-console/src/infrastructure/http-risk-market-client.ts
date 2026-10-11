import type { OpsMarketClient, OpsSetMarketStatusCommand } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/** Reads / changes market status through risk-service (`/api/v1/risk/markets`). */
export class HttpRiskMarketClient implements OpsMarketClient {
  constructor(private readonly baseUrl: string) {}

  async listMarkets(): Promise<Record<string, unknown>[]> {
    return this.fetchJson("/api/v1/risk/markets");
  }

  async setMarketStatus(
    command: OpsSetMarketStatusCommand & { operator: string }
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/risk/markets/${encodeURIComponent(command.market)}/status`, {
      method: "POST",
      body: JSON.stringify({
        status: command.status,
        reason: command.reason,
        operator: command.operator
      })
    });
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
          "content-type": "application/json"
        }
      })
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        readUpstreamCode(payload) ?? "RISK_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Risk service rejected request: ${payload}`
      );
    }

    return (await response.json()) as T;
  }
}

function readUpstreamCode(payload: string): string | undefined {
  try {
    const code = (JSON.parse(payload) as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code) && code !== "HTTP_EXCEPTION"
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}
