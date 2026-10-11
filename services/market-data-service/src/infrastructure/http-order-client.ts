import type { SpotMarket } from "@web3-cex/domain";

import type {
  MarketDataOrderClient,
  MarketDataOrderRecord,
  MarketDataTrade
} from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpOrderClient implements MarketDataOrderClient {
  constructor(private readonly baseUrl: string) {}

  async listOrders(query: {
    market?: SpotMarket;
    limit?: number;
    offset?: number;
  }): Promise<MarketDataOrderRecord[]> {
    return this.fetchJson(`/api/v1/orders?${toQuery(query)}`);
  }

  async listTrades(query: {
    market?: SpotMarket;
    limit?: number;
    offset?: number;
  }): Promise<MarketDataTrade[]> {
    return this.fetchJson(`/api/v1/trades?${toQuery(query)}`);
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Order service rejected request ${path}: ${await response.text()}`);
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
