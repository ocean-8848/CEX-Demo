// Market surveillance (A9): pure detectors over a trade / order activity window.
//
// Detectors only read; they never block trading. Each returns alert drafts
// with an evidence list (trade / order ids plus a compact snapshot) and a
// deterministic `alertKey`, so re-scanning an overlapping window updates the
// same alert instead of creating a new one.

export type SurveillanceAlertType = "wash_trade" | "concentrated_volume" | "spoofing" | "price_move";
export type SurveillanceAlertStatus = "open" | "acknowledged" | "dismissed";
export type SurveillanceSeverity = "low" | "medium" | "high";

export const SURVEILLANCE_ALERT_TYPES: SurveillanceAlertType[] = [
  "wash_trade",
  "concentrated_volume",
  "spoofing",
  "price_move"
];
export const SURVEILLANCE_ALERT_STATUSES: SurveillanceAlertStatus[] = ["open", "acknowledged", "dismissed"];

export interface ActivityTrade {
  tradeId: string;
  market: string;
  price: string;
  quantity: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerOrderId: string;
  sellerOrderId: string;
  makerOrderId: string;
  takerOrderId: string;
  executedAt: string;
}

export interface ActivityCancelledOrder {
  orderId: string;
  userId: string;
  market: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  createdAt: string;
  cancelledAt: string;
}

export interface SurveillanceActivity {
  since: string;
  until: string;
  trades: ActivityTrade[];
  cancelledOrders: ActivityCancelledOrder[];
  truncated: boolean;
}

export interface SurveillanceThresholds {
  /** How far back each scan reads (>= every detector window). */
  lookbackMs: number;
  /** Self-trades of one user within washWindowMs that raise an alert. */
  washMinTrades: number;
  washWindowMs: number;
  /** One account's share of all buy+sell participation in a market above this raises an alert. */
  concentrationRatio: number;
  concentrationWindowMs: number;
  /** Ignore markets with less quote volume than this in the window (noise). */
  concentrationMinVolume: number;
  concentrationMinTrades: number;
  /** Spoofing: unfilled orders with notional >= this, cancelled within maxLifetime, at least minOrders in window. */
  spoofMinNotional: number;
  spoofMaxLifetimeMs: number;
  spoofMinOrders: number;
  spoofWindowMs: number;
  /** (high - low) / low within the window above this raises a market-level alert. */
  priceMoveRatio: number;
  priceMoveWindowMs: number;
  /** false: demo market makers (config/fee-tiers.json marketMakers) are labelled, not alerted. */
  includeMarketMakers: boolean;
}

export const DEFAULT_SURVEILLANCE_THRESHOLDS: SurveillanceThresholds = {
  lookbackMs: 60 * 60 * 1000,
  washMinTrades: 1,
  washWindowMs: 60 * 60 * 1000,
  concentrationRatio: 0.3,
  concentrationWindowMs: 60 * 60 * 1000,
  concentrationMinVolume: 1000,
  concentrationMinTrades: 5,
  spoofMinNotional: 2000,
  spoofMaxLifetimeMs: 30_000,
  spoofMinOrders: 3,
  spoofWindowMs: 10 * 60 * 1000,
  priceMoveRatio: 0.03,
  priceMoveWindowMs: 5 * 60 * 1000,
  includeMarketMakers: false
};

export interface EvidenceTrade {
  tradeId: string;
  price: string;
  quantity: string;
  buyerUserId: string;
  sellerUserId: string;
  executedAt: string;
}

export interface EvidenceOrder {
  orderId: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  createdAt: string;
  cancelledAt: string;
  lifetimeMs: number;
}

export interface SurveillanceEvidence {
  tradeIds: string[];
  orderIds: string[];
  /** Snapshot of up to EVIDENCE_SNAPSHOT_LIMIT items for display. */
  trades: EvidenceTrade[];
  orders: EvidenceOrder[];
}

export interface SurveillanceAlertDraft {
  alertKey: string;
  type: SurveillanceAlertType;
  market: string;
  userId?: string;
  severity: SurveillanceSeverity;
  summary: string;
  metrics: Record<string, string | number>;
  evidence: SurveillanceEvidence;
  marketMaker: boolean;
  windowStart: string;
  windowEnd: string;
}

export interface MarketParticipation {
  market: string;
  tradeCount: number;
  volume: string;
  topAccounts: Array<{ userId: string; label?: string; marketMaker: boolean; volume: string; share: number }>;
}

export type MarketMakerLookup = (userId: string) => { label: string } | undefined;

