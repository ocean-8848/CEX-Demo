import assert from "node:assert/strict";
import test from "node:test";

import { SurveillanceService, readSurveillanceThresholdsFromEnv } from "../application/surveillance-service.js";
import {
  DEFAULT_SURVEILLANCE_THRESHOLDS,
  detectConcentratedVolume,
  detectPriceMoves,
  detectSpoofing,
  detectWashTrades,
  type ActivityCancelledOrder,
  type ActivityTrade,
  type SurveillanceActivity
} from "../domain/surveillance.js";
import { InMemorySurveillanceRepository } from "../infrastructure/in-memory-surveillance-repository.js";

const NOW = new Date("2026-03-08T12:00:00.000Z");
const thresholds = DEFAULT_SURVEILLANCE_THRESHOLDS;
const makers = (userId: string) => (userId.startsWith("mm-") ? { label: `做市商 ${userId}` } : undefined);
let sequence = 0;

function trade(overrides: Partial<ActivityTrade>): ActivityTrade {
  sequence += 1;
  return {
    tradeId: `t-${sequence}`,
    market: "ETH-USDT",
    price: "3200",
    quantity: "1",
    buyerUserId: "mm-bid",
    sellerUserId: "mm-ask",
    buyerOrderId: `bo-${sequence}`,
    sellerOrderId: `so-${sequence}`,
    makerOrderId: `so-${sequence}`,
    takerOrderId: `bo-${sequence}`,
    executedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...overrides
  };
}

function cancelled(overrides: Partial<ActivityCancelledOrder>): ActivityCancelledOrder {
  sequence += 1;
  const cancelledAt = overrides.cancelledAt ?? new Date(NOW.getTime() - 60_000 + sequence * 1000).toISOString();
  return {
    orderId: `o-${sequence}`,
    userId: "alice",
    market: "ETH-USDT",
    side: "buy",
    price: "2900",
    quantity: "1",
    createdAt: new Date(Date.parse(cancelledAt) - 4_000).toISOString(),
    cancelledAt,
    ...overrides
  };
}

test("wash trading: same user on both sides raises one alert with the trades as evidence", () => {
  const self = [trade({ buyerUserId: "alice", sellerUserId: "alice" }), trade({ buyerUserId: "alice", sellerUserId: "alice" })];
  const drafts = detectWashTrades([...self, trade({}), trade({ buyerUserId: "alice" })], thresholds, makers);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.type, "wash_trade");
  assert.equal(drafts[0]?.userId, "alice");
  assert.deepEqual(drafts[0]?.evidence.tradeIds, self.map((item) => item.tradeId));
  assert.equal(drafts[0]?.metrics.selfTradeCount, 2);
  // Market makers are labelled, not alerted, unless explicitly included.
  const makerSelf = [trade({ buyerUserId: "mm-bid", sellerUserId: "mm-bid" })];
  assert.equal(detectWashTrades(makerSelf, thresholds, makers).length, 0);
  const included = detectWashTrades(makerSelf, { ...thresholds, includeMarketMakers: true }, makers);
  assert.equal(included[0]?.marketMaker, true);
  assert.equal(included[0]?.severity, "low");
});

test("concentrated volume: one account above the participation ratio", () => {
  // alice is on one side of 5 of 10 trades -> 25% of participation (below 30%)...
  const base = Array.from({ length: 5 }, () => trade({}));
  const alice = Array.from({ length: 5 }, () => trade({ buyerUserId: "alice", sellerUserId: "bob" }));
  assert.equal(detectConcentratedVolume([...base, ...alice], thresholds, NOW, makers).length, 0);
  // ...but self-trading puts her on both sides: 10 / 20 sides = 50%.
  const selfDealing = Array.from({ length: 5 }, () => trade({ buyerUserId: "alice", sellerUserId: "alice" }));
  const drafts = detectConcentratedVolume([...base, ...selfDealing], thresholds, NOW, makers);
  const aliceAlert = drafts.find((draft) => draft.userId === "alice");
  assert.ok(aliceAlert, "alice is flagged");
  assert.equal(aliceAlert?.metrics.share, 0.5);
  // Market makers dominate the base volume but are never flagged by default.
  assert.ok(drafts.every((draft) => !draft.userId?.startsWith("mm-")));
  // Too little market volume is ignored.
  assert.equal(
    detectConcentratedVolume(selfDealing.slice(0, 2), thresholds, NOW, makers).length,
    0,
    "below min trades / volume"
  );
});

test("spoofing: repeated large orders cancelled quickly without fills", () => {
  const orders = [cancelled({}), cancelled({}), cancelled({})];
  const drafts = detectSpoofing(orders, thresholds, makers);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.type, "spoofing");
  assert.deepEqual(drafts[0]?.evidence.orderIds, orders.map((order) => order.orderId));
  assert.equal(drafts[0]?.metrics.orderCount, 3);
  // Small or long-lived orders do not count.
  assert.equal(detectSpoofing([cancelled({}), cancelled({}), cancelled({ quantity: "0.1" })], thresholds, makers).length, 0);
  const slow = cancelled({});
  slow.createdAt = new Date(Date.parse(slow.cancelledAt) - 120_000).toISOString();
  assert.equal(detectSpoofing([cancelled({}), cancelled({}), slow], thresholds, makers).length, 0);
  assert.equal(detectSpoofing(orders.map((order) => ({ ...order, userId: "mm-ask" })), thresholds, makers).length, 0);
});

