declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { Server as HttpServer } from "node:http";

  export class WebSocket extends EventEmitter {
    send(data: string): void;
    close(): void;
    on(event: "message", listener: (data: Buffer) => void): this;
    on(event: "close", listener: () => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    clients: Set<WebSocket>;
    constructor(options: {
      server: HttpServer;
      path?: string;
    });
    on(event: "connection", listener: (socket: WebSocket, request: import("node:http").IncomingMessage) => void): this;
    close(callback: (error?: Error) => void): void;
  }
}
