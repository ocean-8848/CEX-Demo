import type { SpotMarket, TradingEvent } from "@web3-cex/domain";

export interface OrderTradeEventStreamEntry {
  streamKey: string;
  streamEntryId: string;
  publishedAt?: string;
  market: SpotMarket;
  executionSequence: number;
  replayCursor: string;
  protocolVersion: string;
  event: TradingEvent;
  /** W3C traceparent of the publishing span (only present when tracing was on). */
  traceparent?: string;
}

export interface OrderTradeEventStreamHead {
  market: SpotMarket;
  streamKey: string;
  streamLength: number;
  oldestStreamEntryId?: string;
  oldestExecutionSequence?: number;
  oldestReplayCursor?: string;
  oldestPublishedAt?: string;
  latestStreamEntryId?: string;
  latestExecutionSequence?: number;
  latestReplayCursor?: string;
  latestPublishedAt?: string;
  replayWindowMs?: number;
  oldestEntryAgeMs?: number;
  maxLenPressureRatio?: number;
  retentionPressureRatio?: number;
  retentionPressure?: boolean;
  recommendedAction?: "observe" | "trim";
}

export interface OrderTradeEventArchiveHead {
  market: SpotMarket;
  streamKey: string;
  streamLength: number;
  oldestArchivedAt?: string;
  oldestSourceStreamEntryId?: string;
  latestArchivedAt?: string;
  latestSourceStreamEntryId?: string;
}

export interface OrderTradeEventStreamQuery {
  market: SpotMarket;
  afterStreamEntryId?: string;
  fromStreamEntryId?: string;
  toStreamEntryId?: string;
  executionSequenceFrom?: number;
  limit?: number;
  overlapCount?: number;
  direction?: "forward" | "backward";
}

export interface ReplayOrderTradeEventStreamCommand
  extends OrderTradeEventStreamQuery {
  publishToChannel?: boolean;
}

export interface TrimOrderTradeEventStreamCommand {
  market?: SpotMarket;
  strategy?: "auto" | "maxlen" | "minid";
  maxLen?: number;
  retentionMs?: number;
  minStreamEntryId?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface MaintainOrderTradeEventStreamCommand {
  market?: SpotMarket;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
}

export interface OrderEventPublisherReport {
  mode: string;
  enabled: boolean;
  channel: string;
  stream: {
    enabled: boolean;
    prefix?: string;
    maxLen?: number;
    retentionMs?: number;
    autoTrimEnabled?: boolean;
    trimCooldownMs?: number;
    pressureWarningRatio?: number;
    heads: OrderTradeEventStreamHead[];
    archive?: {
      enabled: boolean;
      prefix?: string;
      maxLen?: number;
      heads: OrderTradeEventArchiveHead[];
    };
  };
}

export interface OrderEventPublisher {
  publish(events: TradingEvent[]): Promise<void>;
  getReport?(
    query?: {
      market?: SpotMarket;
      limit?: number;
    }
  ): Promise<OrderEventPublisherReport>;
  listStreamEntries?(
    query: OrderTradeEventStreamQuery
  ): Promise<OrderTradeEventStreamEntry[]>;
  replayStreamEntries?(
    command: ReplayOrderTradeEventStreamCommand
  ): Promise<{
    market: SpotMarket;
    replayedCount: number;
    publishToChannel: boolean;
    entries: OrderTradeEventStreamEntry[];
  }>;
  trimStreamEntries?(
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
  }>;
  maintainStreamEntries?(
    command: MaintainOrderTradeEventStreamCommand
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
  }>;
}