export const EVIDENCE_SNAPSHOT_LIMIT = 20;

export function runSurveillanceDetectors(
  activity: SurveillanceActivity,
  thresholds: SurveillanceThresholds,
  now: Date,
  marketMakers: MarketMakerLookup
): SurveillanceAlertDraft[] {
  return [
    ...detectWashTrades(activity.trades, thresholds, marketMakers),
    ...detectConcentratedVolume(activity.trades, thresholds, now, marketMakers),
    ...detectSpoofing(activity.cancelledOrders, thresholds, marketMakers),
    ...detectPriceMoves(activity.trades, thresholds, now)
  ];
}

/** Wash trading / self-dealing: the same user on both sides of a trade. */
export function detectWashTrades(
  trades: ActivityTrade[],
  thresholds: SurveillanceThresholds,
  marketMakers: MarketMakerLookup
): SurveillanceAlertDraft[] {
  const groups = new Map<string, ActivityTrade[]>();
  for (const trade of trades) {
    if (trade.buyerUserId !== trade.sellerUserId) {
      continue;
    }
    const key = `${trade.market}\u0000${trade.buyerUserId}`;
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  const drafts: SurveillanceAlertDraft[] = [];
  for (const items of groups.values()) {
    const first = items[0] as ActivityTrade;
    const userId = first.buyerUserId;
    const maker = marketMakers(userId);
    if (maker && !thresholds.includeMarketMakers) {
      continue;
    }
    for (const cluster of clusterByTime(items, (trade) => trade.executedAt, thresholds.washWindowMs)) {
      if (cluster.length < thresholds.washMinTrades) {
        continue;
      }
      const volume = sumNotional(cluster);
      const start = cluster[0] as ActivityTrade;
      const end = cluster.at(-1) as ActivityTrade;
      drafts.push({
        alertKey: `wash_trade:${first.market}:${userId}:${Date.parse(start.executedAt)}`,
        type: "wash_trade",
        market: first.market,
        userId,
        severity: maker ? "low" : cluster.length >= 3 ? "high" : "medium",
        summary: `同一用户在 ${first.market} 自买自卖 ${cluster.length} 笔，成交额 ${formatNumber(volume)}`,
        metrics: { selfTradeCount: cluster.length, volume: formatNumber(volume) },
        evidence: tradeEvidence(cluster),
        marketMaker: !!maker,
        windowStart: start.executedAt,
        windowEnd: end.executedAt
      });
    }
  }
  return drafts;
}

/**
 * Concentrated volume: one account's share of all participation (each trade
 * counts once for the buyer and once for the seller, a self-trade twice for
 * the same user) in the recent window exceeds the ratio.
 */
export function detectConcentratedVolume(
  trades: ActivityTrade[],
  thresholds: SurveillanceThresholds,
  now: Date,
  marketMakers: MarketMakerLookup
): SurveillanceAlertDraft[] {
  const windowStart = now.getTime() - thresholds.concentrationWindowMs;
  const bucket = Math.floor(now.getTime() / thresholds.concentrationWindowMs) * thresholds.concentrationWindowMs;
  const drafts: SurveillanceAlertDraft[] = [];
  for (const participation of summarizeParticipation(
    trades.filter((trade) => Date.parse(trade.executedAt) >= windowStart),
    marketMakers,
    Number.POSITIVE_INFINITY
  )) {
    const marketVolume = Number(participation.volume);
    if (marketVolume < thresholds.concentrationMinVolume || participation.tradeCount < thresholds.concentrationMinTrades) {
      continue;
    }
    for (const account of participation.topAccounts) {
      if (account.share <= thresholds.concentrationRatio) {
        continue;
      }
      if (account.marketMaker && !thresholds.includeMarketMakers) {
        continue;
      }
      const involved = trades
        .filter(
          (trade) =>
            trade.market === participation.market &&
            Date.parse(trade.executedAt) >= windowStart &&
            (trade.buyerUserId === account.userId || trade.sellerUserId === account.userId)
        )
        .sort(byTime((trade) => trade.executedAt));
      drafts.push({
        alertKey: `concentrated_volume:${participation.market}:${account.userId}:${bucket}`,
        type: "concentrated_volume",
        market: participation.market,
        userId: account.userId,
        severity: account.marketMaker ? "low" : account.share >= 0.6 ? "high" : "medium",
        summary: `单一账户占 ${participation.market} 近 ${formatDuration(thresholds.concentrationWindowMs)}成交参与度 ${(account.share * 100).toFixed(1)}%`,
        metrics: {
          share: Number(account.share.toFixed(4)),
          accountVolume: account.volume,
          marketVolume: participation.volume,
          marketTradeCount: participation.tradeCount,
          ratioThreshold: thresholds.concentrationRatio
        },
        evidence: tradeEvidence(involved),
        marketMaker: account.marketMaker,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: now.toISOString()
      });
    }
  }
  return drafts;
}

/** Spoofing heuristic: repeated large orders cancelled quickly without any fill. */
export function detectSpoofing(
  orders: ActivityCancelledOrder[],
  thresholds: SurveillanceThresholds,
  marketMakers: MarketMakerLookup
): SurveillanceAlertDraft[] {
  const groups = new Map<string, ActivityCancelledOrder[]>();
  for (const order of orders) {
    const lifetime = Date.parse(order.cancelledAt) - Date.parse(order.createdAt);
    if (lifetime > thresholds.spoofMaxLifetimeMs || notional(order.price, order.quantity) < thresholds.spoofMinNotional) {
      continue;
    }
    const key = `${order.market}\u0000${order.userId}`;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const drafts: SurveillanceAlertDraft[] = [];
  for (const items of groups.values()) {
    const first = items[0] as ActivityCancelledOrder;
    const maker = marketMakers(first.userId);
    if (maker && !thresholds.includeMarketMakers) {
      continue;
    }
    for (const cluster of clusterByTime(items, (order) => order.cancelledAt, thresholds.spoofWindowMs)) {
      if (cluster.length < thresholds.spoofMinOrders) {
        continue;
      }
      const start = cluster[0] as ActivityCancelledOrder;
      const end = cluster.at(-1) as ActivityCancelledOrder;
      const total = cluster.reduce((sum, order) => sum + notional(order.price, order.quantity), 0);
      const lifetimes = cluster.map((order) => Date.parse(order.cancelledAt) - Date.parse(order.createdAt));
      drafts.push({
        alertKey: `spoofing:${first.market}:${first.userId}:${Date.parse(start.cancelledAt)}`,
        type: "spoofing",
        market: first.market,
        userId: first.userId,
        severity: maker ? "low" : cluster.length >= thresholds.spoofMinOrders * 2 ? "high" : "medium",
        summary: `${cluster.length} 笔大额委托（合计 ${formatNumber(total)}）在 ${Math.round(Math.max(...lifetimes) / 1000)} 秒内撤单且未成交`,
        metrics: {
          orderCount: cluster.length,
          totalNotional: formatNumber(total),
          maxLifetimeSeconds: Math.round(Math.max(...lifetimes) / 1000),
          minNotional: thresholds.spoofMinNotional
        },
        evidence: {
          tradeIds: [],
          orderIds: cluster.map((order) => order.orderId),
          trades: [],
          orders: cluster.slice(0, EVIDENCE_SNAPSHOT_LIMIT).map((order) => ({
            orderId: order.orderId,
            side: order.side,
            price: order.price,
            quantity: order.quantity,
            createdAt: order.createdAt,
            cancelledAt: order.cancelledAt,
            lifetimeMs: Date.parse(order.cancelledAt) - Date.parse(order.createdAt)
          }))
        },
        marketMaker: !!maker,
        windowStart: start.cancelledAt,
        windowEnd: end.cancelledAt
      });
    }
  }
  return drafts;
}

/** Abnormal price move: (high - low) / low in the recent window above the ratio. */
export function detectPriceMoves(
  trades: ActivityTrade[],
  thresholds: SurveillanceThresholds,
  now: Date
): SurveillanceAlertDraft[] {
  const windowStart = now.getTime() - thresholds.priceMoveWindowMs;
  const bucket = Math.floor(now.getTime() / thresholds.priceMoveWindowMs) * thresholds.priceMoveWindowMs;
  const byMarket = new Map<string, ActivityTrade[]>();
  for (const trade of trades) {
    if (Date.parse(trade.executedAt) >= windowStart) {
      byMarket.set(trade.market, [...(byMarket.get(trade.market) ?? []), trade]);
    }
  }
  const drafts: SurveillanceAlertDraft[] = [];
  for (const [market, items] of byMarket) {
    if (items.length < 2) {
      continue;
    }
    const sorted = [...items].sort(byTime((trade) => trade.executedAt));
    const low = sorted.reduce((best, trade) => (Number(trade.price) < Number(best.price) ? trade : best));
    const high = sorted.reduce((best, trade) => (Number(trade.price) > Number(best.price) ? trade : best));
    const move = (Number(high.price) - Number(low.price)) / Number(low.price);
    if (!(move > thresholds.priceMoveRatio)) {
      continue;
    }
    const first = sorted[0] as ActivityTrade;
    const last = sorted.at(-1) as ActivityTrade;
    const direction = Date.parse(high.executedAt) >= Date.parse(low.executedAt) ? "上涨" : "下跌";
    const keyTrades = uniqueBy([first, low, high, last], (trade) => trade.tradeId);
    drafts.push({
      alertKey: `price_move:${market}:-:${bucket}`,
      type: "price_move",
      market,
      severity: move >= thresholds.priceMoveRatio * 2 ? "high" : "medium",
      summary: `${market} 近 ${formatDuration(thresholds.priceMoveWindowMs)}价格${direction} ${(move * 100).toFixed(2)}%（${low.price} ↔ ${high.price}）`,
      metrics: {
        moveRatio: Number(move.toFixed(4)),
        low: low.price,
        high: high.price,
        first: first.price,
        last: last.price,
        tradeCount: sorted.length,
        ratioThreshold: thresholds.priceMoveRatio
      },
      evidence: tradeEvidence(keyTrades),
      marketMaker: false,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: now.toISOString()
    });
  }
  return drafts;
}

/**
 * Per-market participation: each trade's notional counts once for the buyer and
 * once for the seller; share = account side volume / (2 * market volume).
 */
export function summarizeParticipation(
  trades: ActivityTrade[],
  marketMakers: MarketMakerLookup,
  topN = 5
): MarketParticipation[] {
  const markets = new Map<string, { count: number; volume: number; accounts: Map<string, number> }>();
  for (const trade of trades) {
    const entry = markets.get(trade.market) ?? { count: 0, volume: 0, accounts: new Map<string, number>() };
    const value = notional(trade.price, trade.quantity);
    entry.count += 1;
    entry.volume += value;
    entry.accounts.set(trade.buyerUserId, (entry.accounts.get(trade.buyerUserId) ?? 0) + value);
    entry.accounts.set(trade.sellerUserId, (entry.accounts.get(trade.sellerUserId) ?? 0) + value);
    markets.set(trade.market, entry);
  }
  return [...markets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([market, entry]) => ({
      market,
      tradeCount: entry.count,
      volume: formatNumber(entry.volume),
      topAccounts: [...entry.accounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, topN)
        .map(([userId, volume]) => {
          const maker = marketMakers(userId);
          return {
            userId,
            ...(maker ? { label: maker.label } : {}),
            marketMaker: !!maker,
            volume: formatNumber(volume),
            share: entry.volume > 0 ? volume / (2 * entry.volume) : 0
          };
        })
    }));
}

function clusterByTime<T>(items: T[], timeOf: (item: T) => string, windowMs: number): T[][] {
  const sorted = [...items].sort(byTime(timeOf));
  const clusters: T[][] = [];
  let current: T[] = [];
  let anchor = 0;
  for (const item of sorted) {
    const time = Date.parse(timeOf(item));
    if (current.length === 0 || time - anchor > windowMs) {
      if (current.length > 0) {
        clusters.push(current);
      }
      current = [item];
      anchor = time;
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) {
    clusters.push(current);
  }
  return clusters;
}

function tradeEvidence(trades: ActivityTrade[]): SurveillanceEvidence {
  return {
    tradeIds: trades.map((trade) => trade.tradeId),
    orderIds: [...new Set(trades.flatMap((trade) => [trade.buyerOrderId, trade.sellerOrderId]))],
    trades: trades.slice(0, EVIDENCE_SNAPSHOT_LIMIT).map((trade) => ({
      tradeId: trade.tradeId,
      price: trade.price,
      quantity: trade.quantity,
      buyerUserId: trade.buyerUserId,
      sellerUserId: trade.sellerUserId,
      executedAt: trade.executedAt
    })),
    orders: []
  };
}

function sumNotional(trades: ActivityTrade[]): number {
  return trades.reduce((sum, trade) => sum + notional(trade.price, trade.quantity), 0);
}

function notional(price: string, quantity: string): number {
  const value = Number(price) * Number(quantity);
  return Number.isFinite(value) ? value : 0;
}

function byTime<T>(timeOf: (item: T) => string) {
  return (left: T, right: T) => Date.parse(timeOf(left)) - Date.parse(timeOf(right));
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000} 小时`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000} 分钟`;
  }
  return `${Math.round(ms / 1000)} 秒`;
}
