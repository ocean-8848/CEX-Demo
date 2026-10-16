import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/**
 * fee tiers (order-service `/api/v1/fee-tiers`) and market surveillance
 * (risk-service `/api/v1/risk/surveillance`), both over internal HMAC.
 */
export class HttpFeesSurveillanceClient {
  constructor(private readonly options: { orderBaseUrl: string; riskBaseUrl: string }) {}

  getFeeTierConfig() {
    return this.fetchJson<Record<string, unknown>>("order", "/api/v1/fee-tiers");
  }

  getUserFeeTier(userId: string) {
    return this.fetchJson<Record<string, unknown>>("order", `/api/v1/fee-tiers/users/${encodeURIComponent(userId)}`);
  }

  listFeeTierAudit(userId: string, limit = 20) {
    return this.fetchJson<{ items: Record<string, unknown>[] }>(
      "order",
      `/api/v1/fee-tiers/audit?${new URLSearchParams({ userId, limit: String(limit) })}`
    );
  }

  setFeeTierOverride(userId: string, body: { tier: string; note: string; actor: string }) {
    return this.fetchJson<Record<string, unknown>>("order", `/api/v1/fee-tiers/users/${encodeURIComponent(userId)}/override`, body);
  }

  clearFeeTierOverride(userId: string, body: { note: string; actor: string }) {
    return this.fetchJson<Record<string, unknown>>(
      "order",
      `/api/v1/fee-tiers/users/${encodeURIComponent(userId)}/override/clear`,
      body
    );
  }

  getSurveillanceOverview() {
    return this.fetchJson<Record<string, unknown>>("risk", "/api/v1/risk/surveillance/overview");
  }

  listSurveillanceAlerts(query: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        params.set(key, value);
      }
    }
    return this.fetchJson<Record<string, unknown>>("risk", `/api/v1/risk/surveillance/alerts?${params.toString()}`);
  }

  getSurveillanceAlert(alertId: string) {
    return this.fetchJson<Record<string, unknown>>("risk", `/api/v1/risk/surveillance/alerts/${encodeURIComponent(alertId)}`);
  }

  updateSurveillanceAlertStatus(alertId: string, body: { status: string; note: string; actor: string }) {
    return this.fetchJson<Record<string, unknown>>(
      "risk",
      `/api/v1/risk/surveillance/alerts/${encodeURIComponent(alertId)}/status`,
      body
    );
  }

  runSurveillanceScan() {
    return this.fetchJson<Record<string, unknown>>("risk", "/api/v1/risk/surveillance/scan", {});
  }

  private async fetchJson<T>(service: "order" | "risk", path: string, body?: unknown): Promise<T> {
    const method = body === undefined ? "GET" : "POST";
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    const baseUrl = service === "order" ? this.options.orderBaseUrl : this.options.riskBaseUrl;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      body: rawBody,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody,
        headers: { "content-type": "application/json" }
      })
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        readUpstreamCode(payload) ?? (service === "order" ? "ORDER_UPSTREAM_FAILED" : "RISK_UPSTREAM_FAILED"),
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `${service === "order" ? "Order" : "Risk"} service rejected request: ${payload}`
      );
    }
    return (await response.json()) as T;
  }
}

function readUpstreamCode(payload: string): string | undefined {
  try {
    const code = (JSON.parse(payload) as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code) && code !== "HTTP_EXCEPTION" ? code : undefined;
  } catch {
    return undefined;
  }
}
