import { ApiGatewayError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/** order-service `/api/v1/fee-tiers/users/:userId` (A7 VIP fee tiers). */
export class HttpFeeTierClient {
  constructor(private readonly baseUrl: string) {}

  async getUserProfile(userId: string): Promise<Record<string, unknown>> {
    const path = `/api/v1/fee-tiers/users/${encodeURIComponent(userId)}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: { "content-type": "application/json" }
      })
    });
    if (!response.ok) {
      throw new ApiGatewayError(
        "ORDER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Order service rejected request: ${await response.text()}`
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

/** What a customer may see of their own tier: no ops note / operator. */
export function toCustomerFeeTierView(profile: Record<string, unknown>): Record<string, unknown> {
  const { override, ...rest } = profile;
  const overrideRecord = override && typeof override === "object" ? (override as Record<string, unknown>) : null;
  return {
    ...rest,
    override: overrideRecord ? { tier: overrideRecord.tier, updatedAt: overrideRecord.updatedAt } : null
  };
}