test("abnormal price move: high-low range above the ratio in the window", () => {
  const calm = [trade({ price: "3200" }), trade({ price: "3230" })];
  assert.equal(detectPriceMoves(calm, thresholds, NOW).length, 0);
  const spike = [
    trade({ price: "3200", executedAt: new Date(NOW.getTime() - 120_000).toISOString() }),
    trade({ price: "3350", executedAt: new Date(NOW.getTime() - 30_000).toISOString() })
  ];
  const drafts = detectPriceMoves(spike, thresholds, NOW);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.type, "price_move");
  assert.equal(drafts[0]?.userId, undefined);
  assert.match(drafts[0]?.summary ?? "", /上涨/);
  // Older trades outside the window do not count.
  const old = [trade({ price: "3000", executedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }), ...calm];
  assert.equal(detectPriceMoves(old, thresholds, NOW).length, 0);
});

test("scan dedupes re-detections, keeps reviewer decisions and audits status changes", async () => {
  const self = trade({ buyerUserId: "alice", sellerUserId: "alice" });
  const activity: SurveillanceActivity = {
    since: new Date(NOW.getTime() - 3_600_000).toISOString(),
    until: NOW.toISOString(),
    trades: [self],
    cancelledOrders: [],
    truncated: false
  };
  const requests: Array<Record<string, unknown>> = [];
  const repository = new InMemorySurveillanceRepository();
  let id = 0;
  const service = new SurveillanceService(
    repository,
    {
      async getActivity(query) {
        requests.push(query as unknown as Record<string, unknown>);
        return activity;
      }
    },
    { now: () => NOW, createId: () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`, marketMakers: makers, marketMakerUserIds: ["mm-ask", "mm-bid"] }
  );

  const first = await service.scan();
  assert.equal(first.created, 1);
  assert.deepEqual(requests[0]?.orderExcludeUserIds, ["mm-ask", "mm-bid"]);
  const second = await service.scan();
  assert.equal(second.created, 0);
  assert.equal(second.refreshed, 1);

  const { items } = await service.listAlerts({ type: "wash_trade" });
  const alertId = items[0]?.alertId as string;
  await assert.rejects(() => service.updateStatus({ alertId, status: "dismissed", actor: "ops" }), /note is required/i);
  const acknowledged = await service.updateStatus({ alertId, status: "acknowledged", note: "联系用户核实", actor: "ops@example.com" });
  assert.equal(acknowledged.status, "acknowledged");
  await assert.rejects(() => service.updateStatus({ alertId, status: "acknowledged", note: "x", actor: "ops" }), /cannot become/);
  const dismissed = await service.updateStatus({ alertId, status: "dismissed", note: "测试账户", actor: "ops@example.com" });
  assert.deepEqual(
    dismissed.events.map((event) => event.action),
    ["detected", "acknowledged", "dismissed"]
  );
  // A dismissed alert is not refreshed or re-created by later scans.
  const third = await service.scan();
  assert.equal(third.created + third.refreshed, 0);
  const overview = await service.getOverview();
  assert.equal(overview.byStatus.dismissed, 1);
  assert.equal(overview.marketMakers.length, 2);
});

test("thresholds are read from env", () => {
  const parsed = readSurveillanceThresholdsFromEnv({
    RISK_SURVEILLANCE_CONCENTRATION_RATIO: "0.5",
    RISK_SURVEILLANCE_SPOOF_MIN_ORDERS: "5",
    RISK_SURVEILLANCE_PRICE_MOVE_WINDOW_MS: "0",
    RISK_SURVEILLANCE_INCLUDE_MARKET_MAKERS: "true"
  });
  assert.deepEqual(parsed, { concentrationRatio: 0.5, spoofMinOrders: 5, includeMarketMakers: true });
});

test("new evidence after a dismissed alert opens a new alert instead of being swallowed", async () => {
  const first = trade({ buyerUserId: "carol", sellerUserId: "carol" });
  const activity: SurveillanceActivity = { since: "", until: "", trades: [first], cancelledOrders: [], truncated: false };
  let id = 100;
  const service = new SurveillanceService(
    new InMemorySurveillanceRepository(),
    { async getActivity() { return activity; } },
    { now: () => NOW, createId: () => `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`, marketMakers: makers, marketMakerUserIds: [] }
  );
  await service.scan();
  const [alert] = (await service.listAlerts({ userId: "carol" })).items;
  await service.updateStatus({ alertId: alert!.alertId, status: "dismissed", note: "已核实", actor: "ops" });
  // Same cluster anchor, one more self-trade.
  const second = trade({ buyerUserId: "carol", sellerUserId: "carol", executedAt: new Date(NOW.getTime() - 30_000).toISOString() });
  activity.trades = [first, second];
  assert.equal((await service.scan()).created, 1);
  assert.equal((await service.scan()).refreshed, 1, "the new open alert absorbs later scans");
  const open = (await service.listAlerts({ userId: "carol", status: "open" })).items;
  assert.equal(open.length, 1);
  assert.ok(open[0]?.evidence.tradeIds.includes(second.tradeId));
});
