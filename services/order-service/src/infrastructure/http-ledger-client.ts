import { OrderServiceError } from "../domain/errors.js";
import type { LedgerOrderClient } from "../domain/clients.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpLedgerClient implements LedgerOrderClient {
  constructor(private readonly baseUrl: string) {}

  async freezeBalance(command: Parameters<LedgerOrderClient["freezeBalance"]>[0]) {
    return this.post("/api/v1/ledger/balances/freeze", command);
  }

  async releaseBalance(command: Parameters<LedgerOrderClient["releaseBalance"]>[0]) {
    return this.post("/api/v1/ledger/balances/release", command);
  }

  private async post(path: string, body: Record<string, unknown>) {
    const payload = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: payload,
        headers: {
          "content-type": "application/json"
        }
      }),
      body: payload
    });

    if (!response.ok) {
      throw await buildError(response);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

async function buildError(response: Response): Promise<OrderServiceError> {
  const payload = await response.text();
  return new OrderServiceError(
    "LEDGER_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Ledger service rejected request: ${payload}`
  );
}
