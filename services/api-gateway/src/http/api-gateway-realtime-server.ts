import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import {
  getSpotMarketDefinition,
  isSpotMarket,
  listSpotMarkets,
  addAmounts,
  compareAmounts,
  type SpotMarket,
  type TradingEvent
} from "@web3-cex/domain";
import { Logger } from "@nestjs/common";
import type { RedisClientType } from "redis";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { GatewayPrincipal } from "../domain/types.js";
import { createGatewayRedisClient } from "../infrastructure/gateway-redis.js";
import { createApiKeySignature } from "./api-key-signature.js";
import {
  MessageRateLimiter,
  WS_CLOSE_RATE_LIMITED,
  WS_CLOSE_SESSION_EXPIRED,
  WS_CLOSE_SESSION_REVOKED,
  isOriginAllowed,
  msUntilExpiry,
  parseAllowedOrigins
} from "./realtime-connection-guards.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";

type RealtimeChannel =
  | "orders"
  | "trades"
  | "notifications"
  | "balances"
  | "deposits"
  | "withdrawals"
  | "positions"
  | "account_events";

interface WalletNotificationCreatedEvent {
  eventType:
    | "wallet.notification.created"
    | "wallet.deposit.updated"
    | "wallet.withdrawal.updated";
  payload: Record<string, unknown>;
}

interface SubscriptionState {
  enabled: boolean;
  market?: SpotMarket;
}

interface RealtimeClientState {
  connectionId: string;
  socket: WebSocket;
  principal?: GatewayPrincipal;
  /** Session token kept only to re-introspect it (catches logout / freeze). */
  sessionToken?: string;
  expiryTimer?: NodeJS.Timeout;
  rateLimiter: MessageRateLimiter;
  subscriptions: Record<RealtimeChannel, SubscriptionState>;
  orderVersions: Map<string, string>;
  tradeIds: Set<string>;
  notificationIds: Set<string>;
  balanceVersions: Map<string, string>;
  depositVersions: Map<string, string>;
  withdrawalVersions: Map<string, string>;
  positionVersions: Map<string, string>;
}

interface RealtimeAuthMessage {
  type: "auth";
  token?: string;
  apiKey?: string;
  nonce?: string;
  timestamp?: string;
  signature?: string;
}

interface RealtimeSubscribeMessage {
  type: "subscribe" | "unsubscribe";
  channels: RealtimeChannel[];
  market?: SpotMarket;
}

interface RealtimeSnapshotMessage {
  type: "snapshot";
  channels?: RealtimeChannel[];
  market?: SpotMarket;
}

interface RealtimePingMessage {
  type: "ping";
}

interface RealtimeResumeMessage {
  type: "resume";
  lastSequence?: number;
  channels?: RealtimeChannel[];
  market?: SpotMarket;
}

type RealtimeMessage =
  | RealtimeAuthMessage
  | RealtimeSubscribeMessage
  | RealtimeSnapshotMessage
  | RealtimePingMessage
  | RealtimeResumeMessage;

interface RealtimeReplayFrame {
  sequence: number;
  userId: string;
  channel: RealtimeChannel;
  market?: SpotMarket;
  payload: Record<string, unknown>;
}

export class ApiGatewayRealtimeServer {
  private readonly logger = new Logger(ApiGatewayRealtimeServer.name);
  private readonly clients = new Map<string, RealtimeClientState>();
  private readonly path: string;
  private readonly snapshotLimit: number;
  private readonly maxCacheSize: number;
  private readonly replayBufferSize: number;
  private readonly eventChannel: string;
  private readonly walletEventChannel: string;
  private webSocketServer?: WebSocketServer;
  private eventSubscriber?: RedisClientType;
  private nextSequence = 1;
  private readonly replayBuffers = new Map<string, RealtimeReplayFrame[]>();
  private readonly allowedOrigins: string[] | "*";
  private readonly messageLimit: number;
  private readonly messageWindowMs: number;
  private readonly reauthIntervalMs: number;
  private reauthTimer?: NodeJS.Timeout;

  constructor(private readonly apiGatewayHttpService: ApiGatewayHttpService) {
    this.path = process.env.GATEWAY_WS_PATH ?? "/api/v1/gateway/realtime";
    this.snapshotLimit = Number(process.env.GATEWAY_WS_SNAPSHOT_LIMIT ?? "50");
    this.maxCacheSize = Number(process.env.GATEWAY_WS_CACHE_SIZE ?? "500");
    this.replayBufferSize = Number(process.env.GATEWAY_WS_REPLAY_BUFFER_SIZE ?? "200");
    this.eventChannel = process.env.GATEWAY_EVENT_CHANNEL ?? "web3-cex:trading.events";
    this.walletEventChannel =
      process.env.GATEWAY_WALLET_EVENT_CHANNEL ?? "web3-cex:wallet.notifications";
    this.allowedOrigins = parseAllowedOrigins(process.env.GATEWAY_WS_ALLOWED_ORIGINS);
    this.messageLimit = Number(process.env.GATEWAY_WS_MESSAGE_LIMIT ?? "30");
    this.messageWindowMs = Number(process.env.GATEWAY_WS_MESSAGE_WINDOW_MS ?? "10000");
    this.reauthIntervalMs = Number(process.env.GATEWAY_WS_REAUTH_INTERVAL_MS ?? "60000");
  }

