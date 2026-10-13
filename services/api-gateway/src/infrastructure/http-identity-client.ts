import { ApiGatewayError } from "../domain/errors.js";
import type {
  ApiKeyAuthInfo,
  CustomerSessionInfo,
  IdentityGatewayClient
} from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpIdentityClient implements IdentityGatewayClient {
  constructor(private readonly baseUrl: string) {}

  async registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/identity/auth/register", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async createCustomerSession(command: {
    email: string;
    password: string;
    twoFactorCode?: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<CustomerSessionInfo & { token: string }> {
    return this.fetchJson("/api/v1/identity/auth/sessions", {
      method: "POST",
      body: JSON.stringify({
        email: command.email,
        password: command.password,
        twoFactorCode: command.twoFactorCode,
        deviceId: command.deviceId
      }),
      headers: {
        ...(command.userAgent ? { "user-agent": command.userAgent } : {}),
        ...(command.ipAddress ? { "x-forwarded-for": command.ipAddress } : {})
      }
    });
  }

  async introspectCustomerSession(token: string): Promise<CustomerSessionInfo> {
    return this.fetchJson("/api/v1/identity/auth/sessions/current", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
  }

  async revokeCustomerSession(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.fetchJson("/api/v1/identity/auth/sessions/logout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
  }

  async createApiKey(
    userId: string,
    command: {
      label: string;
      scopes?: string[];
      expiresAt?: string;
      createdBy?: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${userId}/api-keys`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listApiKeys(userId: string): Promise<Record<string, unknown>[]> {
    return this.fetchJson(`/api/v1/identity/users/${userId}/api-keys`);
  }

  async revokeApiKey(userId: string, apiKeyId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/identity/users/${userId}/api-keys/${apiKeyId}/revoke`, {
      method: "POST"
    });
  }

  async verifyApiKeySignature(command: {
    keyId: string;
    canonicalRequest: string;
    signature: string;
  }): Promise<ApiKeyAuthInfo> {
    try {
      return await this.fetchJson("/api/v1/identity/internal/api-keys/verify-signature", {
        method: "POST",
        body: JSON.stringify(command)
      });
    } catch (error) {
      // Unknown, revoked or mis-signed keys are all authentication failures to
      // the caller; surface identity's code and message instead of a 404/JSON blob.
      if (error instanceof ApiGatewayError && error.statusCode >= 400 && error.statusCode < 500) {
        const detail = parseUpstreamDetail(error.message);
        throw new ApiGatewayError(
          detail.code ?? "INVALID_API_KEY",
          error.statusCode === 403 ? 403 : 401,
          detail.message ?? error.message
        );
      }
      throw error;
    }
  }

  async getTwoFactorStatus(userId: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/two-factor`);
  }

  async enrollTwoFactor(userId: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/two-factor/enroll`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async enableTwoFactor(userId: string, code: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/two-factor/enable`, {
      method: "POST",
      body: JSON.stringify({ code })
    });
  }

  async disableTwoFactor(userId: string, code: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/two-factor/disable`, {
      method: "POST",
      body: JSON.stringify({ code })
    });
  }

  async regenerateRecoveryCodes(userId: string, code: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(
      `/api/v1/identity/users/${userId}/two-factor/recovery-codes`,
      {
        method: "POST",
        body: JSON.stringify({ code })
      }
    );
  }

  async getKycProfile(userId: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/kyc`);
  }

  async submitKycRequest(
    userId: string,
    command: { requestedTier: string; fullName: string; idNumber: string }
  ): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${userId}/kyc/requests`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listLoginEvents(
    userId: string,
    query: { limit?: number; offset?: number }
  ): Promise<Record<string, unknown>> {
    const search = new URLSearchParams();
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.offset !== undefined) search.set("offset", String(query.offset));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return this.fetchWithIdentityErrors(
      `/api/v1/identity/users/${encodeURIComponent(userId)}/login-events${suffix}`
    );
  }

  async listDevices(userId: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(`/api/v1/identity/users/${encodeURIComponent(userId)}/devices`);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<Record<string, unknown>> {
    return this.fetchWithIdentityErrors(
      `/api/v1/identity/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  /**
   * Same as fetchJson, but a 4xx from identity keeps identity's own error code
   * and message (e.g. TWO_FACTOR_INVALID_CODE) so the UI can map it.
   */
  private async fetchWithIdentityErrors<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await this.fetchJson<T>(path, init);
    } catch (error) {
      if (error instanceof ApiGatewayError && error.statusCode >= 400 && error.statusCode < 500) {
        const detail = parseUpstreamDetail(error.message);
        throw new ApiGatewayError(
          detail.code ?? error.code,
          error.statusCode,
          detail.message ?? error.message
        );
      }
      throw error;
    }
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
      throw await buildUpstreamError("IDENTITY_UPSTREAM_FAILED", response, "Identity service");
    }

    return (await response.json()) as T;
  }
}

async function buildUpstreamError(
  code: string,
  response: Response,
  source: string
): Promise<ApiGatewayError> {
  const payload = await response.text();
  return new ApiGatewayError(
    response.status >= 400 && response.status < 600 ? code : "UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `${source} rejected request: ${payload}`
  );
}

function parseUpstreamDetail(message: string): { code?: string; message?: string } {
  const start = message.indexOf("{");
  if (start < 0) {
    return {};
  }
  try {
    const payload = JSON.parse(message.slice(start)) as { code?: unknown; message?: unknown };
    return {
      code: typeof payload.code === "string" ? payload.code : undefined,
      message: typeof payload.message === "string" ? payload.message : undefined
    };
  } catch {
    return {};
  }
}
