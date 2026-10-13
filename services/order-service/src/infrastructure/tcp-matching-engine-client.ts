import net from "node:net";

import { SpanKind, withSpan } from "@web3-cex/telemetry";

import type { MatchingEngineClient } from "../domain/clients.js";
import { OrderServiceError } from "../domain/errors.js";
import type {
  MatchingBookSnapshot,
  MatchingBookSnapshotOrder,
  MatchingSubmitResult
} from "../domain/types.js";

interface MatchingEngineErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export class TcpMatchingEngineClient implements MatchingEngineClient {
  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  async submitOrder(command: Parameters<MatchingEngineClient["submitOrder"]>[0]): Promise<MatchingSubmitResult> {
    const response = await this.sendCommand({
      action: "submit",
      order_id: command.orderId,
      market: command.market,
      side: command.side,
      order_type: command.type,
      time_in_force: command.timeInForce,
      price: command.price,
      quantity: command.quantity,
      created_at: command.createdAt,
      // Optional fields: older engines ignore them, the engine defaults
      // stp_mode to expire_taker when an owner is present.
      ...(command.ownerId ? { owner_id: command.ownerId } : {}),
      ...(command.stpMode ? { stp_mode: command.stpMode } : {}),
      ...(command.postOnly ? { post_only: true } : {})
    });

    return {
      outcome: readString(response, "outcome") as MatchingSubmitResult["outcome"],
      orderId: readString(response, "orderId") ?? command.orderId,
      takerStatus: readString(response, "takerStatus") as MatchingSubmitResult["takerStatus"],
      takerRemainingQuantity: readString(response, "takerRemainingQuantity"),
      reason: readString(response, "reason"),
      protocolVersion: readString(response, "protocolVersion") ?? "v1",
      trades: toTrades(
        response.trades,
        command.orderId,
        command.market,
        readString(response, "protocolVersion") ?? "v1"
      ),
      expiredMakers: toExpiredMakers(response.expiredMakers)
    };
  }

  async seedOrder(command: Parameters<MatchingEngineClient["seedOrder"]>[0]) {
    const response = await this.sendCommand({
      action: "seed",
      order_id: command.orderId,
      market: command.market,
      side: command.side,
      price: command.price,
      quantity: command.quantity,
      created_at: command.createdAt,
      ...(command.ownerId ? { owner_id: command.ownerId } : {})
    });

    return {
      outcome: "seeded" as const,
      orderId: readString(response, "orderId") ?? command.orderId
    };
  }

  async cancelOrder(command: Parameters<MatchingEngineClient["cancelOrder"]>[0]) {
    const response = await this.sendCommand({
      action: "cancel",
      order_id: command.orderId,
      market: command.market
    });

    return {
      outcome: (readString(response, "outcome") as "cancelled" | "not_found") ?? "not_found",
      orderId: readString(response, "orderId") ?? command.orderId,
      cancelledQuantity: readString(response, "cancelledQuantity")
    };
  }

  async resetBook(command: Parameters<MatchingEngineClient["resetBook"]>[0]) {
    const response = await this.sendCommand({
      action: "reset",
      market: command.market,
      ...(command.resetSequences ? { reset_sequences: true } : {})
    });

    return {
      outcome: "reset" as const,
      market: (readString(response, "market") as typeof command.market) ?? command.market
    };
  }

  async getBookSnapshot(command: Parameters<MatchingEngineClient["getBookSnapshot"]>[0]): Promise<MatchingBookSnapshot> {
    const response = await this.sendCommand({
      action: "snapshot",
      market: command.market,
      limit: command.limit
    });

    return {
      market: (readString(response, "market") as MatchingBookSnapshot["market"]) ?? command.market,
      bids: toSnapshotOrders(response.bids),
      asks: toSnapshotOrders(response.asks),
      nextExecutionSequence: readNumber(response, "nextExecutionSequence"),
      nextBatchSequence: readNumber(response, "nextBatchSequence")
    };
  }

  async restoreSequences(command: {
    market: MatchingBookSnapshot["market"];
    nextExecutionSequence: number;
    nextBatchSequence: number;
  }) {
    const response = await this.sendCommand({
      action: "restore",
      market: command.market,
      next_execution_sequence: command.nextExecutionSequence,
      next_batch_sequence: command.nextBatchSequence
    });

    return {
      nextExecutionSequence: readNumber(response, "nextExecutionSequence") ?? command.nextExecutionSequence,
      nextBatchSequence: readNumber(response, "nextBatchSequence") ?? command.nextBatchSequence
    };
  }

