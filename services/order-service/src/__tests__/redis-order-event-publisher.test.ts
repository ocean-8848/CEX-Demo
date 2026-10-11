import assert from "node:assert/strict";
import test from "node:test";
import type { TradingEvent } from "@web3-cex/domain";

import { RedisOrderEventPublisher } from "../infrastructure/redis-order-event-publisher.js";

class FakeRedisClient {
  readonly published: Array<{ channel: string; payload: string }> = [];
  readonly streams = new Map<
    string,
    Array<{
      id: string;
      message: Record<string, string>;
    }>
  >();
  private sequence = 0;

  async publish(channel: string, payload: string) {
    this.published.push({
      channel,
      payload
    });
    return 1;
  }

  async xAdd(
    key: string,
    _id: string,
    message: Record<string, string>,
    options?: { TRIM?: { threshold?: number } }
  ) {
    const nextId = `1741591200000-${(++this.sequence).toString()}`;
    const entries = this.streams.get(key) ?? [];
    entries.push({
      id: nextId,
      message
    });
    const threshold = options?.TRIM?.threshold ?? entries.length;
    this.streams.set(key, entries.slice(-threshold));
    return nextId;
  }

  async xRange(key: string, start: string, end: string, options?: { COUNT?: number }) {
    const items = [...(this.streams.get(key) ?? [])].filter((item) => {
      return compareIds(item.id, start) >= 0 && compareIds(item.id, end) <= 0;
    });
    return items.slice(0, options?.COUNT ?? items.length);
  }

  async xRevRange(key: string, start: string, end: string, options?: { COUNT?: number }) {
    const items = [...(this.streams.get(key) ?? [])]
      .reverse()
      .filter((item) => compareIds(item.id, start) <= 0 && compareIds(item.id, end) >= 0);
    return items.slice(0, options?.COUNT ?? items.length);
  }

  async xInfoStream(key: string) {
    const items = this.streams.get(key);
    if (!items || items.length === 0) {
      throw new Error("ERR no such key");
    }

    return {
      length: items.length
    };
  }

  async sendCommand(args: string[]) {
    const [command, key, strategy, ...rest] = args;
    assert.equal(command, "XTRIM");
    if (typeof key !== "string") {
      throw new Error("stream key is required");
    }
    const streamKey: string = key;
    const threshold = rest.at(-1);
    const items = [...(this.streams.get(streamKey) ?? [])];
    if (strategy === "MAXLEN") {
      const maxLen = Number(threshold);
      const trimmed = Math.max(items.length - maxLen, 0);
      this.streams.set(streamKey, items.slice(-maxLen));
      return trimmed;
    }

    if (strategy === "MINID") {
      const retained = items.filter((item) => compareIds(item.id, threshold) >= 0);
      const trimmed = items.length - retained.length;
      this.streams.set(streamKey, retained);
      return trimmed;
    }

    throw new Error(`unsupported command ${args.join(" ")}`);
  }
}

function createTradeExecutedEvent(sequence: number): TradingEvent {
  return {
    eventId: `exec-${sequence.toString()}`,
    eventType: "trade.executed",
    aggregateType: "spot_trade",
    aggregateId: `trade-${sequence.toString()}`,
    traceId: `execution:${sequence.toString()}`,
    occurredAt: `2026-03-10T10:00:0${sequence.toString()}.000Z`,
    schemaId: "trade.executed",
    schemaVersion: 2,
    payload: {
      market: "BTC-USDT",
      userIds: ["buyer-1", "seller-1"],
      trade: {
        tradeId: `trade-${sequence.toString()}`,
        market: "BTC-USDT",
        price: "65000",
        quantity: "0.01",
        makerOrderId: "sell-1",
        takerOrderId: "buy-1",
        buyerOrderId: "buy-1",
        sellerOrderId: "sell-1",
        buyerUserId: "buyer-1",
        sellerUserId: "seller-1",
        buyerAccountId: "acct-buyer",
        sellerAccountId: "acct-seller",
        sellerFeeRate: "0.001",
        executedAt: `2026-03-10T10:00:0${sequence.toString()}.000Z`,
        executionId: `exec-${sequence.toString()}`,
        executionBatchId: "BTC-USDT:batch-1",
        executionSequence: sequence,
        executionBatchSequence: sequence,
        replayCursor: `BTC-USDT:${sequence.toString()}`,
        protocolVersion: "v2"
      }
    }
  };
}

