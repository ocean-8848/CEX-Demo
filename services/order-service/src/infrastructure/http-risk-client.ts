import { OrderServiceError } from "../domain/errors.js";
import type { RiskOrderClient } from "../domain/clients.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpRiskClient implements RiskOrderClient {
  constructor(private readonly baseUrl: string) {}

  async validateSpotOrder(command: Parameters<RiskOrderClient["validateSpotOrder"]>[0]) {
    const path = "/api/v1/risk/orders/validate";
    const body = JSON.stringify(command);
    const response = await fetch(`${this.baseUrl}${path}`, {
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
    });

    if (!response.ok) {
      throw await buildError("RISK_UPSTREAM_FAILED", response, "Risk service");
    }

    return (await response.json()) as Awaited<ReturnType<RiskOrderClient["validateSpotOrder"]>>;
  }
}

async function buildError(code: string, response: Response, source: string): Promise<OrderServiceError> {
  const payload = await response.text();
  return new OrderServiceError(
    // Business rejections (MARKET_HALTED, PRICE_DEVIATION_TOO_HIGH, ...) keep
    // risk's own code so callers can tell them apart; transport failures stay generic.
    readRejectionCode(response.status, payload) ?? code,
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `${source} rejected request: ${payload}`
  );
}

function readRejectionCode(status: number, payload: string): string | undefined {
  if (status < 400 || status >= 500) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as { code?: unknown };
    return typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(parsed.code) && parsed.code !== "HTTP_EXCEPTION"
      ? parsed.code
      : undefined;
  } catch {
    return undefined;
  }
}
