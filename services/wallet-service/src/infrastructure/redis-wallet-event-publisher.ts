import { createClient, type RedisClientType } from "redis";

import type { WalletEventPublisher } from "../domain/event-publisher.js";
import type {
  DepositRecord,
  WalletNotificationRecord,
  WithdrawalRecord
} from "../domain/types.js";

export function createWalletRedisClient(url: string): RedisClientType {
  return createClient({ url });
}

export class RedisWalletEventPublisher implements WalletEventPublisher {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly channel: string
  ) {}

  async publishDepositUpdated(deposit: DepositRecord): Promise<void> {
    await this.publish({
      eventType: "wallet.deposit.updated",
      payload: toRecord(deposit)
    });
  }

  async publishWithdrawalUpdated(withdrawal: WithdrawalRecord): Promise<void> {
    await this.publish({
      eventType: "wallet.withdrawal.updated",
      payload: toRecord(withdrawal)
    });
  }

  async publishNotificationCreated(notification: WalletNotificationRecord): Promise<void> {
    await this.publish({
      eventType: "wallet.notification.created",
      payload: toRecord(notification)
    });
  }

  async close(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.quit();
    }
  }

  private async publish(event: {
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.redisClient.publish(this.channel, JSON.stringify(event));
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
