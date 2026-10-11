import type { WalletNotificationRecord } from "./types.js";

export interface WalletNotificationTransport {
  deliver(notification: WalletNotificationRecord): Promise<{
    receipt?: Record<string, unknown>;
  }>;
}