  attach(server: HttpServer): void {
    this.webSocketServer = new WebSocketServer({
      server,
      path: this.path,
      maxPayload: 64 * 1024,
      // Reject cross-site handshakes before any session token is looked at.
      verifyClient: (info: { origin?: string }, done: (result: boolean, code?: number, message?: string) => void) => {
        if (isOriginAllowed(info.origin, this.allowedOrigins)) {
          done(true);
          return;
        }
        this.logger.warn(`rejected realtime handshake from origin ${info.origin}`);
        done(false, 403, "Origin not allowed");
      }
    });
    if (this.reauthIntervalMs > 0) {
      this.reauthTimer = setInterval(() => {
        void this.reauthenticateSessions();
      }, this.reauthIntervalMs);
      this.reauthTimer.unref();
    }

    this.webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      void this.handleConnection(socket, request);
    });

    this.startEventSubscriber().catch((error) => {
      this.logger.warn(`failed to start gateway realtime subscriber: ${readErrorMessage(error)}`);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.reauthTimer);
    for (const client of this.clients.values()) {
      clearTimeout(client.expiryTimer);
      client.socket.close();
    }
    this.clients.clear();

    if (this.eventSubscriber?.isOpen) {
      await this.eventSubscriber.quit();
    }
    this.eventSubscriber = undefined;

    if (this.webSocketServer) {
      await new Promise<void>((resolve, reject) => {
        this.webSocketServer?.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      this.webSocketServer = undefined;
    }
  }

  private async startEventSubscriber(): Promise<void> {
    if (this.eventSubscriber) {
      return;
    }

    this.eventSubscriber = createGatewayRedisClient(
      process.env.GATEWAY_REDIS_URL ?? "redis://127.0.0.1:6379"
    );
    await this.eventSubscriber.connect();
    await this.eventSubscriber.subscribe(this.eventChannel, async (message) => {
      try {
        const event = JSON.parse(message) as TradingEvent;
        await this.handleTradingEvent(event);
      } catch (error) {
        this.logger.warn(`failed to process trading event: ${readErrorMessage(error)}`);
      }
    });
    await this.eventSubscriber.subscribe(this.walletEventChannel, async (message) => {
      try {
        const event = JSON.parse(message) as WalletNotificationCreatedEvent;
        await this.handleWalletNotificationEvent(event);
      } catch (error) {
        this.logger.warn(`failed to process wallet event: ${readErrorMessage(error)}`);
      }
    });
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const connectionId = randomUUID();
    const client: RealtimeClientState = {
      connectionId,
      socket,
      rateLimiter: new MessageRateLimiter(this.messageLimit, this.messageWindowMs),
      subscriptions: {
        orders: { enabled: false },
        trades: { enabled: false },
        notifications: { enabled: false },
        balances: { enabled: false },
        deposits: { enabled: false },
        withdrawals: { enabled: false },
        positions: { enabled: false },
        account_events: { enabled: false }
      },
      orderVersions: new Map(),
      tradeIds: new Set(),
      notificationIds: new Set(),
      balanceVersions: new Map(),
      depositVersions: new Map(),
      withdrawalVersions: new Map(),
      positionVersions: new Map()
    };
    this.clients.set(connectionId, client);

    socket.on("message", (raw: RawData) => {
      void this.handleMessage(client, raw);
    });
    socket.on("close", () => {
      clearTimeout(client.expiryTimer);
      this.clients.delete(connectionId);
    });
    socket.on("error", (error: Error) => {
      this.logger.warn(`realtime socket error: ${readErrorMessage(error)}`);
      this.clients.delete(connectionId);
    });

    this.send(client, {
      type: "ready",
      connectionId,
      path: this.path,
      resumeSupported: true,
      sentAt: new Date().toISOString()
    });

    const authFromQuery = readHandshakeAuth(request.url ?? "", request.headers.authorization);
    if (authFromQuery) {
      try {
        client.principal = await this.authenticate(authFromQuery);
        this.trackSession(client, authFromQuery);
        this.sendAuthenticated(client);
      } catch (error) {
        this.sendError(client, error);
        socket.close();
      }
    }
  }

  private async handleMessage(client: RealtimeClientState, raw: RawData): Promise<void> {
    const rate = client.rateLimiter.hit();
    if (rate === "abuse") {
      client.socket.close(WS_CLOSE_RATE_LIMITED, "Too many messages");
      return;
    }
    if (rate === "limited") {
      this.sendError(client, new Error("Too Many Requests: realtime message rate limit exceeded"));
      return;
    }

    let message: RealtimeMessage;

    try {
      message = JSON.parse(raw.toString()) as RealtimeMessage;
    } catch {
      this.sendError(client, new Error("Message must be JSON"));
      return;
    }

    try {
      switch (message.type) {
        case "auth":
          client.principal = await this.authenticate(message);
          this.trackSession(client, message);
          this.sendAuthenticated(client);
          await this.pushSnapshot(client, [
            "orders",
            "trades",
            "notifications",
            "balances",
            "deposits",
            "withdrawals",
            "positions"
          ]);
          return;
        case "subscribe":
          this.assertAuthenticated(client);
          this.updateSubscriptions(client, message.channels, true, message.market);
          this.send(client, {
            type: "subscribed",
            subscriptions: summarizeSubscriptions(client),
            sentAt: new Date().toISOString()
          });
          await this.pushSnapshot(client, message.channels);
          return;
        case "unsubscribe":
          this.assertAuthenticated(client);
          this.updateSubscriptions(client, message.channels, false);
          this.send(client, {
            type: "unsubscribed",
            subscriptions: summarizeSubscriptions(client),
            sentAt: new Date().toISOString()
          });
          return;
        case "snapshot":
          this.assertAuthenticated(client);
          await this.pushSnapshot(
            client,
            message.channels && message.channels.length > 0
              ? message.channels
              : [
                  "orders",
                  "trades",
                  "notifications",
                  "balances",
                  "deposits",
                  "withdrawals",
                  "positions"
                ],
            message.market
          );
          return;
        case "ping":
          this.send(client, {
            type: "pong",
            sentAt: new Date().toISOString()
          });
          return;
        case "resume":
          this.assertAuthenticated(client);
          await this.resume(client, message);
          return;
      }
    } catch (error) {
      this.sendError(client, error);
    }
  }

  private async handleTradingEvent(event: TradingEvent): Promise<void> {
    for (const client of this.clients.values()) {
      if (!client.principal) {
        continue;
      }

      const hasMarketScopedSubscription =
        client.subscriptions.orders.enabled ||
        client.subscriptions.trades.enabled ||
        client.subscriptions.positions.enabled;
      if (
        hasMarketScopedSubscription &&
        event.payload.market !== client.subscriptions.orders.market &&
        event.payload.market !== client.subscriptions.trades.market &&
        event.payload.market !== client.subscriptions.positions.market
      ) {
        const subscribedToAllMarkets =
          (client.subscriptions.orders.enabled && !client.subscriptions.orders.market) ||
          (client.subscriptions.trades.enabled && !client.subscriptions.trades.market) ||
          (client.subscriptions.positions.enabled && !client.subscriptions.positions.market);
        if (!subscribedToAllMarkets) {
          continue;
        }
      }

      const userId = client.principal.userId;
      if (!event.payload.userIds.includes(userId)) {
        continue;
      }

      if (client.subscriptions.orders.enabled && event.payload.order) {
        const order = await this.apiGatewayHttpService.getOrder(client.principal, event.payload.order.orderId);
        const version = orderVersion(order);
        const previousVersion = client.orderVersions.get(order.orderId);
        client.orderVersions.set(order.orderId, version);
        trimMap(client.orderVersions, this.maxCacheSize);
        if (previousVersion !== version) {
          this.sendReplayable(client, "event", "orders", [order], event.payload.market);
        }
      }

      if (client.subscriptions.trades.enabled && event.eventType === "trade.executed") {
        const trades = await this.apiGatewayHttpService.listTrades(client.principal, {
          market: event.payload.market,
          limit: this.snapshotLimit,
          offset: 0
        });
        const delta = trades.filter((item) => {
          if (client.tradeIds.has(item.tradeId)) {
            return false;
          }
          client.tradeIds.add(item.tradeId);
          return true;
        });
        trimSet(client.tradeIds, this.maxCacheSize);
        if (delta.length > 0) {
          this.sendReplayable(client, "event", "trades", delta, event.payload.market);
        }
      }

      if (client.subscriptions.balances.enabled) {
        await this.pushBalanceDelta(client as RealtimeClientState & { principal: GatewayPrincipal });
      }
      if (client.subscriptions.positions.enabled) {
        await this.pushPositionDelta(client as RealtimeClientState & { principal: GatewayPrincipal });
      }
    }
  }

  private async handleWalletNotificationEvent(
    event: WalletNotificationCreatedEvent
  ): Promise<void> {
    const userId = readStringField(event.payload, "userId");
    if (!userId) {
      return;
    }

    for (const client of this.clients.values()) {
      if (!client.principal || client.principal.userId !== userId) {
        continue;
      }

      if (event.eventType === "wallet.notification.created" && client.subscriptions.notifications.enabled) {
        const notifications = await this.apiGatewayHttpService.listWalletNotifications(
          client.principal,
          {
            limit: this.snapshotLimit,
            offset: 0
          }
        );
        const delta = notifications.items.filter((item) => {
          const notificationId = readStringField(item, "notificationId");
          if (!notificationId || client.notificationIds.has(notificationId)) {
            return false;
          }
          client.notificationIds.add(notificationId);
          return true;
        });
        trimSet(client.notificationIds, this.maxCacheSize);
        if (delta.length > 0) {
          this.sendReplayable(client, "event", "notifications", delta);
          this.sendAccountEvents(client, "notification", delta);
        }
      }

      if (event.eventType === "wallet.deposit.updated" && client.subscriptions.deposits.enabled) {
        await this.pushDepositDelta(client as RealtimeClientState & { principal: GatewayPrincipal });
      }

      if (
        event.eventType === "wallet.withdrawal.updated" &&
        client.subscriptions.withdrawals.enabled
      ) {
        await this.pushWithdrawalDelta(
          client as RealtimeClientState & { principal: GatewayPrincipal }
        );
      }

      if (client.subscriptions.balances.enabled) {
        await this.pushBalanceDelta(client as RealtimeClientState & { principal: GatewayPrincipal });
      }
      if (client.subscriptions.positions.enabled) {
        await this.pushPositionDelta(client as RealtimeClientState & { principal: GatewayPrincipal });
      }
    }
  }

  private async authenticate(message: RealtimeAuthMessage): Promise<GatewayPrincipal> {
    if (message.token) {
      return this.apiGatewayHttpService.authenticateCustomerSession(message.token);
    }

    if (message.apiKey && message.timestamp && message.nonce && message.signature) {
      return this.apiGatewayHttpService.authenticateApiKey({
        apiKey: message.apiKey,
        timestamp: message.timestamp,
        nonce: message.nonce,
        signature: message.signature,
        method: "GET",
        url: this.path
      });
    }

    throw new Error(
      "Provide a session token or API key signature to authenticate the realtime connection"
    );
  }

  private assertAuthenticated(client: RealtimeClientState): asserts client is RealtimeClientState & {
    principal: GatewayPrincipal;
  } {
    if (!client.principal) {
      throw new Error("Authenticate before subscribing to realtime channels");
    }
  }

  private updateSubscriptions(
    client: RealtimeClientState,
    channels: RealtimeChannel[],
    enabled: boolean,
    market?: SpotMarket
  ): void {
    for (const channel of channels) {
      const state = client.subscriptions[channel];
      if (!state) {
        continue;
      }

      state.enabled = enabled;
      if (enabled && (channel === "orders" || channel === "trades" || channel === "positions")) {
        state.market = market;
      }
      if (!enabled) {
        delete state.market;
      }
    }
  }

  private async pushSnapshot(
    client: RealtimeClientState,
    channels: RealtimeChannel[],
    marketOverride?: SpotMarket
  ): Promise<void> {
    await Promise.all(
      channels.map(async (channel) => {
        switch (channel) {
          case "orders": {
            const items = await this.apiGatewayHttpService.listOrders(client.principal!, {
              market: marketOverride ?? client.subscriptions.orders.market,
              limit: this.snapshotLimit,
              offset: 0
            });
            for (const item of items) {
              client.orderVersions.set(item.orderId, orderVersion(item));
            }
            trimMap(client.orderVersions, this.maxCacheSize);
            this.sendReplayable(
              client,
              "snapshot",
              channel,
              items,
              (marketOverride ?? client.subscriptions.orders.market) as SpotMarket | undefined
            );
            return;
          }
          case "trades": {
            const items = await this.apiGatewayHttpService.listTrades(client.principal!, {
              market: marketOverride ?? client.subscriptions.trades.market,
              limit: this.snapshotLimit,
              offset: 0
            });
            for (const item of items) {
              client.tradeIds.add(item.tradeId);
            }
            trimSet(client.tradeIds, this.maxCacheSize);
            this.sendReplayable(
              client,
              "snapshot",
              channel,
              items,
              (marketOverride ?? client.subscriptions.trades.market) as SpotMarket | undefined
            );
            return;
          }
          case "notifications": {
            const items = await this.apiGatewayHttpService.listWalletNotifications(
              client.principal!,
              {
                limit: this.snapshotLimit,
                offset: 0
              }
            );
            for (const item of items.items) {
              const notificationId = readStringField(item, "notificationId");
              if (notificationId) {
                client.notificationIds.add(notificationId);
              }
            }
            trimSet(client.notificationIds, this.maxCacheSize);
            this.sendReplayable(client, "snapshot", channel, items.items);
            return;
          }
          case "balances": {
            const items = await this.apiGatewayHttpService.listBalances(client.principal!, {
              limit: this.snapshotLimit,
              offset: 0
            });
            for (const item of items.items) {
              client.balanceVersions.set(buildBalanceKey(item), balanceVersion(item));
            }
            trimMap(client.balanceVersions, this.maxCacheSize);
            this.sendReplayable(client, "snapshot", channel, items.items);
            return;
          }
          case "deposits": {
            const items = await this.apiGatewayHttpService.listDeposits(client.principal!, {
              limit: this.snapshotLimit,
              offset: 0
            });
            for (const item of items.items) {
              client.depositVersions.set(buildDepositKey(item), depositVersion(item));
            }
            trimMap(client.depositVersions, this.maxCacheSize);
            this.sendReplayable(client, "snapshot", channel, items.items);
            return;
          }
          case "withdrawals": {
            const items = await this.apiGatewayHttpService.listWithdrawals(client.principal!, {
              limit: this.snapshotLimit,
              offset: 0
            });
            for (const item of items.items) {
              client.withdrawalVersions.set(buildWithdrawalKey(item), withdrawalVersion(item));
            }
            trimMap(client.withdrawalVersions, this.maxCacheSize);
            this.sendReplayable(client, "snapshot", channel, items.items);
            return;
          }
          case "positions": {
            const items = await this.buildPositionSnapshots(
              client.principal!,
              marketOverride ?? client.subscriptions.positions.market
            );
            for (const item of items) {
              client.positionVersions.set(
                readStringField(item, "market") ?? "unknown",
                positionVersion(item)
              );
            }
            trimMap(client.positionVersions, this.maxCacheSize);
            this.sendReplayable(
              client,
              "snapshot",
              channel,
              items,
              (marketOverride ?? client.subscriptions.positions.market) as SpotMarket | undefined
            );
            return;
          }
          case "account_events": {
            const items = await this.buildAccountEventSnapshot(client.principal!);
            this.sendReplayable(client, "snapshot", channel, items);
            return;
          }
        }
      })
    );
  }

  private async pushBalanceDelta(
    client: RealtimeClientState & { principal: GatewayPrincipal }
  ): Promise<void> {
    const balances = await this.apiGatewayHttpService.listBalances(client.principal, {
      limit: this.snapshotLimit,
      offset: 0
    });

    const delta = balances.items.filter((item) => {
      const key = buildBalanceKey(item);
      const version = balanceVersion(item);
      const previousVersion = client.balanceVersions.get(key);
      client.balanceVersions.set(key, version);
      return previousVersion !== version;
    });
    trimMap(client.balanceVersions, this.maxCacheSize);

    if (delta.length > 0) {
      this.sendReplayable(client, "event", "balances", delta);
      this.sendAccountEvents(client, "balance", delta);
    }
  }

  private async pushDepositDelta(
    client: RealtimeClientState & { principal: GatewayPrincipal }
  ): Promise<void> {
    const deposits = await this.apiGatewayHttpService.listDeposits(client.principal, {
      limit: this.snapshotLimit,
      offset: 0
    });

    const delta = deposits.items.filter((item) => {
      const key = buildDepositKey(item);
      const version = depositVersion(item);
      const previousVersion = client.depositVersions.get(key);
      client.depositVersions.set(key, version);
      return previousVersion !== version;
    });
    trimMap(client.depositVersions, this.maxCacheSize);

    if (delta.length > 0) {
      this.sendReplayable(client, "event", "deposits", delta);
      this.sendAccountEvents(client, "deposit", delta);
    }
  }

  private async pushWithdrawalDelta(
    client: RealtimeClientState & { principal: GatewayPrincipal }
  ): Promise<void> {
    const withdrawals = await this.apiGatewayHttpService.listWithdrawals(client.principal, {
      limit: this.snapshotLimit,
      offset: 0
    });

    const delta = withdrawals.items.filter((item) => {
      const key = buildWithdrawalKey(item);
      const version = withdrawalVersion(item);
      const previousVersion = client.withdrawalVersions.get(key);
      client.withdrawalVersions.set(key, version);
      return previousVersion !== version;
    });
    trimMap(client.withdrawalVersions, this.maxCacheSize);

    if (delta.length > 0) {
      this.sendReplayable(client, "event", "withdrawals", delta);
      this.sendAccountEvents(client, "withdrawal", delta);
    }
  }

  private async pushPositionDelta(
    client: RealtimeClientState & { principal: GatewayPrincipal }
  ): Promise<void> {
    const positions = await this.buildPositionSnapshots(
      client.principal,
      client.subscriptions.positions.market
    );

    const delta = positions.filter((item) => {
      const key = readStringField(item, "market") ?? "unknown";
      const version = positionVersion(item);
      const previousVersion = client.positionVersions.get(key);
      client.positionVersions.set(key, version);
      return previousVersion !== version;
    });
    trimMap(client.positionVersions, this.maxCacheSize);

    if (delta.length > 0) {
      this.sendReplayable(
        client,
        "event",
        "positions",
        delta,
        client.subscriptions.positions.market as SpotMarket | undefined
      );
    }
  }

  private async buildPositionSnapshots(
    principal: GatewayPrincipal,
    marketOverride?: SpotMarket
  ): Promise<Array<Record<string, unknown>>> {
    const markets = marketOverride
      ? [marketOverride].filter((market) => isSpotMarket(market))
      : listSpotMarkets();
    const [balances, openOrders] = await Promise.all([
      this.apiGatewayHttpService.listBalances(principal, {
        limit: this.snapshotLimit,
        offset: 0
      }),
      this.apiGatewayHttpService.listOrders(principal, {
        market: marketOverride,
        limit: Math.max(this.snapshotLimit * 2, 100),
        offset: 0
      })
    ]);

    const balanceByAsset = new Map<string, Record<string, unknown>>();
    for (const balance of balances.items) {
      const assetCode = readStringField(balance, "assetCode");
      if (assetCode) {
        balanceByAsset.set(assetCode, balance);
      }
    }

    return markets.flatMap((market) => {
      const definition = getSpotMarketDefinition(market);
      if (!definition) {
        return [];
      }
      const marketOrders = openOrders.filter(
        (order) =>
          readStringField(order as unknown as Record<string, unknown>, "market") === market &&
          isOpenOrderStatus(readStringField(order as unknown as Record<string, unknown>, "status")) &&
          isPositiveStringAmount(
            readStringField(order as unknown as Record<string, unknown>, "restingQuantity")
          )
      );
      const baseBalance = balanceByAsset.get(definition.baseAsset) ?? {};
      const quoteBalance = balanceByAsset.get(definition.quoteAsset) ?? {};
      const openBuyQuantity = marketOrders
        .filter((order) => readStringField(order as unknown as Record<string, unknown>, "side") === "buy")
        .reduce(
          (total, order) =>
            addAmounts(
              total,
              readStringField(order as unknown as Record<string, unknown>, "restingQuantity") ?? "0"
            ),
          "0"
        );
      const openSellQuantity = marketOrders
        .filter((order) => readStringField(order as unknown as Record<string, unknown>, "side") === "sell")
        .reduce(
          (total, order) =>
            addAmounts(
              total,
              readStringField(order as unknown as Record<string, unknown>, "restingQuantity") ?? "0"
            ),
          "0"
        );
      const markPrice =
        marketOrders[0] &&
        readStringField(marketOrders[0] as unknown as Record<string, unknown>, "price");

      return {
        market,
        baseAsset: definition.baseAsset,
        quoteAsset: definition.quoteAsset,
        baseAvailable: readStringField(baseBalance, "available") ?? "0",
        baseLocked: readStringField(baseBalance, "locked") ?? "0",
        quoteAvailable: readStringField(quoteBalance, "available") ?? "0",
        quoteLocked: readStringField(quoteBalance, "locked") ?? "0",
        openBuyQuantity,
        openSellQuantity,
        openOrderCount: marketOrders.length,
        markPrice: markPrice ?? "0",
        updatedAt: latestUpdatedAt([
          readStringField(baseBalance, "updatedAt"),
          readStringField(quoteBalance, "updatedAt"),
          ...marketOrders.map((order) =>
            readStringField(order as unknown as Record<string, unknown>, "updatedAt")
          )
        ])
      };
    });
  }

  private async buildAccountEventSnapshot(
    principal: GatewayPrincipal
  ): Promise<Array<Record<string, unknown>>> {
    const [balances, deposits, withdrawals, notifications] = await Promise.all([
      this.apiGatewayHttpService.listBalances(principal, {
        limit: this.snapshotLimit,
        offset: 0
      }),
      this.apiGatewayHttpService.listDeposits(principal, {
        limit: this.snapshotLimit,
        offset: 0
      }),
      this.apiGatewayHttpService.listWithdrawals(principal, {
        limit: this.snapshotLimit,
        offset: 0
      }),
      this.apiGatewayHttpService.listWalletNotifications(principal, {
        limit: this.snapshotLimit,
        offset: 0
      })
    ]);

    return [
      ...balances.items.map((item) => wrapAccountEvent("balance", item)),
      ...deposits.items.map((item) => wrapAccountEvent("deposit", item)),
      ...withdrawals.items.map((item) => wrapAccountEvent("withdrawal", item)),
      ...notifications.items.map((item) => wrapAccountEvent("notification", item))
    ];
  }

  private sendAccountEvents(
    client: RealtimeClientState,
    entityType: "balance" | "deposit" | "withdrawal" | "notification",
    items: Array<Record<string, unknown>>
  ): void {
    if (!client.subscriptions.account_events.enabled || items.length === 0) {
      return;
    }

    this.sendReplayable(
      client,
      "event",
      "account_events",
      items.map((item) => wrapAccountEvent(entityType, item))
    );
  }

  private sendReplayable(
    client: RealtimeClientState,
    type: "snapshot" | "event",
    channel: RealtimeChannel,
    items: unknown[],
    market?: SpotMarket
  ): void {
    const payload = {
      type,
      channel,
      sequence: this.nextSequence++,
      items,
      sentAt: new Date().toISOString()
    };
    this.send(client, payload);

    if (client.principal) {
      this.appendReplayFrame({
        sequence: payload.sequence,
        userId: client.principal.userId,
        channel,
        market,
        payload
      });
    }
  }

  private appendReplayFrame(frame: RealtimeReplayFrame): void {
    const buffer = this.replayBuffers.get(frame.userId) ?? [];
    buffer.push(frame);
    while (buffer.length > this.replayBufferSize) {
      buffer.shift();
    }
    this.replayBuffers.set(frame.userId, buffer);
  }

  private async resume(
    client: RealtimeClientState & { principal: GatewayPrincipal },
    message: RealtimeResumeMessage
  ): Promise<void> {
    const channels =
      message.channels && message.channels.length > 0
        ? message.channels
        : summarizeSubscriptions(client).map((item) => item.channel as RealtimeChannel);
    const latestSequence = this.nextSequence - 1;
    const buffer = this.replayBuffers.get(client.principal.userId) ?? [];
    const earliestSequence = buffer[0]?.sequence;

    if (!Number.isInteger(message.lastSequence) || message.lastSequence === undefined || message.lastSequence < 0) {
      await this.pushSnapshot(client, channels, message.market);
      this.send(client, {
        type: "resumed",
        mode: "snapshot",
        latestSequence: this.nextSequence - 1,
        sentAt: new Date().toISOString()
      });
      return;
    }

    if (!earliestSequence || message.lastSequence < earliestSequence - 1) {
      this.send(client, {
        type: "resync_required",
        latestSequence,
        earliestSequence: earliestSequence ?? latestSequence,
        sentAt: new Date().toISOString()
      });
      await this.pushSnapshot(client, channels, message.market);
      this.send(client, {
        type: "resumed",
        mode: "snapshot",
        latestSequence: this.nextSequence - 1,
        sentAt: new Date().toISOString()
      });
      return;
    }

    const replayFrames = buffer.filter(
      (frame) =>
        frame.sequence > message.lastSequence! &&
        channels.includes(frame.channel) &&
        (!message.market || !frame.market || frame.market === message.market)
    );
    for (const frame of replayFrames) {
      this.send(client, frame.payload);
    }

    this.send(client, {
      type: "resumed",
      mode: "replay",
      replayedCount: replayFrames.length,
      latestSequence,
      sentAt: new Date().toISOString()
    });
  }

  private sendAuthenticated(client: RealtimeClientState): void {
    this.send(client, {
      type: "authenticated",
      authType: client.principal?.authType,
      userId: client.principal?.userId,
      resumeSupported: true,
      latestSequence: this.nextSequence - 1,
      sentAt: new Date().toISOString()
    });
  }

  /** Close the socket when the session expires; remember the token for re-introspection. */
  private trackSession(client: RealtimeClientState, auth: RealtimeAuthMessage): void {
    clearTimeout(client.expiryTimer);
    client.sessionToken = auth.token;
    const remaining = msUntilExpiry(client.principal?.expiresAt);
    if (remaining === undefined) {
      return;
    }
    // setTimeout overflows above ~24.8 days; a re-check on the next reauth tick covers longer sessions.
    client.expiryTimer = setTimeout(() => {
      this.send(client, { type: "error", message: "Session expired", sentAt: new Date().toISOString() });
      client.socket.close(WS_CLOSE_SESSION_EXPIRED, "Session expired");
    }, Math.min(remaining, 2_147_000_000));
    client.expiryTimer.unref();
  }

  /** Periodically re-introspect session tokens so logout / freeze also ends live sockets. */
  private async reauthenticateSessions(): Promise<void> {
    for (const client of this.clients.values()) {
      if (!client.sessionToken || !client.principal) {
        continue;
      }
      try {
        client.principal = await this.apiGatewayHttpService.authenticateCustomerSession(client.sessionToken);
      } catch (error) {
        this.send(client, {
          type: "error",
          message: `Session is no longer valid: ${readErrorMessage(error)}`,
          sentAt: new Date().toISOString()
        });
        client.socket.close(WS_CLOSE_SESSION_REVOKED, "Session revoked");
      }
    }
  }

  private send(client: RealtimeClientState, payload: Record<string, unknown>): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(payload));
  }

  private sendError(client: RealtimeClientState, error: unknown): void {
    this.send(client, {
      type: "error",
      message: readErrorMessage(error),
      sentAt: new Date().toISOString()
    });
  }
}

