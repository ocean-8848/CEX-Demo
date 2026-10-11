import type { SpotMarket } from "@web3-cex/domain";

import type {
  SettlementOrderEventClient,
  SettlementTradeEventStreamEntry,
  SettlementTradeEventStreamHead
} from "../domain/order-event-client.js";
import { SettlementServiceError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpOrderEventClient implements SettlementOrderEventClient {
  constructor(private readonly baseUrl: string) {}

  async listTradeEventStreamEntries(query: {
    market: SpotMarket;
    afterStreamEntryId?: string;
    executionSequenceFrom?: number;
    limit?: number;
    overlapCount?: number;
  }): Promise<SettlementTradeEventStreamEntry[]> {
    const path = `/api/v1/orders/ops/event-bus/streams/events?${toQuery(
      query as Record<string, unknown>
    )}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );
    if (!response.ok) {
      throw await buildError(response);
    }

    return (await response.json()) as SettlementTradeEventStreamEntry[];
  }

  async getTradeEventStreamHead(
    market: SpotMarket
  ): Promise<SettlementTradeEventStreamHead | null> {
    const path = "/api/v1/orders/ops/event-bus";
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
      throw await buildError(response);
    }

    const payload = (await response.json()) as {
      stream?: { heads?: SettlementTradeEventStreamHead[] };
    };
    return payload.stream?.heads?.find((item) => item.market === market) ?? null;
  }

  async acknowledgeTradeSettlement(command: {
    tradeId: string;
    settlementId: string;
  }): Promise<Record<string, unknown> | null> {
    const path = `/api/v1/trades/${command.tradeId}/settlement`;
    const body = JSON.stringify({
      settlementId: command.settlementId
    });
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

    return (await response.json()) as Record<string, unknown> | null;
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

async function buildError(response: Response): Promise<SettlementServiceError> {
  const payload = await response.text();
  return new SettlementServiceError(
    "ORDER_EVENT_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Order service rejected event request: ${payload}`
  );
}