test("redis publisher stores trade.executed in stream and reports stream head", async () => {
  const redisClient = new FakeRedisClient();
  const publisher = new RedisOrderEventPublisher(
    redisClient as never,
    "web3-cex:trading.events",
    {
      streamPrefix: "web3-cex:trade-events",
      streamMaxLen: 10,
      now: () => new Date("2026-03-10T10:00:00.100Z")
    }
  );

  await publisher.publish([createTradeExecutedEvent(1), createTradeExecutedEvent(2)]);
  const report = await publisher.getReport?.({
    market: "BTC-USDT"
  });
  const entries = await publisher.listStreamEntries?.({
    market: "BTC-USDT",
    direction: "backward",
    limit: 2
  });

  assert.equal(redisClient.published.length, 2);
  assert.equal(report?.stream.heads[0]?.latestExecutionSequence, 2);
  assert.equal(report?.stream.heads[0]?.oldestExecutionSequence, 1);
  assert.equal(report?.stream.heads[0]?.latestStreamEntryId, "1741591200000-2");
  assert.equal(report?.stream.archive?.enabled, true);
  assert.equal(report?.stream.archive?.heads[0]?.streamLength ?? 0, 0);
  assert.equal(entries?.[0]?.executionSequence, 2);
  assert.equal(entries?.[1]?.executionSequence, 1);
});

test("redis publisher can replay stream entries back to pubsub channel", async () => {
  const redisClient = new FakeRedisClient();
  const publisher = new RedisOrderEventPublisher(
    redisClient as never,
    "web3-cex:trading.events",
    {
      streamPrefix: "web3-cex:trade-events",
      streamMaxLen: 10,
      now: () => new Date("2026-03-10T10:00:00.100Z")
    }
  );

  await publisher.publish([createTradeExecutedEvent(1), createTradeExecutedEvent(2)]);
  const replay = await publisher.replayStreamEntries?.({
    market: "BTC-USDT",
    fromStreamEntryId: "1741591200000-1",
    toStreamEntryId: "1741591200000-2",
    limit: 2,
    publishToChannel: true
  });

  assert.equal(replay?.replayedCount, 2);
  assert.equal(redisClient.published.length, 4);
  assert.equal(replay?.entries[0]?.executionSequence, 1);
  assert.equal(replay?.entries[1]?.executionSequence, 2);
});

test("redis publisher can trim stream entries by retention policy", async () => {
  const redisClient = new FakeRedisClient();
  const publisher = new RedisOrderEventPublisher(
    redisClient as never,
    "web3-cex:trading.events",
    {
      streamPrefix: "web3-cex:trade-events",
      streamMaxLen: 10,
      streamRetentionMs: 60_000,
      now: () => new Date("2026-03-10T10:02:00.000Z")
    }
  );

  await publisher.publish([createTradeExecutedEvent(1), createTradeExecutedEvent(2)]);
  const trimmed = await publisher.trimStreamEntries?.({
    market: "BTC-USDT",
    strategy: "minid",
    minStreamEntryId: "1741591200000-2"
  });

  assert.equal(trimmed?.trims[0]?.afterLength, 1);

  const report = await publisher.getReport?.({
    market: "BTC-USDT"
  });
  assert.equal(report?.stream.heads[0]?.oldestExecutionSequence, 2);
});

test("redis publisher maintenance trims idle streams under retention pressure", async () => {
  const redisClient = new FakeRedisClient();
  let now = new Date("2026-03-10T10:00:00.000Z");
  const publisher = new RedisOrderEventPublisher(
    redisClient as never,
    "web3-cex:trading.events",
    {
      streamPrefix: "web3-cex:trade-events",
      streamMaxLen: 10,
      streamRetentionMs: 60_000,
      streamTrimCooldownMs: 1_000,
      now: () => now
    }
  );

  await publisher.publish([createTradeExecutedEvent(1), createTradeExecutedEvent(2)]);
  now = new Date("2026-03-10T10:02:00.000Z");

  const maintenance = await publisher.maintainStreamEntries?.({
    market: "BTC-USDT"
  });

  assert.equal(maintenance?.markets[0]?.reason, "trimmed");
  assert.equal(maintenance?.markets[0]?.retentionPressure, true);
  assert.equal((maintenance?.markets[0]?.archive?.archivedCount ?? 0) >= 1, true);
  assert.equal((maintenance?.markets[0]?.trim?.trims[0]?.trimmedCount ?? 0) >= 1, true);
  assert.equal((maintenance?.markets[0]?.head.streamLength ?? 0) < 2, true);

  const report = await publisher.getReport?.({
    market: "BTC-USDT"
  });
  assert.equal((report?.stream.archive?.heads[0]?.streamLength ?? 0) >= 1, true);
});

function compareIds(left: string | undefined, right: string | undefined): number {
  const normalizedLeft =
    left === undefined || left === "-" ? "0-0" : left === "+" ? "9999999999999-999999" : left;
  const normalizedRight =
    right === undefined || right === "-"
      ? "0-0"
      : right === "+"
        ? "9999999999999-999999"
        : right;
  const [leftMillis = 0, leftSeq = 0] = normalizedLeft.split("-").map(Number);
  const [rightMillis = 0, rightSeq = 0] = normalizedRight.split("-").map(Number);
  if (leftMillis !== rightMillis) {
    return leftMillis - rightMillis;
  }
  return leftSeq - rightSeq;
}
