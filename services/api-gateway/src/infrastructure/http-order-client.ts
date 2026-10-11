import { ApiGatewayError } from "../domain/errors.js";
import type {
  GatewayOrderRecord,
  GatewayTradeRecord,
  OrderGatewayClient
} from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpOrderClient implements OrderGatewayClient {
  constructor(private readonly baseUrl: string) {}

  async createOrder(command: {
    userId: string;
    accountId: string;
    market: string;
    side: "buy" | "sell";
    type: string;
    timeInForce?: string;
    price?: string;
    quantity: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<GatewayOrderRecord> {
    return this.fetchJson("/api/v1/orders", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async cancelOrder(command: { orderId: string; userId: string }): Promise<GatewayOrderRecord> {
    return this.fetchJson(`/api/v1/orders/${command.orderId}/cancel`, {
      method: "POST",
      body: JSON.stringify({
        userId: command.userId
      })
    });
  }

  async getOrder(orderId: string): Promise<GatewayOrderRecord> {
    return this.fetchJson(`/api/v1/orders/${orderId}`);
  }

  async listOrders(query: {
    userId: string;
    accountId?: string;
    market?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<GatewayOrderRecord[]> {
    return this.fetchJson(`/api/v1/orders?${toQuery(query)}`);
  }

  async listTrades(query: {
    userId: string;
    market?: string;
    orderId?: string;
    limit?: number;
    offset?: number;
  }): Promise<GatewayTradeRecord[]> {
    return this.fetchJson(`/api/v1/trades?${toQuery(query)}`);
  }

  async getTrade(tradeId: string): Promise<GatewayTradeRecord> {
    return this.fetchJson(`/api/v1/trades/${encodeURIComponent(tradeId)}`);
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
      throw await buildUpstreamError(response, "Order service");
    }

    return (await response.json()) as T;
  }
}

function toQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
}

async function buildUpstreamError(response: Response, source: string): Promise<ApiGatewayError> {
  const payload = await response.text();
  return new ApiGatewayError(
    "ORDER_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `${source} rejected request: ${payload}`
  );
}
