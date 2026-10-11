import {
  listSpotMarkets,
  validateTradeExecutedEvent,
  type SpotMarket,
  type TradingEvent
} from "@web3-cex/domain";
import { injectTraceContext, SpanKind, withSpan } from "@web3-cex/telemetry";
import type { RedisClientType } from "redis";

import type {
  MaintainOrderTradeEventStreamCommand,
  OrderTradeEventArchiveHead,
  OrderEventPublisher,
  OrderEventPublisherReport,
  OrderTradeEventStreamEntry,
  OrderTradeEventStreamHead,
  OrderTradeEventStreamQuery,
  ReplayOrderTradeEventStreamCommand,
  TrimOrderTradeEventStreamCommand
} from "../domain/event-publisher.js";

interface RedisStreamMessageReply {
  id: string;
  message: Map<string, string> | Record<string, string>;
}

export class RedisOrderEventPublisher implements OrderEventPublisher {
  private readonly lastTrimAtByStream = new Map<string, number>();

  constructor(
    private readonly redisClient: RedisClientType,
    private readonly channel: string,
    private readonly options: {
      mode?: string;
      streamPrefix?: string;
      streamMaxLen?: number;
      streamRetentionMs?: number;
      streamTrimCooldownMs?: number;
      streamPressureWarningRatio?: number;
      archivePrefix?: string;
      archiveMaxLen?: number;
      archiveEnabled?: boolean;
      autoTrim?: boolean;
      now?: () => Date;
    } = {}
  ) {}

  async publish(events: TradingEvent[]): Promise<void> {
    for (const event of events) {
      if (event.eventType === "trade.executed") {
        const validated = validateTradeExecutedEvent(event);
        const streamKey = this.buildStreamKey(validated.trade.market as SpotMarket);
        await withSpan(
          `${streamKey} publish`,
          {
            "messaging.system": "redis_stream",
            "messaging.operation.type": "publish",
            "messaging.destination.name": streamKey,
            market: validated.trade.market,
            "trade.id": validated.trade.tradeId,
            "trade.execution_sequence": validated.trade.executionSequence
          },
          async (span) => {
            const streamEntryId = await this.redisClient.xAdd(
              streamKey,
              "*",
              {
                eventType: validated.event.eventType,
                market: validated.trade.market,
                executionSequence: String(validated.trade.executionSequence),
                replayCursor: validated.trade.replayCursor,
                protocolVersion: validated.protocolVersion,
                publishedAt: this.now().toISOString(),
                event: JSON.stringify(validated.event),
                // W3C trace context travels as extra stream fields (empty when
                // tracing is off) so the event payload itself stays unchanged.
                ...injectTraceContext()
              },
              {
                TRIM: {
                  strategy: "MAXLEN",
                  strategyModifier: "~",
                  threshold: this.streamMaxLen
                }
              }
            );
            span.setAttribute("messaging.message.id", String(streamEntryId));
          },
          { kind: SpanKind.PRODUCER }
        );

        await this.maybeAutoTrimStream(validated.trade.market as SpotMarket);
      }

      await this.redisClient.publish(this.channel, JSON.stringify(event));
    }
  }

  async getReport(
    query: {
      market?: SpotMarket;
      limit?: number;
    } = {}
  ): Promise<OrderEventPublisherReport> {
    const allMarkets = resolveMarkets(query.market);
    const heads: OrderTradeEventStreamHead[] = [];
    const archiveHeads: OrderTradeEventArchiveHead[] = [];

    for (const market of allMarkets.slice(
      0,
      normalizePositiveLimit(query.limit, allMarkets.length)
    )) {
      heads.push(await this.getStreamHead(market));
      if (this.archiveEnabled) {
        archiveHeads.push(await this.getArchiveHead(market));
      }
    }

    return {
      mode: this.options.mode ?? "redis_stream",
      enabled: true,
      channel: this.channel,
      stream: {
        enabled: true,
        prefix: this.streamPrefix,
        maxLen: this.streamMaxLen,
        retentionMs: this.streamRetentionMs,
        autoTrimEnabled: this.autoTrimEnabled,
        trimCooldownMs: this.streamTrimCooldownMs,
        pressureWarningRatio: this.streamPressureWarningRatio,
        heads,
        archive: {
          enabled: this.archiveEnabled,
          prefix: this.archivePrefix,
          maxLen: this.archiveMaxLen,
          heads: archiveHeads
        }
      }
    };
  }

