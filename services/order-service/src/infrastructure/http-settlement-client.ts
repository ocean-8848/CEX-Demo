import { OrderServiceError } from "../domain/errors.js";
import type { SettlementOrderClient } from "../domain/clients.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpSettlementClient implements SettlementOrderClient {
  constructor(private readonly baseUrl: string) {}

  async settleTrade(command: Parameters<SettlementOrderClient["settleTrade"]>[0]) {
    const path = "/api/v1/settlement/trades/settle";
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
      throw await buildError(response);
    }

    return (await response.json()) as { settlementId: string };
  }
}

async function buildError(response: Response): Promise<OrderServiceError> {
  const payload = await response.text();
  return new OrderServiceError(
    "SETTLEMENT_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Settlement service rejected request: ${payload}`
  );
}
