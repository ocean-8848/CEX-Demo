import { RiskServiceError } from "../domain/errors.js";
import type { SurveillanceActivity } from "../domain/surveillance.js";
import type {
  SurveillanceActivityClient,
  SurveillanceActivityQuery
} from "../domain/surveillance-repository.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/** Reads the surveillance activity window from order-service (internal HMAC). */
export class HttpOrderActivityClient implements SurveillanceActivityClient {
  constructor(private readonly baseUrl: string) {}

  async getActivity(query: SurveillanceActivityQuery): Promise<SurveillanceActivity> {
    const params = new URLSearchParams({
      since: query.since,
      until: query.until,
      orderMinNotional: query.orderMinNotional,
      orderMaxLifetimeMs: String(query.orderMaxLifetimeMs),
      tradeLimit: "10000",
      orderLimit: "2000"
    });
    if (query.orderExcludeUserIds.length > 0) {
      params.set("orderExcludeUserIds", query.orderExcludeUserIds.join(","));
    }
    const path = `/api/v1/surveillance/activity?${params.toString()}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: { "content-type": "application/json" }
      })
    });
    if (!response.ok) {
      throw new RiskServiceError(
        "ORDER_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `Order service rejected surveillance activity request: ${await response.text()}`
      );
    }
    return (await response.json()) as SurveillanceActivity;
  }
}