  async listStreamEntries(
    query: OrderTradeEventStreamQuery
  ): Promise<OrderTradeEventStreamEntry[]> {
    const limit = normalizePositiveLimit(query.limit, 50);
    const overlapCount = Math.min(normalizeNonNegativeLimit(query.overlapCount, 0), limit);
    const streamKey = this.buildStreamKey(query.market);

    try {
      if (query.direction === "backward") {
        const reversed = await this.redisClient.xRevRange(
          streamKey,
          query.toStreamEntryId ?? "+",
          query.fromStreamEntryId ?? "-",
          {
            COUNT: limit
          }
        );

        return filterByExecutionSequence(
          reversed.map((item) => this.mapStreamEntry(streamKey, item as RedisStreamMessageReply)),
          query.executionSequenceFrom
        );
      }

      const overlapEntries =
        query.afterStreamEntryId && overlapCount > 0
          ? await this.redisClient.xRevRange(
              streamKey,
              query.afterStreamEntryId,
              "-",
              {
                COUNT: overlapCount
              }
            )
          : [];
      const forwardEntries = await this.redisClient.xRange(
        streamKey,
        query.afterStreamEntryId ?? query.fromStreamEntryId ?? "-",
        query.toStreamEntryId ?? "+",
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

  async replayStreamEntries(
    command: ReplayOrderTradeEventStreamCommand
  ): Promise<{
    market: SpotMarket;
    replayedCount: number;
    publishToChannel: boolean;
    entries: OrderTradeEventStreamEntry[];
  }> {
    const entries = await this.listStreamEntries({
      ...command,
      overlapCount: 0
    });
    const publishToChannel = command.publishToChannel !== false;

    if (publishToChannel) {
      for (const entry of entries) {
        await this.redisClient.publish(this.channel, JSON.stringify(entry.event));
      }
    }

    return {
      market: command.market,
      replayedCount: entries.length,
      publishToChannel,
      entries
    };
  }

  async trimStreamEntries(
    command: TrimOrderTradeEventStreamCommand
  ): Promise<{
    strategy: "auto" | "maxlen" | "minid";
    dryRun: boolean;
    trims: Array<{
      market: SpotMarket;
      streamKey: string;
      beforeLength: number;
      afterLength: number;
      trimmedCount: number;
      appliedMaxLen?: number;
      appliedMinStreamEntryId?: string;
      oldestRemainingStreamEntryId?: string;
      latestStreamEntryId?: string;
    }>;
  }> {
    const strategy = command.strategy ?? "auto";
    const markets = resolveMarkets(command.market).slice(
      0,
      normalizePositiveLimit(command.limit, resolveMarkets(command.market).length)
    );
    const trims = [];

    for (const market of markets) {
      const streamKey = this.buildStreamKey(market);
      const before = await this.getStreamHead(market);
      const appliedMaxLen =
        strategy === "auto" || strategy === "maxlen"
          ? Math.max(Math.trunc(command.maxLen ?? this.streamMaxLen), 1)
          : undefined;
      const appliedMinStreamEntryId =
        strategy === "auto" || strategy === "minid"
          ? resolveMinStreamEntryId(
              command.minStreamEntryId,
              command.retentionMs ?? this.streamRetentionMs,
              this.now()
            )
          : undefined;

      let trimmedCount = 0;
      if (!command.dryRun) {
        if (appliedMaxLen !== undefined) {
          trimmedCount += await this.xTrim(streamKey, ["MAXLEN", "~", String(appliedMaxLen)]);
        }
        if (appliedMinStreamEntryId) {
          trimmedCount += await this.xTrim(streamKey, [
            "MINID",
            "~",
            appliedMinStreamEntryId
          ]);
        }
        this.lastTrimAtByStream.set(streamKey, this.now().getTime());
      }

      const after = command.dryRun ? before : await this.getStreamHead(market);

      trims.push({
        market,
        streamKey,
        beforeLength: before.streamLength,
        afterLength: after.streamLength,
        trimmedCount:
          trimmedCount > 0 ? trimmedCount : Math.max(before.streamLength - after.streamLength, 0),
        appliedMaxLen,
        appliedMinStreamEntryId,
        oldestRemainingStreamEntryId: after.oldestStreamEntryId,
        latestStreamEntryId: after.latestStreamEntryId
      });
    }

    return {
      strategy,
      dryRun: command.dryRun === true,
      trims
    };
  }

  async maintainStreamEntries(
    command: MaintainOrderTradeEventStreamCommand = {}
  ): Promise<{
    dryRun: boolean;
    force: boolean;
    cycleStartedAt: string;
    cycleCompletedAt: string;
    pressureWarningRatio: number;
    markets: Array<{
      market: SpotMarket;
      streamKey: string;
      retentionPressure: boolean;
      reason:
        | "trimmed"
        | "dry_run"
        | "force"
        | "no_pressure"
        | "trim_cooldown";
      cooldownRemainingMs?: number;
      head: OrderTradeEventStreamHead;
      archive?: {
        enabled: boolean;
        archivedCount: number;
        archiveStreamKey?: string;
        oldestArchivedSourceStreamEntryId?: string;
        latestArchivedSourceStreamEntryId?: string;
      };
      trim?: {
        strategy: "auto" | "maxlen" | "minid";
        dryRun: boolean;
        trims: Array<{
          market: SpotMarket;
          streamKey: string;
          beforeLength: number;
          afterLength: number;
          trimmedCount: number;
          appliedMaxLen?: number;
          appliedMinStreamEntryId?: string;
          oldestRemainingStreamEntryId?: string;
          latestStreamEntryId?: string;
        }>;
      };
    }>;
  }> {
    const cycleStartedAt = this.now();
    const dryRun = command.dryRun === true;
    const force = command.force === true;
    const markets = resolveMarkets(command.market).slice(
      0,
      normalizePositiveLimit(command.limit, resolveMarkets(command.market).length)
    );
    const summaries = [];

    for (const market of markets) {
      const head = await this.getStreamHead(market);
      const streamKey = head.streamKey;
      const now = this.now().getTime();
      const lastTrimAt = this.lastTrimAtByStream.get(streamKey) ?? 0;
      const cooldownRemainingMs = Math.max(this.streamTrimCooldownMs - (now - lastTrimAt), 0);
      const archiveBeforeTrim = this.shouldArchiveHead(head);
      const retentionPressure = isRetentionPressure(
        head,
        this.streamMaxLen,
        this.streamRetentionMs,
        this.streamPressureWarningRatio
      );

      if (!force && !retentionPressure) {
        summaries.push({
          market,
          streamKey,
          retentionPressure,
          reason: "no_pressure" as const,
          head
        });
        continue;
      }

      if (!dryRun && !force && cooldownRemainingMs > 0) {
        summaries.push({
          market,
          streamKey,
          retentionPressure,
          reason: "trim_cooldown" as const,
          cooldownRemainingMs,
          head
        });
        continue;
      }

      const archive =
        this.archiveEnabled && archiveBeforeTrim
          ? await this.archiveTrimCandidates({
              market,
              head,
              dryRun
            })
          : undefined;

      const trim = await this.trimStreamEntries({
        market,
        strategy: "auto",
        dryRun
      });

      summaries.push({
        market,
        streamKey,
        retentionPressure,
        reason: dryRun ? ("dry_run" as const) : force ? ("force" as const) : ("trimmed" as const),
        cooldownRemainingMs: cooldownRemainingMs > 0 ? cooldownRemainingMs : undefined,
        head: dryRun ? head : await this.getStreamHead(market),
        archive,
        trim
      });
    }

    const cycleCompletedAt = this.now();
    return {
      dryRun,
      force,
      cycleStartedAt: cycleStartedAt.toISOString(),
      cycleCompletedAt: cycleCompletedAt.toISOString(),
      pressureWarningRatio: this.streamPressureWarningRatio,
      markets: summaries
    };
  }

  private async getStreamHead(market: SpotMarket): Promise<OrderTradeEventStreamHead> {
    const streamKey = this.buildStreamKey(market);

    try {
      const [latestEntries, oldestEntries, streamInfo] = await Promise.all([
        this.redisClient.xRevRange(streamKey, "+", "-", {
          COUNT: 1
        }),
        this.redisClient.xRange(streamKey, "-", "+", {
          COUNT: 1
        }),
        this.redisClient.xInfoStream(streamKey)
      ]);
      const latest = latestEntries[0]
        ? this.mapStreamEntry(streamKey, latestEntries[0] as RedisStreamMessageReply)
        : undefined;
      const oldest = oldestEntries[0]
        ? this.mapStreamEntry(streamKey, oldestEntries[0] as RedisStreamMessageReply)
        : undefined;

      return {
        market,
        streamKey,
        streamLength: Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
        oldestStreamEntryId: oldest?.streamEntryId,
        oldestExecutionSequence: oldest?.executionSequence,
        oldestReplayCursor: oldest?.replayCursor,
        oldestPublishedAt: oldest?.publishedAt,
        latestStreamEntryId: latest?.streamEntryId,
        latestExecutionSequence: latest?.executionSequence,
        latestReplayCursor: latest?.replayCursor,
        latestPublishedAt: latest?.publishedAt,
        replayWindowMs: calculateReplayWindowMs(oldest?.publishedAt, latest?.publishedAt),
        oldestEntryAgeMs: calculateAgeMs(oldest?.publishedAt, this.now()),
        maxLenPressureRatio: calculatePressureRatio(
          Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
          this.streamMaxLen
        ),
        retentionPressureRatio: calculatePressureRatio(
          calculateAgeMs(oldest?.publishedAt, this.now()),
          this.streamRetentionMs
        ),
        retentionPressure: isRetentionPressure(
          {
            streamLength: Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
            oldestEntryAgeMs: calculateAgeMs(oldest?.publishedAt, this.now())
          },
          this.streamMaxLen,
          this.streamRetentionMs,
          this.streamPressureWarningRatio
        ),
        recommendedAction: isRetentionPressure(
          {
            streamLength: Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
            oldestEntryAgeMs: calculateAgeMs(oldest?.publishedAt, this.now())
          },
          this.streamMaxLen,
          this.streamRetentionMs,
          this.streamPressureWarningRatio
        )
          ? "trim"
          : "observe"
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

  private async getArchiveHead(market: SpotMarket): Promise<OrderTradeEventArchiveHead> {
    const streamKey = this.buildArchiveStreamKey(market);

    try {
      const [latestEntries, oldestEntries, streamInfo] = await Promise.all([
        this.redisClient.xRevRange(streamKey, "+", "-", {
          COUNT: 1
        }),
        this.redisClient.xRange(streamKey, "-", "+", {
          COUNT: 1
        }),
        this.redisClient.xInfoStream(streamKey)
      ]);
      const latest = latestEntries[0]
        ? normalizeStreamMessage((latestEntries[0] as RedisStreamMessageReply).message)
        : undefined;
      const oldest = oldestEntries[0]
        ? normalizeStreamMessage((oldestEntries[0] as RedisStreamMessageReply).message)
        : undefined;

      return {
        market,
        streamKey,
        streamLength: Number(readLooseRecordValue(streamInfo as Record<string, unknown>, "length") ?? 0),
        oldestArchivedAt: oldest?.archivedAt,
        oldestSourceStreamEntryId: oldest?.sourceStreamEntryId,
        latestArchivedAt: latest?.archivedAt,
        latestSourceStreamEntryId: latest?.sourceStreamEntryId
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

  private async archiveTrimCandidates(params: {
    market: SpotMarket;
    head: OrderTradeEventStreamHead;
    dryRun: boolean;
  }): Promise<{
    enabled: boolean;
    archivedCount: number;
    archiveStreamKey?: string;
    oldestArchivedSourceStreamEntryId?: string;
    latestArchivedSourceStreamEntryId?: string;
  }> {
    const candidates = await this.resolveTrimCandidates(params.market, params.head);
    const archiveStreamKey = this.buildArchiveStreamKey(params.market);

    if (params.dryRun || candidates.length === 0) {
      return {
        enabled: this.archiveEnabled,
        archivedCount: candidates.length,
        archiveStreamKey,
        oldestArchivedSourceStreamEntryId: candidates[0]?.streamEntryId,
        latestArchivedSourceStreamEntryId: candidates.at(-1)?.streamEntryId
      };
    }

    for (const entry of candidates) {
      await this.redisClient.xAdd(
        archiveStreamKey,
        "*",
        {
          eventType: entry.event.eventType,
          market: entry.market,
          executionSequence: String(entry.executionSequence),
          replayCursor: entry.replayCursor,
          protocolVersion: entry.protocolVersion,
          publishedAt: entry.publishedAt ?? "",
          sourceStreamEntryId: entry.streamEntryId,
          archivedAt: this.now().toISOString(),
          event: JSON.stringify(entry.event)
        },
        {
          TRIM: {
            strategy: "MAXLEN",
            strategyModifier: "~",
            threshold: this.archiveMaxLen
          }
        }
      );
    }

    return {
      enabled: this.archiveEnabled,
      archivedCount: candidates.length,
      archiveStreamKey,
      oldestArchivedSourceStreamEntryId: candidates[0]?.streamEntryId,
      latestArchivedSourceStreamEntryId: candidates.at(-1)?.streamEntryId
    };
  }

  private async resolveTrimCandidates(
    market: SpotMarket,
    head: OrderTradeEventStreamHead
  ): Promise<OrderTradeEventStreamEntry[]> {
    const candidates: OrderTradeEventStreamEntry[] = [];
    const streamKey = this.buildStreamKey(market);
    const appliedMaxLen = Math.max(this.streamMaxLen, 1);
    const appliedMinStreamEntryId = resolveMinStreamEntryId(
      undefined,
      this.streamRetentionMs,
      this.now()
    );

    if (head.streamLength > appliedMaxLen) {
      const overflowCount = head.streamLength - appliedMaxLen;
      const overflowEntries = await this.listStreamEntries({
        market,
        fromStreamEntryId: "-",
        toStreamEntryId: "+",
        limit: overflowCount,
        overlapCount: 0,
        direction: "forward"
      });
      candidates.push(...overflowEntries);
    }

    if (appliedMinStreamEntryId) {
      const olderThanRetention = (
        await this.redisClient.xRange(streamKey, "-", appliedMinStreamEntryId, {
          COUNT: Math.max(head.streamLength, 1)
        })
      )
        .map((item) => this.mapStreamEntry(streamKey, item as RedisStreamMessageReply))
        .filter((entry) => compareStreamIds(entry.streamEntryId, appliedMinStreamEntryId) < 0);
      candidates.push(...olderThanRetention);
    }

    return dedupeEntries(candidates).sort((left, right) =>
      compareStreamIds(left.streamEntryId, right.streamEntryId)
    );
  }

  private shouldArchiveHead(head: OrderTradeEventStreamHead): boolean {
    if (!this.archiveEnabled) {
      return false;
    }

    return isRetentionPressure(
      head,
      this.streamMaxLen,
      this.streamRetentionMs,
      this.streamPressureWarningRatio
    );
  }

  private mapStreamEntry(
    streamKey: string,
    item: RedisStreamMessageReply
  ): OrderTradeEventStreamEntry {
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

  private buildArchiveStreamKey(market: SpotMarket): string {
    return `${this.archivePrefix}:${market.toLowerCase()}`;
  }

  private get streamPrefix(): string {
    return this.options.streamPrefix ?? "web3-cex:trade-events";
  }

  private get streamMaxLen(): number {
    const parsed = Number(this.options.streamMaxLen ?? 10_000);
    if (!Number.isFinite(parsed)) {
      return 10_000;
    }

    return Math.max(Math.trunc(parsed), 100);
  }

  private get archivePrefix(): string {
    return this.options.archivePrefix ?? `${this.streamPrefix}:archive`;
  }

  private get archiveMaxLen(): number {
    const parsed = Number(this.options.archiveMaxLen ?? this.streamMaxLen * 4);
    if (!Number.isFinite(parsed)) {
      return this.streamMaxLen * 4;
    }

    return Math.max(Math.trunc(parsed), 100);
  }

  private get streamRetentionMs(): number | undefined {
    const parsed = Number(this.options.streamRetentionMs ?? Number.NaN);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }

    return Math.max(Math.trunc(parsed), 60_000);
  }

  private get streamTrimCooldownMs(): number {
    const parsed = Number(this.options.streamTrimCooldownMs ?? 60_000);
    if (!Number.isFinite(parsed)) {
      return 60_000;
    }

    return Math.max(Math.trunc(parsed), 1_000);
  }

  private get streamPressureWarningRatio(): number {
    const parsed = Number(this.options.streamPressureWarningRatio ?? 0.8);
    if (!Number.isFinite(parsed)) {
      return 0.8;
    }

    return Math.min(Math.max(parsed, 0.1), 1);
  }

  private get archiveEnabled(): boolean {
    return this.options.archiveEnabled === false ? false : true;
  }

  private get autoTrimEnabled(): boolean {
    return this.options.autoTrim !== false;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async maybeAutoTrimStream(market: SpotMarket): Promise<void> {
    if (!this.autoTrimEnabled || !this.streamRetentionMs) {
      return;
    }

    const streamKey = this.buildStreamKey(market);
    const now = this.now().getTime();
    const lastTrimAt = this.lastTrimAtByStream.get(streamKey) ?? 0;
    if (now - lastTrimAt < this.streamTrimCooldownMs) {
      return;
    }

    try {
      await this.trimStreamEntries({
        market,
        strategy: "auto"
      });
    } catch (error) {
      console.warn(
        `order event stream auto trim failed for ${streamKey}: ${
          error instanceof Error ? error.message : "unknown trim error"
        }`
      );
    }
  }

  private async xTrim(streamKey: string, args: string[]): Promise<number> {
    const result = await this.redisClient.sendCommand([
      "XTRIM",
      streamKey,
      ...args
    ]);
    const parsed =
      typeof result === "number"
        ? result
        : typeof result === "string"
          ? Number(result)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

function resolveMarkets(market?: SpotMarket): SpotMarket[] {
  if (market) {
    return [market];
  }

  return listSpotMarkets({ includeDelisted: true });
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

function dedupeEntries(entries: OrderTradeEventStreamEntry[]): OrderTradeEventStreamEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.streamEntryId)) {
      return false;
    }
    seen.add(entry.streamEntryId);
    return true;
  });
}

function compareStreamIds(left: string | undefined, right: string | undefined): number {
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

function filterByExecutionSequence(
  entries: OrderTradeEventStreamEntry[],
  executionSequenceFrom?: number
): OrderTradeEventStreamEntry[] {
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

function resolveMinStreamEntryId(
  explicitMinStreamEntryId: string | undefined,
  retentionMs: number | undefined,
  now: Date
): string | undefined {
  if (explicitMinStreamEntryId?.trim()) {
    return explicitMinStreamEntryId.trim();
  }

  if (!retentionMs) {
    return undefined;
  }

  return `${Math.max(now.getTime() - retentionMs, 0)}-0`;
}

function calculateReplayWindowMs(
  oldestPublishedAt: string | undefined,
  latestPublishedAt: string | undefined
): number | undefined {
  if (!oldestPublishedAt || !latestPublishedAt) {
    return undefined;
  }

  const oldest = Date.parse(oldestPublishedAt);
  const latest = Date.parse(latestPublishedAt);
  if (!Number.isFinite(oldest) || !Number.isFinite(latest)) {
    return undefined;
  }

  return Math.max(latest - oldest, 0);
}

function calculateAgeMs(
  publishedAt: string | undefined,
  now: Date
): number | undefined {
  if (!publishedAt) {
    return undefined;
  }

  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(now.getTime() - parsed, 0);
}

function calculatePressureRatio(
  currentValue: number | undefined,
  threshold: number | undefined
): number | undefined {
  if (
    currentValue === undefined ||
    threshold === undefined ||
    !Number.isFinite(currentValue) ||
    !Number.isFinite(threshold) ||
    threshold <= 0
  ) {
    return undefined;
  }

  return currentValue / threshold;
}

function isRetentionPressure(
  head: Pick<OrderTradeEventStreamHead, "streamLength" | "oldestEntryAgeMs">,
  streamMaxLen: number,
  streamRetentionMs: number | undefined,
  pressureWarningRatio: number
): boolean {
  const maxLenPressureRatio = calculatePressureRatio(head.streamLength, streamMaxLen) ?? 0;
  const retentionPressureRatio =
    calculatePressureRatio(head.oldestEntryAgeMs, streamRetentionMs) ?? 0;

  return (
    maxLenPressureRatio >= pressureWarningRatio ||
    retentionPressureRatio >= pressureWarningRatio
  );
}