function summarizeSubscriptions(client: RealtimeClientState) {
  return Object.entries(client.subscriptions)
    .filter(([, state]) => state.enabled)
    .map(([channel, state]) => ({
      channel,
      market: state.market
    }));
}

function orderVersion(order: {
  updatedAt: string;
  status: string;
  filledQuantity: string;
  restingQuantity?: string;
}): string {
  return `${order.updatedAt}:${order.status}:${order.filledQuantity}:${order.restingQuantity ?? "0"}`;
}

function trimSet(values: Set<string>, maxSize: number): void {
  while (values.size > maxSize) {
    const first = values.values().next().value;
    if (!first) {
      return;
    }

    values.delete(first);
  }
}

function trimMap(values: Map<string, string>, maxSize: number): void {
  while (values.size > maxSize) {
    const first = values.keys().next().value;
    if (!first) {
      return;
    }

    values.delete(first);
  }
}

function readStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildBalanceKey(record: Record<string, unknown>): string {
  return `${readStringField(record, "accountId") ?? "unknown"}:${readStringField(record, "assetCode") ?? "unknown"}`;
}

function balanceVersion(record: Record<string, unknown>): string {
  return [
    readStringField(record, "updatedAt") ?? "",
    readStringField(record, "available") ?? "",
    readStringField(record, "locked") ?? "",
    readStringField(record, "total") ?? ""
  ].join(":");
}

