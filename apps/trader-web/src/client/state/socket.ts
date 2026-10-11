// A small reconnecting WebSocket wrapper with exponential backoff.
// Both realtime feeds (public market-data, private gateway) use it.

import { type FeedStatus } from "@web3-cex/web-ui";

export type { FeedStatus };

export interface ManagedSocketOptions {
  url: string;
  onOpen: (socket: ManagedSocket) => void;
  onMessage: (data: unknown, socket: ManagedSocket) => void;
  onStatus: (status: FeedStatus) => void;
  /**
   * Called when the server closes the socket; return true to stop reconnecting
   * (e.g. the gateway's 4001 session expired / 4003 session revoked).
   */
  onServerClose?: (code: number) => boolean;
}

export class ManagedSocket {
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: number | null = null;
  private closed = false;

  constructor(private readonly options: ManagedSocketOptions) {}

  connect(): void {
    this.closed = false;
    this.options.onStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retry = 0;
      this.options.onOpen(this);
    });
    socket.addEventListener("message", (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.options.onMessage(data, this);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (!this.closed && this.options.onServerClose?.(event.code)) {
        this.closed = true;
      }
      if (this.closed) {
        this.options.onStatus("offline");
        return;
      }
      this.retry += 1;
      this.options.onStatus("reconnecting");
      const delay = Math.min(1000 * 2 ** (this.retry - 1), 15_000);
      this.timer = window.setTimeout(() => this.connect(), delay);
    });
  }

  send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.options.onStatus("offline");
  }
}
