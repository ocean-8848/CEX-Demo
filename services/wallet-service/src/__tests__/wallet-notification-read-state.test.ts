import test from "node:test";
import assert from "node:assert/strict";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

const custodyClient: CustodyClient = {
  async createTransfer() {
    throw new Error("custody client should not be called");
  }
};

test("crediting a deposit creates one deposit.credited notification and read markers are user scoped", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      return { journalId: "journal-notify-1" };
    },
    async freezeBalance() {
      throw new Error("freezeBalance should not be called");
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const published: string[] = [];
  const service = new WalletApplicationService(
    repository,
    ledgerClient,
    custodyClient,
    {
      depositConfirmationThreshold: 2,
      now: () => new Date("2026-03-07T00:00:00.000Z")
    },
    undefined,
    {
      async publishDepositUpdated() {},
      async publishWithdrawalUpdated() {},
      async publishNotificationCreated(notification) {
        published.push(notification.eventType);
      }
    }
  );

  const address = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });
  const confirm = () =>
    service.confirmDeposit({
      network: "ethereum",
      txHash: "0xnotify",
      address: address.address,
      amount: "25",
      confirmations: 3
    });
  await confirm();
  // Replaying the indexer callback must not duplicate the notification.
  await confirm();

  const listed = await service.listWalletNotifications({ userId: "user-1" });
  assert.equal(listed.total, 1);
  const [notification] = listed.items;
  assert.equal(notification?.eventType, "deposit.credited");
  assert.equal(notification?.withdrawalId, undefined);
  assert.equal(typeof notification?.depositId, "string");
  assert.equal(notification?.payload.amount, "25");
  assert.equal(notification?.readAt, undefined);
  assert.deepEqual(published, ["deposit.credited"]);

  assert.deepEqual(await service.countUnreadWalletNotifications("user-1"), { unreadCount: 1 });
  assert.deepEqual(await service.countUnreadWalletNotifications("user-2"), { unreadCount: 0 });

  // Another user can neither mark nor probe this notification.
  await assert.rejects(
    service.markWalletNotificationsRead({
      userId: "user-2",
      notificationIds: [notification!.notificationId]
    }),
    (error: unknown) => (error as { code?: string }).code === "NOTIFICATION_NOT_FOUND"
  );
  // "Read all" of another user leaves it untouched.
  assert.equal((await service.markWalletNotificationsRead({ userId: "user-2" })).updated, 0);
  assert.deepEqual(await service.countUnreadWalletNotifications("user-1"), { unreadCount: 1 });

  const single = await service.markWalletNotificationsRead({
    userId: "user-1",
    notificationIds: [notification!.notificationId]
  });
  assert.equal(single.updated, 1);
  assert.equal(single.unreadCount, 0);
  const again = await service.markWalletNotificationsRead({
    userId: "user-1",
    notificationIds: [notification!.notificationId]
  });
  assert.equal(again.updated, 0, "marking read is idempotent");

  const unread = await service.listWalletNotifications({ userId: "user-1", readState: "unread" });
  assert.equal(unread.total, 0);
  const read = await service.listWalletNotifications({ userId: "user-1", readState: "read" });
  assert.equal(read.items[0]?.readAt, "2026-03-07T00:00:00.000Z");
});

test("markWalletNotificationsRead without ids marks every unread notification of the user only", async () => {
  const repository = new InMemoryWalletRepository();
  const base = {
    channel: "inbox" as const,
    status: "delivered" as const,
    subject: "s",
    body: "b",
    payload: {},
    deliveryAttempts: 1,
    deliveryReceipt: {}
  };
  await repository.saveWalletNotification({
    ...base,
    notificationId: "n-1",
    userId: "user-1",
    withdrawalId: "w-1",
    eventType: "withdrawal.requested",
    createdAt: "2026-03-07T00:00:01.000Z"
  });
  await repository.saveWalletNotification({
    ...base,
    notificationId: "n-2",
    userId: "user-1",
    withdrawalId: "w-1",
    eventType: "withdrawal.approved",
    createdAt: "2026-03-07T00:00:02.000Z"
  });
  await repository.saveWalletNotification({
    ...base,
    notificationId: "n-3",
    userId: "user-2",
    withdrawalId: "w-2",
    eventType: "withdrawal.requested",
    createdAt: "2026-03-07T00:00:03.000Z"
  });
  const service = new WalletApplicationService(
    repository,
    {} as LedgerClient,
    custodyClient,
    { now: () => new Date("2026-03-08T00:00:00.000Z") }
  );

  const result = await service.markWalletNotificationsRead({ userId: "user-1" });
  assert.equal(result.updated, 2);
  assert.equal(result.unreadCount, 0);
  assert.deepEqual(await service.countUnreadWalletNotifications("user-2"), { unreadCount: 1 });
});
