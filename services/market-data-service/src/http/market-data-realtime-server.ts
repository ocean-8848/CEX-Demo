import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import type { SpotMarket, TradingEvent } from "@web3-cex/domain";
import { Logger } from "@nestjs/common";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { MarketDataHttpService } from "./market-data-http.service.js";

type Channel = "ticker" | "depth" | "trades";

interface ClientState {
  connectionId: string;
  socket: WebSocket;
  market?: SpotMarket;
  channels: Set<Channel>;
}

interface SubscribeMessage {
  type: "subscribe" | "unsubscribe" | "snapshot";
  channels?: Channel[];
  market?: SpotMarket;
}

interface PingMessage {
  type: "ping";
}

type ClientMessage = SubscribeMessage | PingMessage;

export class MarketDataRealtimeServer {
  private readonly logger = new Logger(MarketDataRealtimeServer.name);
  private readonly path: string;
  private readonly clients = new Map<string, ClientState>();
  private webSocketServer?: WebSocketServer;
  private detachListener?: () => void;

  constructor(private readonly marketDataHttpService: MarketDataHttpService) {
    this.path = process.env.MARKET_DATA_WS_PATH ?? "/api/v1/market-data/ws";
  }

  attach(server: HttpServer): void {
    if (this.webSocketServer) {
      return;
    }

    this.webSocketServer = new WebSocketServer({
      server,
      path: this.path
    });
    this.webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      void this.handleConnection(socket, request);
    });
    this.detachListener = this.marketDataHttpService.onTradingEvent(async (event) => {
      await this.pushTradingEvent(event);
    });
  }

  async close(): Promise<void> {
    this.detachListener?.();
    this.detachListener = undefined;

    for (const client of this.clients.values()) {
      client.socket.close();
    }
    this.clients.clear();

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

  private async handleConnection(socket: WebSocket, _request: IncomingMessage): Promise<void> {
    const client: ClientState = {
      connectionId: randomUUID(),
      socket,
      channels: new Set()
    };
    this.clients.set(client.connectionId, client);

    socket.on("message", (raw: RawData) => {
      void this.handleMessage(client, raw);
    });
    socket.on("close", () => {
      this.clients.delete(client.connectionId);
    });
    socket.on("error", (error: Error) => {
      this.logger.warn(`market-data websocket error: ${readErrorMessage(error)}`);
      this.clients.delete(client.connectionId);
    });

    this.send(client, {
      type: "ready",
      connectionId: client.connectionId,
      path: this.path,
      sentAt: new Date().toISOString()
    });
  }

  private async handleMessage(client: ClientState, raw: RawData): Promise<void> {
    let message: ClientMessage;

    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      this.send(client, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Message must be JSON"
      });
      return;
    }

    if (message.type === "ping") {
      this.send(client, {
        type: "pong",
        sentAt: new Date().toISOString()
      });
      return;
    }

    if (message.market) {
      client.market = message.market;
    }

    if (!client.market) {
      this.send(client, {
        type: "error",
        code: "MARKET_REQUIRED",
        message: "market is required before subscribing"
      });
      return;
    }

    const channels: Channel[] =
      message.channels && message.channels.length > 0
        ? message.channels
        : (["ticker", "depth", "trades"] as Channel[]);
    if (message.type === "subscribe") {
      for (const channel of channels) {
        client.channels.add(channel);
      }
    }
    if (message.type === "unsubscribe") {
      for (const channel of channels) {
        client.channels.delete(channel);
      }
    }

    await this.pushSnapshot(client, channels, message.type);
  }

  private async pushTradingEvent(event: TradingEvent): Promise<void> {
    const market = event.payload.market;

    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        if (!client.market || client.market !== market || client.channels.size === 0) {
          return;
        }

        await this.pushSnapshot(client, [...client.channels], "event");
      })
    );
  }

  private async pushSnapshot(
    client: ClientState,
    channels: Channel[],
    mode: "subscribe" | "unsubscribe" | "snapshot" | "event"
  ): Promise<void> {
    const market = client.market;
    if (!market) {
      return;
    }

    for (const channel of channels) {
      switch (channel) {
        case "ticker":
          this.send(client, {
            type: mode === "event" ? "event" : "snapshot",
            channel,
            market,
            item: await this.marketDataHttpService.getTicker(market),
            sentAt: new Date().toISOString()
          });
          break;
        case "depth":
          this.send(client, {
            type: mode === "event" ? "event" : "snapshot",
            channel,
            market,
            item: await this.marketDataHttpService.getDepth(market),
            sentAt: new Date().toISOString()
          });
          break;
        case "trades":
          this.send(client, {
            type: mode === "event" ? "event" : "snapshot",
            channel,
            market,
            items: await this.marketDataHttpService.getRecentTrades(market),
            sentAt: new Date().toISOString()
          });
          break;
      }
    }
  }

  private send(client: ClientState, payload: Record<string, unknown>): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(payload));
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown market-data realtime error";
}