function buildDepositKey(record: Record<string, unknown>): string {
  return readStringField(record, "depositId") ?? "unknown";
}

function depositVersion(record: Record<string, unknown>): string {
  return [
    readStringField(record, "updatedAt") ?? "",
    readStringField(record, "status") ?? "",
    readStringField(record, "confirmations") ?? "",
    readStringField(record, "ledgerJournalId") ?? ""
  ].join(":");
}

function buildWithdrawalKey(record: Record<string, unknown>): string {
  return readStringField(record, "withdrawalId") ?? "unknown";
}

function withdrawalVersion(record: Record<string, unknown>): string {
  return [
    readStringField(record, "updatedAt") ?? "",
    readStringField(record, "status") ?? "",
    readStringField(record, "reviewStatus") ?? "",
    readStringField(record, "txHash") ?? "",
    readStringField(record, "custodyRequestId") ?? ""
  ].join(":");
}

function positionVersion(record: Record<string, unknown>): string {
  return [
    readStringField(record, "updatedAt") ?? "",
    readStringField(record, "baseAvailable") ?? "",
    readStringField(record, "baseLocked") ?? "",
    readStringField(record, "quoteAvailable") ?? "",
    readStringField(record, "quoteLocked") ?? "",
    readStringField(record, "openBuyQuantity") ?? "",
    readStringField(record, "openSellQuantity") ?? "",
    readStringField(record, "markPrice") ?? ""
  ].join(":");
}

