import test from "node:test";
import assert from "node:assert/strict";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import { WalletNotificationDispatcher } from "../application/wallet-notification-dispatcher.js";
import type { WalletNotificationTransport } from "../domain/notification-transport.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

function createLedgerClient(): LedgerClient {
  return {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async consumeBalance() {
      return {
        lockId: "lock-1"
      };
    }
  };
}

function createCustodyClient(): CustodyClient {
  return {
    async createTransfer() {
      return {
        custodyRequestId: "custody-request-1",
        providerName: "mock-custody",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      };
    }
  };
}

test("wallet notification dispatcher marks notifications delivered", async () => {
  const repository = new InMemoryWalletRepository();
  const service = new WalletApplicationService(
    repository,
    createLedgerClient(),
    createCustodyClient(),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: () => "withdrawal-notify-1"
    }
  );

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "1"
  });

  const deliveredNotificationIds: string[] = [];
  const transport: WalletNotificationTransport = {
    async deliver(notification) {
      deliveredNotificationIds.push(notification.notificationId);
      return {
        receipt: {
          transport: "test"
        }
      };
    }
  };
  const dispatcher = new WalletNotificationDispatcher(repository, transport, {
    now: () => new Date("2026-03-08T00:00:00.000Z")
  });

  const result = await dispatcher.deliverPending();
  const notifications = await service.listWalletNotifications({
    userId: "user-1",
    limit: 10,
    offset: 0
  });

  assert.equal(result.deliveredCount, 1);
  assert.deepEqual(result.notificationIds, deliveredNotificationIds);
  assert.equal(notifications.items[0]?.status, "delivered");
  assert.equal(notifications.items[0]?.deliveryAttempts, 1);
  assert.equal(notifications.items[0]?.deliveryReceipt.transport, "test");
});

test("wallet notification dispatcher retries and then marks terminal failures", async () => {
  const repository = new InMemoryWalletRepository();
  const service = new WalletApplicationService(
    repository,
    createLedgerClient(),
    createCustodyClient(),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: () => "withdrawal-notify-2"
    }
  );

  await service.requestWithdrawal({
    userId: "user-2",
    ledgerAccountId: "ledger-account-2",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "12",
    fee: "1"
  });

  const transport: WalletNotificationTransport = {
    async deliver() {
      throw new Error("notification transport failure");
    }
  };

  const firstDispatcher = new WalletNotificationDispatcher(repository, transport, {
    now: () => new Date("2026-03-08T00:00:00.000Z"),
    maxAttempts: 2,
    retryDelayMs: 1000
  });
  const firstResult = await firstDispatcher.deliverPending();
  assert.equal(firstResult.retriedCount, 1);

  const pendingNotifications = await service.listWalletNotifications({
    userId: "user-2",
    limit: 10,
    offset: 0
  });
  assert.equal(pendingNotifications.items[0]?.status, "pending");
  assert.equal(pendingNotifications.items[0]?.deliveryAttempts, 1);
  assert.equal(
    pendingNotifications.items[0]?.nextAttemptAt,
    "2026-03-08T00:00:01.000Z"
  );

  const secondDispatcher = new WalletNotificationDispatcher(repository, transport, {
    now: () => new Date("2026-03-08T00:00:01.000Z"),
    maxAttempts: 2,
    retryDelayMs: 1000
  });
  const secondResult = await secondDispatcher.deliverPending();
  assert.equal(secondResult.failedCount, 1);

  const failedNotifications = await service.listWalletNotifications({
    userId: "user-2",
    limit: 10,
    offset: 0
  });
  assert.equal(failedNotifications.items[0]?.status, "failed");
  assert.equal(failedNotifications.items[0]?.deliveryAttempts, 2);
  assert.equal(
    failedNotifications.items[0]?.lastError,
    "notification transport failure"
  );
});