  /** One client span per engine command (the TCP protocol is invisible to auto-instrumentation). */
  private async sendCommand(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = typeof payload.action === "string" ? payload.action : "unknown";
    return withSpan(
      `matching-engine ${action}`,
      {
        "rpc.system": "web3-cex-matching-tcp",
        "rpc.method": action,
        "server.address": this.host,
        "server.port": this.port,
        market: typeof payload.market === "string" ? payload.market : "",
        action
      },
      async (span) => {
        try {
          const response = await this.sendCommandOverTcp(payload);
          span.setAttribute("outcome", readString(response, "outcome") ?? "ok");
          return response;
        } catch (error) {
          span.setAttribute(
            "outcome",
            error instanceof OrderServiceError ? `error:${error.code}` : "error"
          );
          throw error;
        }
      },
      { kind: SpanKind.CLIENT }
    );
  }

  private async sendCommandOverTcp(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(
        {
          host: this.host,
          port: this.port
        },
        () => {
          socket.write(`${JSON.stringify(payload)}\n`);
        }
      );

      let data = "";
      socket.setEncoding("utf8");

      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.end();
          resolve(data.trim());
        }
      });
      socket.on("error", (error) => {
        reject(
          new OrderServiceError(
            "MATCHING_ENGINE_UNAVAILABLE",
            502,
            `Matching engine connection failed: ${error.message}`
          )
        );
      });
      socket.on("end", () => {
        if (!data.trim()) {
          reject(
            new OrderServiceError(
              "MATCHING_ENGINE_EMPTY_RESPONSE",
              502,
              "Matching engine returned an empty response"
            )
          );
        }
      });
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response) as unknown;
    } catch (error) {
      throw new OrderServiceError(
        "MATCHING_ENGINE_PROTOCOL_ERROR",
        502,
        `Matching engine returned invalid JSON: ${readErrorMessage(error)}`
      );
    }

    if (!isRecord(parsed)) {
      throw new OrderServiceError(
        "MATCHING_ENGINE_PROTOCOL_ERROR",
        502,
        "Matching engine returned a non-object payload"
      );
    }

    const errorPayload = parsed as MatchingEngineErrorPayload;
    if (errorPayload.error) {
      throw new OrderServiceError(
        errorPayload.error.code ?? "MATCHING_ENGINE_ERROR",
        502,
        errorPayload.error.message ?? "Matching engine rejected request"
      );
    }

    return parsed;
  }
}

function toSnapshotOrders(value: unknown): MatchingBookSnapshotOrder[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      orderId: readString(item, "orderId") ?? "",
      side: (readString(item, "side") as "buy" | "sell") ?? "buy",
      price: readString(item, "price") ?? "0",
      quantity: readString(item, "quantity") ?? "0",
      createdAt: readString(item, "createdAt") ?? new Date().toISOString(),
      ownerId: readString(item, "ownerId")
    }))
    .filter((item) => item.orderId.length > 0);
}

function toExpiredMakers(value: unknown): MatchingSubmitResult["expiredMakers"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const expired = value
    .filter(isRecord)
    .map((item) => ({
      orderId: readString(item, "orderId") ?? "",
      quantity: readString(item, "quantity") ?? "0",
      reason: readString(item, "reason") ?? "stp_expired_maker"
    }))
    .filter((item) => item.orderId.length > 0);
  return expired.length > 0 ? expired : undefined;
}

function toTrades(
  value: unknown,
  takerOrderId: string,
  market: string,
  protocolVersion: string
): MatchingSubmitResult["trades"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => {
      const executionBatchId =
        readString(item, "executionBatchId") ?? `${market}:${takerOrderId}:batch`;
      const executionSequence = readNumber(item, "executionSequence") ?? index + 1;
      const executionBatchSequence = readNumber(item, "executionBatchSequence") ?? index + 1;

      return {
        makerOrderId: readString(item, "makerOrderId") ?? "",
        takerOrderId: readString(item, "takerOrderId") ?? takerOrderId,
        price: readString(item, "price") ?? "",
        quantity: readString(item, "quantity") ?? "",
        executedAt: readString(item, "executedAt") ?? new Date().toISOString(),
        executionId:
          readString(item, "executionId") ??
          `${executionBatchId}:${executionBatchSequence.toString()}`,
        executionBatchId,
        executionSequence,
        executionBatchSequence,
        replayCursor:
          readString(item, "replayCursor") ?? `${market}:${executionSequence.toString()}`,
        protocolVersion: readString(item, "protocolVersion") ?? protocolVersion,
        makerCreatedAt: readString(item, "makerCreatedAt"),
        takerCreatedAt: readString(item, "takerCreatedAt"),
        makerRemainingQuantity: readString(item, "makerRemainingQuantity") ?? "0"
      };
    })
    .filter((item) => item.makerOrderId.length > 0 && item.quantity.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown matching engine error";
}
