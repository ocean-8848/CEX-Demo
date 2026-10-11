import type { WalletNotificationTransport } from "../domain/notification-transport.js";
import type { WalletNotificationRecord } from "../domain/types.js";

export class ConsoleWalletNotificationTransport implements WalletNotificationTransport {
  async deliver(notification: WalletNotificationRecord): Promise<{
    receipt?: Record<string, unknown>;
  }> {
    const deliveredAt = new Date().toISOString();

    process.stdout.write(
      `${JSON.stringify(
        {
          type: "wallet.notification.delivered",
          notificationId: notification.notificationId,
          userId: notification.userId,
          withdrawalId: notification.withdrawalId,
          channel: notification.channel,
          eventType: notification.eventType,
          deliveredAt
        },
        null,
        2
      )}\n`
    );

    return {
      receipt: {
        transport: "console",
        deliveredAt
      }
    };
  }
}
