import assert from "node:assert/strict";
import test from "node:test";

import type { TradingEvent } from "@web3-cex/domain";

import { ApiGatewayRealtimeServer } from "../http/api-gateway-realtime-server.js";

function createRealtimeClientState() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    client: {
      connectionId: "connection-1",
      socket: {
        readyState: 1,
        send(payload: string) {
          sent.push(JSON.parse(payload) as Record<string, unknown>);
        }
      },
      principal: {
        authType: "session",
        userId: "user-1",
        status: "active",
        userType: "customer",
        roles: [],
        permissions: [],
        createdAt: "2026-03-08T00:00:00.000Z",
        active: true
      },
      subscriptions: {
        orders: { enabled: false, market: undefined },
        trades: { enabled: false, market: undefined },
        notifications: { enabled: true },
        balances: { enabled: true },
        deposits: { enabled: false },
        withdrawals: { enabled: false },
        positions: { enabled: false, market: undefined },
        account_events: { enabled: false, market: undefined }
      },
      orderVersions: new Map<string, string>(),
      tradeIds: new Set<string>(),
      notificationIds: new Set<string>(),
      balanceVersions: new Map<string, string>(),
      depositVersions: new Map<string, string>(),
      withdrawalVersions: new Map<string, string>(),
      positionVersions: new Map<string, string>()
    }
  };
}

