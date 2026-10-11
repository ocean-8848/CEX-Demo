import { WalletError } from "../domain/errors.js";
import type {
  IdentityClient,
  IdentityKycProfile,
  IdentityTwoFactorStatus,
  VerifyIdentityTwoFactorCommand
} from "../domain/identity-client.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

interface IdentityErrorResponse {
  code?: string;
  message?: string;
}

interface IdentityTwoFactorStatusResponse {
  userId: string;
  enabled: boolean;
  pendingEnrollment: boolean;
  enabledAt?: string;
  changedAt?: string;
}

interface IdentityTwoFactorVerificationResponse {
  verified: true;
  userId: string;
  verifiedAt: string;
  purpose?: string;
}

export class HttpIdentityClient implements IdentityClient {
  constructor(private readonly baseUrl: string) {}

  async getTwoFactorStatus(userId: string): Promise<IdentityTwoFactorStatus> {
    const path = `/api/v1/identity/users/${userId}/two-factor`;
    const response = await this.performRequest(
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
      },
      "fetch two-factor status"
    );

    if (!response.ok) {
      throw await mapIdentityError(response, "fetch two-factor status");
    }

    const payload = (await response.json()) as IdentityTwoFactorStatusResponse;
    return {
      userId: payload.userId,
      enabled: payload.enabled,
      pendingEnrollment: payload.pendingEnrollment,
      enabledAt: payload.enabledAt,
      changedAt: payload.changedAt
    };
  }

  async getKycProfile(userId: string): Promise<IdentityKycProfile> {
    const path = `/api/v1/identity/users/${userId}/kyc`;
    const response = await this.performRequest(
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
      },
      "fetch KYC profile"
    );

    if (!response.ok) {
      throw await mapIdentityError(response, "fetch KYC profile");
    }

    const payload = (await response.json()) as IdentityKycProfile;
    return {
      userId: payload.userId,
      tier: payload.tier,
      tierUpdatedAt: payload.tierUpdatedAt
    };
  }

  async verifyTwoFactor(command: VerifyIdentityTwoFactorCommand): Promise<{
    verifiedAt: string;
    purpose?: string;
  }> {
    const path = `/api/v1/identity/users/${command.userId}/two-factor/verify`;
    const body = JSON.stringify({
      code: command.code,
      purpose: command.purpose
    });
    const response = await this.performRequest(
      `${this.baseUrl}${path}`,
      {
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
      },
      "verify two-factor code"
    );

    if (!response.ok) {
      throw await mapIdentityError(response, "verify two-factor code");
    }

    const payload = (await response.json()) as IdentityTwoFactorVerificationResponse;
    return {
      verifiedAt: payload.verifiedAt,
      purpose: payload.purpose
    };
  }

  private async performRequest(
    input: string,
    init: RequestInit,
    action: string
  ): Promise<Response> {
    try {
      return await fetch(input, init);
    } catch (error) {
      throw new WalletError(
        "IDENTITY_SERVICE_FAILED",
        `Identity service failed to ${action}: ${error instanceof Error ? error.message : "network error"}`
      );
    }
  }
}

async function mapIdentityError(response: Response, action: string): Promise<WalletError> {
  const payload = await parseIdentityError(response);
  switch (payload.code) {
    case "USER_NOT_FOUND":
      return new WalletError(
        "IDENTITY_USER_NOT_FOUND",
        payload.message ?? "Identity user not found"
      );
    case "TWO_FACTOR_NOT_ENABLED":
    case "TWO_FACTOR_NOT_ENROLLED":
      return new WalletError(
        "WITHDRAWAL_2FA_NOT_ENABLED",
        payload.message ?? "Two-factor authentication is not enabled"
      );
    case "TWO_FACTOR_INVALID_CODE":
    case "TWO_FACTOR_CODE_REUSED":
      return new WalletError(
        "WITHDRAWAL_2FA_INVALID",
        payload.message ?? "Two-factor authentication code is invalid"
      );
    default:
      return new WalletError(
        "IDENTITY_SERVICE_FAILED",
        `Identity service failed to ${action}: ${payload.message ?? `HTTP ${response.status}`}`
      );
  }
}

async function parseIdentityError(response: Response): Promise<IdentityErrorResponse> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as IdentityErrorResponse;
  } catch {
    return {
      message: text
    };
  }
}
