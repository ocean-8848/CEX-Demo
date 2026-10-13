import type { PagedResponse } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import type {
  OpsAddAddressBlacklistCommand,
  OpsAddressBlacklistQuery,
  OpsLoginEventsQuery,
  OpsRemoveAddressBlacklistCommand,
  OpsRiskSecurityClient
} from "../domain/risk-security.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/** wallet-service KYT blacklist + identity-service login security, over internal HMAC. */
export class HttpRiskSecurityOpsClient implements OpsRiskSecurityClient {
  constructor(
    private readonly walletBaseUrl: string,
    private readonly identityBaseUrl: string
  ) {}

  async listAddressBlacklist(query: OpsAddressBlacklistQuery): Promise<PagedResponse<Record<string, unknown>>> {
    return this.wallet(`/api/v1/wallet/risk/address-blacklist${buildQuery(query)}`);
  }

  async addAddressBlacklistEntry(
    command: OpsAddAddressBlacklistCommand & { createdBy: string }
  ): Promise<Record<string, unknown>> {
    return this.wallet("/api/v1/wallet/risk/address-blacklist", { method: "POST", body: JSON.stringify(command) });
  }

  async removeAddressBlacklistEntry(
    command: OpsRemoveAddressBlacklistCommand & { removedBy: string }
  ): Promise<Record<string, unknown>> {
    return this.wallet(`/api/v1/wallet/risk/address-blacklist/${encodeURIComponent(command.entryId)}/remove`, {
      method: "POST",
      body: JSON.stringify({ reason: command.reason, removedBy: command.removedBy })
    });
  }

  async listAddressRiskLabels(): Promise<Record<string, unknown>> {
    return this.wallet("/api/v1/wallet/risk/address-labels");
  }

  async listLoginEvents(userId: string, query: OpsLoginEventsQuery): Promise<PagedResponse<Record<string, unknown>>> {
    return this.identity(`/api/v1/identity/users/${encodeURIComponent(userId)}/login-events${buildQuery(query)}`);
  }

  async listDevices(userId: string): Promise<Record<string, unknown>> {
    return this.identity(`/api/v1/identity/users/${encodeURIComponent(userId)}/devices`);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<Record<string, unknown>> {
    return this.identity(
      `/api/v1/identity/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: "POST", body: "{}" }
    );
  }

  private wallet<T>(path: string, init?: RequestInit): Promise<T> {
    return this.fetchJson(this.walletBaseUrl, path, "WALLET_UPSTREAM_FAILED", "Wallet", init);
  }

  private identity<T>(path: string, init?: RequestInit): Promise<T> {
    return this.fetchJson(this.identityBaseUrl, path, "IDENTITY_UPSTREAM_FAILED", "Identity", init);
  }

  private async fetchJson<T>(
    baseUrl: string,
    path: string,
    code: OpsConsoleError["code"],
    source: string,
    init?: RequestInit
  ): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      method,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody: init?.body as string | undefined,
        headers: { "content-type": "application/json" }
      })
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        code,
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `${source} service rejected request: ${payload}`
      );
    }
    return (await response.json()) as T;
  }
}

function buildQuery(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