function wrapAccountEvent(
  entityType: "balance" | "deposit" | "withdrawal" | "notification",
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    entityType,
    entityId:
      readStringField(payload, "notificationId") ??
      readStringField(payload, "depositId") ??
      readStringField(payload, "withdrawalId") ??
      buildBalanceKey(payload),
    updatedAt: readStringField(payload, "updatedAt"),
    payload
  };
}

function latestUpdatedAt(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? new Date(0).toISOString();
}

function isOpenOrderStatus(status: string | undefined): boolean {
  return (
    status === "accepted" ||
    status === "partially_filled" ||
    status === "recovery_pending"
  );
}

function isPositiveStringAmount(amount: string | undefined): boolean {
  if (!amount) {
    return false;
  }

  try {
    return compareAmounts(amount, "0") > 0;
  } catch {
    return false;
  }
}

function readHandshakeAuth(rawUrl: string, authorization?: string): RealtimeAuthMessage | null {
  const url = new URL(rawUrl, "ws://127.0.0.1");
  // The trader-web BFF proxies browser sockets and attaches the cookie session
  // as a bearer header, so the token never appears in a URL.
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
  const token = bearer || (url.searchParams.get("token") ?? undefined);
  const apiKey = url.searchParams.get("apiKey") ?? undefined;
  const timestamp = url.searchParams.get("timestamp") ?? undefined;
  const nonce = url.searchParams.get("nonce") ?? undefined;
  const signature = url.searchParams.get("signature") ?? undefined;

  if (!token && !apiKey && !timestamp && !signature) {
    return null;
  }

  return {
    type: "auth",
    token,
    apiKey,
    timestamp,
    nonce,
    signature
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown realtime error";
}

export function createRealtimeApiKeySignature(params: {
  secret: string;
  timestamp: string;
  nonce: string;
  path?: string;
}): string {
  return createApiKeySignature({
    secret: params.secret,
    method: "GET",
    url: params.path ?? "/api/v1/gateway/realtime",
    timestamp: params.timestamp,
    nonce: params.nonce
  });
}
