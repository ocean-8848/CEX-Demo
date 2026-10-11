import {
  listSpotMarkets,
  validateTradeExecutedEvent,
  type SpotMarket,
  type TradingEvent
} from "@web3-cex/domain";
import { createClient, type RedisClientType } from "redis";

import type {
  SettlementOrderEventClient,
  SettlementTradeEventStreamEntry,
  SettlementTradeEventStreamHead
} from "../domain/order-event-client.js";
import { SettlementServiceError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

interface RedisStreamMessageReply {
  id: string;
  message: Map<string, string> | Record<string, string>;
}

export function createSettlementRedisClient(url: string): RedisClientType {
  return createClient({
    url
  });
}

export class RedisOrderEventClient implements SettlementOrderEventClient {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly orderServiceBaseUrl: string,
    private readonly options: {
      streamPrefix?: string;
    } = {}
  ) {}

  async listTradeEventStreamEntries(query: {
    market: SpotMarket;
    afterStreamEntryId?: string;
    executionSequenceFrom?: number;
    limit?: number;
    overlapCount?: number;
  }): Promise<SettlementTradeEventStreamEntry[]> {
    const limit = normalizePositiveLimit(query.limit, 50);
    const overlapCount = Math.min(normalizeNonNegativeLimit(query.overlapCount, 0), limit);
    const streamKey = this.buildStreamKey(query.market);

    try {
      const overlapEntries =
        query.afterStreamEntryId && overlapCount > 0
          ? await this.redisClient.xRevRange(streamKey, query.afterStreamEntryId, "-", {
              COUNT: overlapCount
            })
          : [];
      const forwardEntries = await this.redisClient.xRange(
        streamKey,
        query.afterStreamEntryId ?? "-",
        "+",
        {
          COUNT: limit + overlapCount + (query.afterStreamEntryId ? 1 : 0)
        }
      );

      const combined = dedupeEntries([
        ...overlapEntries
          .slice()
          .reverse()
          .map((item) => this.mapStreamEntry(streamKey, item as RedisStreamMessageReply)),
        ...forwardEntries.map((item) => this.mapStreamEntry(streamKey, item as RedisStreamMessageReply))
      ]).filter((entry) => {
        if (query.afterStreamEntryId && overlapCount === 0) {
          return entry.streamEntryId !== query.afterStreamEntryId;
        }
        return true;
      });

      return filterByExecutionSequence(combined, query.executionSequenceFrom).slice(
        0,
        limit + overlapCount
      );
    } catch (error) {
      if (isMissingStreamError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getTradeEventStreamHead(
    market: SpotMarket
  ): Promise<SettlementTradeEventStreamHead | null> {
    const streamKey = this.buildStreamKey(market);

    try {
      const [latestEntries, streamInfo] = await Promise.all([
        this.redisClient.xRevRange(streamKey, "+", "-", {
          COUNT: 1
        }),
        this.redisClient.xInfoStream(streamKey)
      ]);
      const latest = latestEntries[0]
        ? this.mapStreamEntry(streamKey, latestEntries[0] as RedisStreamMessageReply)
        : undefined;

      return {
        market,
        streamKey,
        streamLength: Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
        latestStreamEntryId: latest?.streamEntryId,
        latestExecutionSequence: latest?.executionSequence,
        latestReplayCursor: latest?.replayCursor,
        latestPublishedAt: latest?.publishedAt
      };
    } catch (error) {
      if (isMissingStreamError(error)) {
        return {
          market,
          streamKey,
          streamLength: 0
        };
      }
      throw error;
    }
  }

  async acknowledgeTradeSettlement(command: {
    tradeId: string;
    settlementId: string;
  }): Promise<Record<string, unknown> | null> {
    const path = `/api/v1/trades/${command.tradeId}/settlement`;
    const body = JSON.stringify({
      settlementId: command.settlementId
    });
    const response = await fetch(`${this.orderServiceBaseUrl}${path}`, {
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

  private mapStreamEntry(
    streamKey: string,
    item: RedisStreamMessageReply
  ): SettlementTradeEventStreamEntry {
    const message = normalizeStreamMessage(item.message);
    if (typeof message.event !== "string") {
      throw new Error(`trade event stream entry ${item.id} is missing serialized event`);
    }

    const event = JSON.parse(message.event) as TradingEvent;
    const validated = validateTradeExecutedEvent(event);

    return {
      streamKey,
      streamEntryId: item.id,
      publishedAt: message.publishedAt,
      market: validated.trade.market as SpotMarket,
      executionSequence: validated.trade.executionSequence,
      replayCursor: validated.trade.replayCursor,
      protocolVersion: validated.protocolVersion,
      event: validated.event,
      ...(message.traceparent ? { traceparent: message.traceparent } : {})
    };
  }

  private buildStreamKey(market: SpotMarket): string {
    return `${this.streamPrefix}:${market.toLowerCase()}`;
  }

  private get streamPrefix(): string {
    return this.options.streamPrefix ?? "web3-cex:trade-events";
  }
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 500);
}

function normalizeNonNegativeLimit(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), 0), 500);
}

function dedupeEntries(
  entries: SettlementTradeEventStreamEntry[]
): SettlementTradeEventStreamEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.streamEntryId)) {
      return false;
    }
    seen.add(entry.streamEntryId);
    return true;
  });
}

function filterByExecutionSequence(
  entries: SettlementTradeEventStreamEntry[],
  executionSequenceFrom?: number
): SettlementTradeEventStreamEntry[] {
  if (executionSequenceFrom === undefined) {
    return entries;
  }

  return entries.filter((entry) => entry.executionSequence >= executionSequenceFrom);
}

function normalizeStreamMessage(
  message: Map<string, string> | Record<string, string>
): Record<string, string> {
  if (message instanceof Map) {
    return Object.fromEntries(message.entries());
  }

  return message;
}

function readLooseRecordValue(
  record: Record<string, unknown>,
  key: string
): unknown {
  if (key in record) {
    return record[key];
  }

  return record[key.replace(/-([a-z])/g, (_value, letter: string) => letter.toUpperCase())];
}

function isMissingStreamError(error: unknown): boolean {
  return error instanceof Error && /no such key/i.test(error.message);
}

async function buildError(response: Response): Promise<SettlementServiceError> {
  const payload = await response.text();
  return new SettlementServiceError(
    "ORDER_EVENT_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Order service rejected event request: ${payload}`
  );
}

export function resolveTradeEventStreamMarkets(market?: SpotMarket): SpotMarket[] {
  if (market) {
    return [market];
  }

  return listSpotMarkets({ includeDelisted: true });
}
