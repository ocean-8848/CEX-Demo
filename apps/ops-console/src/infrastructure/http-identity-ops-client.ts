import type {
  OpsFreezeUserCommand,
  OpsIdentityClient,
  OpsKycRequestQuery,
  OpsReviewKycRequestCommand,
  OpsSetKycTierCommand,
  OpsLoginCommand,
  OpsSession,
  OpsSessionInfo,
  OpsUserQuery,
  PagedResponse
} from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpIdentityOpsClient implements OpsIdentityClient {
  constructor(private readonly baseUrl: string) {}

  async login(command: OpsLoginCommand): Promise<OpsSession> {
    return this.fetchJson("/api/v1/identity/ops/sessions", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async getCurrentSession(token: string): Promise<OpsSessionInfo> {
    return this.fetchJson("/api/v1/identity/ops/sessions/current", {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
  }

  async logout(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.fetchJson("/api/v1/identity/ops/sessions/logout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
  }

  async listUsers(query: OpsUserQuery): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(
      `/api/v1/identity/users?${buildQueryString(query as QueryValueMap)}`,
      {
        method: "GET"
      }
    );
  }

  async freezeUser(command: OpsFreezeUserCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${command.userId}/freeze`, {
      method: "POST",
      body: JSON.stringify({
        reason: command.reason
      })
    });
  }

  async unfreezeUser(userId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${userId}/unfreeze`, {
      method: "POST"
    });
  }

  async getKycProfile(userId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${encodeURIComponent(userId)}/kyc`, {
      method: "GET"
    });
  }

  async listKycRequests(
    query: OpsKycRequestQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(
      `/api/v1/identity/kyc/requests?${buildQueryString(query as QueryValueMap)}`,
      { method: "GET" }
    );
  }

  async approveKycRequest(command: OpsReviewKycRequestCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/identity/kyc/requests/${encodeURIComponent(command.requestId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          reviewedBy: command.reviewedBy,
          tier: command.tier,
          note: command.note
        })
      }
    );
  }

  async rejectKycRequest(command: OpsReviewKycRequestCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(
      `/api/v1/identity/kyc/requests/${encodeURIComponent(command.requestId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({
          reviewedBy: command.reviewedBy,
          note: command.note
        })
      }
    );
  }

  async setKycTier(command: OpsSetKycTierCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${encodeURIComponent(command.userId)}/kyc/tier`, {
      method: "POST",
      body: JSON.stringify({
        tier: command.tier,
        actorId: command.actorId,
        reason: command.reason
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
          "content-type": "application/json",
          ...((init?.headers ?? {}) as Record<string, string>)
        }
      })
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        "IDENTITY_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Identity service rejected request: ${payload}`
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
