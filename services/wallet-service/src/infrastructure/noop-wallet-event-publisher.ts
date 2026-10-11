import type { WalletEventPublisher } from "../domain/event-publisher.js";
import type { WalletNotificationRecord } from "../domain/types.js";

export class NoopWalletEventPublisher implements WalletEventPublisher {
  async publishDepositUpdated(): Promise<void> {}
  async publishWithdrawalUpdated(): Promise<void> {}
  async publishNotificationCreated(_notification: WalletNotificationRecord): Promise<void> {}
}
