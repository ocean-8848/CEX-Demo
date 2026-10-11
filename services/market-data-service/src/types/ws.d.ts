declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage, Server as HttpServer } from "node:http";

  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    send(data: string | Buffer): void;
    close(): void;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface WebSocketServerOptions {
    server: HttpServer;
    path?: string;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: WebSocketServerOptions);
    on(
      event: "connection",
      listener: (socket: WebSocket, request: IncomingMessage) => void
    ): this;
    close(callback?: (error?: Error) => void): void;
  }
}