test("realtime server emits notification and balance deltas from wallet events", async () => {
  const realtime = new ApiGatewayRealtimeServer({
    async listWalletNotifications() {
      return {
        items: [
          {
            notificationId: "notification-1",
            userId: "user-1",
            eventType: "withdrawal.confirmed"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    },
    async listBalances() {
      return {
        items: [
          {
            accountId: "account-1",
            assetCode: "USDT",
            available: "101",
            locked: "0",
            total: "101",
            updatedAt: "2026-03-08T00:00:01.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    }
  } as never);

  const { sent, client } = createRealtimeClientState();
  (realtime as any).clients.set(client.connectionId, client);

  await (realtime as any).handleWalletNotificationEvent({
    eventType: "wallet.notification.created",
    payload: {
      notificationId: "notification-1",
      userId: "user-1"
    }
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.channel, "notifications");
  assert.equal((sent[0]?.items as Array<Record<string, unknown>>)[0]?.notificationId, "notification-1");
  assert.equal(sent[1]?.channel, "balances");
  assert.equal((sent[1]?.items as Array<Record<string, unknown>>)[0]?.assetCode, "USDT");
});

test("realtime server emits unified account events for wallet changes", async () => {
  const realtime = new ApiGatewayRealtimeServer({
    async listWalletNotifications() {
      return {
        items: [
          {
            notificationId: "notification-2",
            userId: "user-1",
            eventType: "deposit.confirmed",
            updatedAt: "2026-03-08T00:00:06.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    },
    async listBalances() {
      return {
        items: [
          {
            accountId: "account-1",
            assetCode: "USDT",
            available: "120",
            locked: "0",
            total: "120",
            updatedAt: "2026-03-08T00:00:06.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    }
  } as never);

  const { sent, client } = createRealtimeClientState();
  client.subscriptions.account_events.enabled = true;
  (realtime as any).clients.set(client.connectionId, client);

  await (realtime as any).handleWalletNotificationEvent({
    eventType: "wallet.notification.created",
    payload: {
      notificationId: "notification-2",
      userId: "user-1"
    }
  });

  const accountEvent = sent.find((item) => item.channel === "account_events");
  assert.equal(Boolean(accountEvent), true);
  assert.equal((accountEvent?.items as Array<Record<string, unknown>>)[0]?.entityType, "notification");
});

test("realtime server emits balance deltas from trading events", async () => {
  const realtime = new ApiGatewayRealtimeServer({
    async listBalances() {
      return {
        items: [
          {
            accountId: "account-1",
            assetCode: "USDT",
            available: "95",
            locked: "5",
            total: "100",
            updatedAt: "2026-03-08T00:00:02.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    },
    async listTrades() {
      return [];
    }
  } as never);

  const { sent, client } = createRealtimeClientState();
  client.subscriptions.notifications.enabled = false;
  (realtime as any).clients.set(client.connectionId, client);

  const event: TradingEvent = {
    eventId: "event-1",
    eventType: "trade.executed",
    aggregateType: "spot_trade",
    aggregateId: "trade-1",
    traceId: "trace-1",
    occurredAt: "2026-03-08T00:00:02.000Z",
    payload: {
      market: "BTC-USDT",
      userIds: ["user-1"]
    }
  };

  await (realtime as any).handleTradingEvent(event);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, "balances");
  assert.equal((sent[0]?.items as Array<Record<string, unknown>>)[0]?.available, "95");
});

test("realtime server emits deposit withdrawal and position deltas from wallet events", async () => {
  const realtime = new ApiGatewayRealtimeServer({
    async listDeposits() {
      return {
        items: [
          {
            depositId: "deposit-1",
            status: "credited",
            updatedAt: "2026-03-08T00:00:03.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    },
    async listWithdrawals() {
      return {
        items: [
          {
            withdrawalId: "withdrawal-1",
            status: "broadcasted",
            updatedAt: "2026-03-08T00:00:04.000Z"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      };
    },
    async listBalances() {
      return {
        items: [
          {
            accountId: "account-1",
            assetCode: "BTC",
            available: "1.2",
            locked: "0.3",
            total: "1.5",
            updatedAt: "2026-03-08T00:00:05.000Z"
          },
          {
            accountId: "account-1",
            assetCode: "USDT",
            available: "9500",
            locked: "500",
            total: "10000",
            updatedAt: "2026-03-08T00:00:05.000Z"
          }
        ],
        total: 2,
        limit: 50,
        offset: 0
      };
    },
    async listOrders() {
      return [
        {
          orderId: "order-1",
          market: "BTC-USDT",
          side: "buy",
          status: "accepted",
          restingQuantity: "0.25",
          updatedAt: "2026-03-08T00:00:05.000Z",
          price: "40000"
        }
      ];
    }
  } as never);

  const { sent, client } = createRealtimeClientState();
  client.subscriptions.notifications.enabled = false;
  client.subscriptions.deposits.enabled = true;
  client.subscriptions.withdrawals.enabled = true;
  client.subscriptions.positions.enabled = true;
  (client.subscriptions.positions as { enabled: boolean; market?: string }).market = "BTC-USDT";
  (realtime as any).clients.set(client.connectionId, client);

  await (realtime as any).handleWalletNotificationEvent({
    eventType: "wallet.deposit.updated",
    payload: {
      depositId: "deposit-1",
      userId: "user-1"
    }
  });

  await (realtime as any).handleWalletNotificationEvent({
    eventType: "wallet.withdrawal.updated",
    payload: {
      withdrawalId: "withdrawal-1",
      userId: "user-1"
    }
  });

  const channels = sent.map((item) => item.channel);
  assert.equal(channels.includes("deposits"), true);
  assert.equal(channels.includes("withdrawals"), true);
  assert.equal(channels.includes("positions"), true);
});

test("realtime server resumes from replay buffer when sequence is available", async () => {
  const realtime = new ApiGatewayRealtimeServer({} as never);
  const { sent, client } = createRealtimeClientState();
  client.subscriptions.account_events.enabled = true;
  (realtime as any).clients.set(client.connectionId, client);

  (realtime as any).sendReplayable(client, "event", "account_events", [
    {
      entityType: "balance",
      entityId: "account-1:USDT",
      payload: { available: "100" }
    }
  ]);
  (realtime as any).sendReplayable(client, "event", "account_events", [
    {
      entityType: "notification",
      entityId: "notification-3",
      payload: { notificationId: "notification-3" }
    }
  ]);

  sent.length = 0;
  await (realtime as any).resume(client, {
    type: "resume",
    lastSequence: 1,
    channels: ["account_events"]
  });

  assert.equal(sent[0]?.channel, "account_events");
  assert.equal(sent[0]?.sequence, 2);
  assert.equal(sent[1]?.type, "resumed");
  assert.equal(sent[1]?.mode, "replay");
});

test("realtime server requests resync when replay buffer no longer covers sequence", async () => {
  const realtime = new ApiGatewayRealtimeServer({} as never);
  const { sent, client } = createRealtimeClientState();
  client.subscriptions.account_events.enabled = true;
  (realtime as any).replayBufferSize = 1;
  (realtime as any).clients.set(client.connectionId, client);

  (realtime as any).sendReplayable(client, "event", "account_events", [
    {
      entityType: "balance",
      entityId: "account-1:USDT",
      payload: { available: "100" }
    }
  ]);
  (realtime as any).sendReplayable(client, "event", "account_events", [
    {
      entityType: "notification",
      entityId: "notification-4",
      payload: { notificationId: "notification-4" }
    }
  ]);

  sent.length = 0;
  (realtime as any).buildAccountEventSnapshot = async () => [
    {
      entityType: "balance",
      entityId: "account-1:USDT",
      payload: { available: "101" }
    }
  ];
  await (realtime as any).resume(client, {
    type: "resume",
    lastSequence: 0,
    channels: ["account_events"]
  });

  assert.equal(sent[0]?.type, "resync_required");
  assert.equal(sent[1]?.type, "snapshot");
  assert.equal(sent[1]?.channel, "account_events");
  assert.equal(sent[2]?.type, "resumed");
  assert.equal(sent[2]?.mode, "snapshot");
});
