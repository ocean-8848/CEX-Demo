import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";

import { RedisOrderEventClient } from "../infrastructure/redis-order-event-client.js";

function createRedisClientStub(): RedisClientType {
  return {
    async xRevRange(_key: string, start: string) {
      if (start === "+") {
        return [
          {
            id: "1741591200000-2",
            message: {
              publishedAt: "2026-03-10T10:00:02.100Z",
              event: JSON.stringify(createTradeExecutedEvent("trade-2", 2))
            }
          }
        ];
      }

      return [
        {
          id: "1741591200000-1",
          message: {
            publishedAt: "2026-03-10T10:00:01.100Z",
            event: JSON.stringify(createTradeExecutedEvent("trade-1", 1))
          }
        }
      ];
    },
    async xRange() {
      return [
        {
          id: "1741591200000-1",
          message: {
            publishedAt: "2026-03-10T10:00:01.100Z",
            event: JSON.stringify(createTradeExecutedEvent("trade-1", 1))
          }
        },
        {
          id: "1741591200000-2",
          message: {
            publishedAt: "2026-03-10T10:00:02.100Z",
            event: JSON.stringify(createTradeExecutedEvent("trade-2", 2))
          }
        }
      ];
    },
    async xInfoStream() {
      return {
        length: 2
      };
    }
  } as unknown as RedisClientType;
}

function createTradeExecutedEvent(tradeId: string, executionSequence: number) {
  return {
    eventId: `event-${executionSequence.toString()}`,
    eventType: "trade.executed" as const,
    aggregateType: "spot_trade" as const,
    aggregateId: tradeId,
    traceId: `trace:${tradeId}`,
    occurredAt: `2026-03-10T10:00:0${executionSequence.toString()}.000Z`,
    schemaId: "trade.executed" as const,
    schemaVersion: 2,
    payload: {
      market: "BTC-USDT" as const,
      userIds: ["buyer-1", "seller-1"],
      trade: {
        tradeId,
        market: "BTC-USDT" as const,
        price: "65000",
        quantity: "0.01",
        makerOrderId: "sell-1",
        takerOrderId: "buy-1",
        buyerOrderId: "buy-1",
        sellerOrderId: "sell-1",
        buyerUserId: "buyer-1",
        sellerUserId: "seller-1",
        buyerAccountId: "acct-buyer-1",
        sellerAccountId: "acct-seller-1",
        sellerFeeRate: "0.001",
        executedAt: `2026-03-10T10:00:0${executionSequence.toString()}.000Z`,
        executionId: `exec-${executionSequence.toString()}`,
        executionBatchId: "BTC-USDT:batch-1",
        executionSequence,
        executionBatchSequence: executionSequence,
        replayCursor: `BTC-USDT:${executionSequence.toString()}`,
        protocolVersion: "v2"
      }
    }
  };
}

test("redis order event client reads stream entries with overlap", async () => {
  const client = new RedisOrderEventClient(
    createRedisClientStub(),
    "http://127.0.0.1:3009"
  );

  const entries = await client.listTradeEventStreamEntries({
    market: "BTC-USDT",
    afterStreamEntryId: "1741591200000-1",
    executionSequenceFrom: 1,
    limit: 10,
    overlapCount: 1
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.streamEntryId, "1741591200000-1");
  assert.equal(entries[1]?.executionSequence, 2);
  assert.equal(entries[1]?.replayCursor, "BTC-USDT:2");
});

test("redis order event client exposes latest stream head", async () => {
  const client = new RedisOrderEventClient(
    createRedisClientStub(),
    "http://127.0.0.1:3009"
  );

  const head = await client.getTradeEventStreamHead("BTC-USDT");

  assert.equal(head?.streamLength, 2);
  assert.equal(head?.latestStreamEntryId, "1741591200000-2");
  assert.equal(head?.latestExecutionSequence, 2);
  assert.equal(head?.latestReplayCursor, "BTC-USDT:2");
});
