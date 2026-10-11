import type { WalletRepository } from "../domain/repository.js";
import type { WalletNotificationTransport } from "../domain/notification-transport.js";

interface DispatcherOptions {
  batchSize?: number;
  now?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class WalletNotificationDispatcher {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: WalletRepository,
    private readonly transport: WalletNotificationTransport,
    options: DispatcherOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
  }

  async deliverPending(limit = this.batchSize): Promise<{
    deliveredCount: number;
    retriedCount: number;
    failedCount: number;
    notificationIds: string[];
  }> {
    const attemptedAt = this.now().toISOString();
    const notifications = await this.repository.listDeliverableWalletNotifications(limit, attemptedAt);

    if (notifications.length === 0) {
      return {
        deliveredCount: 0,
        retriedCount: 0,
        failedCount: 0,
        notificationIds: []
      };
    }

    const deliveredIds: string[] = [];
    let retriedCount = 0;
    let failedCount = 0;

    for (const notification of notifications) {
      try {
        const result = await this.transport.deliver(notification);
        await this.repository.markWalletNotificationDelivered({
          notificationId: notification.notificationId,
          attemptedAt,
          deliveredAt: this.now().toISOString(),
          deliveryReceipt: result.receipt
        });
        deliveredIds.push(notification.notificationId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown notification error";
        const attempts = notification.deliveryAttempts + 1;

        if (attempts >= this.maxAttempts) {
          failedCount += 1;
          await this.repository.recordWalletNotificationFailure({
            notificationId: notification.notificationId,
            attemptedAt,
            errorMessage,
            failedAt: attemptedAt
          });
        } else {
          retriedCount += 1;
          await this.repository.recordWalletNotificationFailure({
            notificationId: notification.notificationId,
            attemptedAt,
            errorMessage,
            nextAttemptAt: new Date(
              this.now().getTime() + this.retryDelayMs * attempts
            ).toISOString()
          });
        }
      }
    }

    return {
      deliveredCount: deliveredIds.length,
      retriedCount,
      failedCount,
      notificationIds: deliveredIds
    };
  }
}
