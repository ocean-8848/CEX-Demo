import test from "node:test";
import assert from "node:assert/strict";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import type { IdentityClient } from "../domain/identity-client.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

test("createDepositAddress allocates address and target ledger account", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("ledger client should not be called");
    },
    async freezeBalance() {
      throw new Error("ledger client should not be called");
    },
    async releaseBalance() {
      throw new Error("ledger client should not be called");
    },
    async consumeBalance() {
      throw new Error("ledger client should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient);
  const address = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });

  assert.equal(address.userId, "user-1");
  assert.equal(address.ledgerAccountId, "ledger-account-1");
  assert.match(address.address, /^0x[0-9a-f]{40}$/);
});

test("listDepositAddresses returns filtered paginated wallet addresses", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("ledger client should not be called");
    },
    async freezeBalance() {
      throw new Error("ledger client should not be called");
    },
    async releaseBalance() {
      throw new Error("ledger client should not be called");
    },
    async consumeBalance() {
      throw new Error("ledger client should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: (() => {
      const timestamps = [
        "2026-03-07T00:00:00.000Z",
        "2026-03-07T00:00:01.000Z",
        "2026-03-07T00:00:02.000Z"
      ];
      let index = 0;
      return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0]!);
    })()
  });

  const first = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "ETH",
    network: "ethereum"
  });
  await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });

  const filtered = await service.listDepositAddresses({
    userId: "user-1",
    assetCode: "ETH",
    limit: 10,
    offset: 0
  });

  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.address, first.address);

  const paged = await service.listDepositAddresses({
    network: "ethereum",
    limit: 1,
    offset: 0
  });

  assert.equal(paged.total, 2);
  assert.equal(paged.items.length, 1);
});

test("confirmDeposit below threshold does not call ledger and stays confirming", async () => {
  const repository = new InMemoryWalletRepository();
  let ledgerCalls = 0;
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      ledgerCalls += 1;
      return {
        journalId: "journal-1"
      };
    },
    async freezeBalance() {
      throw new Error("freezeBalance should not be called");
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("releaseBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    depositConfirmationThreshold: 12,
    now: () => new Date("2026-03-07T00:00:00.000Z"),
    createId: (() => {
      let counter = 0;
      return () => `deposit-${++counter}`;
    })()
  });

  const address = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });

  const deposit = await service.confirmDeposit({
    network: "ethereum",
    txHash: "0xtx1",
    address: address.address,
    amount: "100",
    confirmations: 3
  });

  assert.equal(deposit.status, "confirming");
  assert.equal(ledgerCalls, 0);
});

test("confirmDeposit at threshold calls ledger and marks deposit credited", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      return {
        journalId: "journal-credited-1"
      };
    },
    async freezeBalance() {
      throw new Error("freezeBalance should not be called");
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("releaseBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    depositConfirmationThreshold: 12,
    now: () => new Date("2026-03-07T00:00:00.000Z"),
    createId: (() => {
      let counter = 0;
      return () => `deposit-${++counter}`;
    })()
  });

  const address = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });

  const deposit = await service.confirmDeposit({
    network: "ethereum",
    txHash: "0xtx2",
    address: address.address,
    amount: "150",
    confirmations: 12
  });

  assert.equal(deposit.status, "credited");
  assert.equal(deposit.ledgerJournalId, "journal-credited-1");
});

test("requestWithdrawal freezes balance and stores withdrawal record", async () => {
  const repository = new InMemoryWalletRepository();
  const publishedNotificationIds: string[] = [];
  const freezeCalls: string[] = [];
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance(command) {
      freezeCalls.push(`${command.accountId}:${command.amount}`);
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(
    repository,
    ledgerClient,
    custodyClient,
    {
      now: () => new Date("2026-03-07T01:02:03.000Z"),
      createId: () => "withdrawal-1"
    },
    undefined,
    {
      async publishDepositUpdated() {},
      async publishWithdrawalUpdated() {},
      async publishNotificationCreated(notification) {
        publishedNotificationIds.push(notification.notificationId);
      }
    }
  );

  const withdrawal = await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "100",
    fee: "2.5"
  });

  assert.equal(withdrawal.withdrawalId, "withdrawal-1");
  assert.equal(withdrawal.status, "requested");
  assert.equal(withdrawal.reviewStatus, "pending");
  assert.equal(withdrawal.frozenAmount, "102.5");
  assert.deepEqual(freezeCalls, ["ledger-account-1:102.5"]);

  const stored = await service.getWithdrawal("withdrawal-1");
  assert.equal(stored?.frozenAmount, "102.5");

  const auditLogs = await service.listWithdrawalAuditLogs({
    withdrawalId: "withdrawal-1",
    limit: 10,
    offset: 0
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.action, "requested");
  assert.equal(auditLogs.items[0]?.operatorId, "user-1");

  const notifications = await service.listWalletNotifications({
    userId: "user-1",
    withdrawalId: "withdrawal-1",
    limit: 10,
    offset: 0
  });
  assert.equal(notifications.total, 1);
  assert.equal(notifications.items[0]?.eventType, "withdrawal.requested");
  assert.equal(notifications.items[0]?.status, "pending");
  assert.equal(publishedNotificationIds.length, 1);
  assert.equal(publishedNotificationIds[0], notifications.items[0]?.notificationId);
});

test("listDeposits returns filtered paginated results", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      return {
        journalId: "journal-list-1"
      };
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
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    depositConfirmationThreshold: 2,
    now: (() => {
      const timestamps = [
        "2026-03-07T00:00:00.000Z",
        "2026-03-07T00:00:01.000Z",
        "2026-03-07T00:00:02.000Z",
        "2026-03-07T00:00:03.000Z"
      ];
      let index = 0;
      return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0]!);
    })(),
    createId: (() => {
      let counter = 0;
      return () => `deposit-list-${++counter}`;
    })()
  });

  const firstAddress = await service.createDepositAddress({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum"
  });

  const secondAddress = await service.createDepositAddress({
    userId: "user-2",
    ledgerAccountId: "ledger-account-2",
    assetCode: "USDT",
    // Asset/network pairs must exist in config/markets.json (USDT lives on the demo EVM chain).
    network: "ethereum"
  });

  await service.confirmDeposit({
    network: "ethereum",
    txHash: "0xdeposit-list-1",
    address: firstAddress.address,
    amount: "10",
    confirmations: 2
  });
  await service.confirmDeposit({
    network: "ethereum",
    txHash: "0xdeposit-list-2",
    address: secondAddress.address,
    amount: "20",
    confirmations: 1
  });

  const filtered = await service.listDeposits({
    userId: "user-1",
    status: "credited",
    limit: 10,
    offset: 0
  });

  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.depositId, "deposit-list-1");

  const paged = await service.listDeposits({
    limit: 1,
    offset: 0
  });

  assert.equal(paged.total, 2);
  assert.equal(paged.items.length, 1);
});

test("listWithdrawals and review queue expose pending review items", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
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
  const custodyClient: CustodyClient = {
    async createTransfer() {
      return {
        custodyRequestId: "custody-review-1",
        providerName: "mock-custody",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      };
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: (() => {
      const timestamps = [
        "2026-03-07T02:00:00.000Z",
        "2026-03-07T02:00:01.000Z",
        "2026-03-07T02:00:02.000Z",
        "2026-03-07T02:00:03.000Z"
      ];
      let index = 0;
      return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0]!);
    })(),
    createId: (() => {
      let counter = 0;
      return () => `withdrawal-list-${++counter}`;
    })()
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x5555555555555555555555555555555555555555",
    amount: "10",
    fee: "1"
  });
  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x6666666666666666666666666666666666666666",
    amount: "12",
    fee: "1"
  });
  await service.approveWithdrawal({
    withdrawalId: "withdrawal-list-2",
    reviewedBy: "operator-1"
  });

  const userWithdrawals = await service.listWithdrawals({
    userId: "user-1",
    limit: 10,
    offset: 0
  });

  assert.equal(userWithdrawals.total, 2);
  assert.equal(userWithdrawals.items[0]?.withdrawalId, "withdrawal-list-2");

  const reviewQueue = await service.listWithdrawalReviewQueue({
    network: "ethereum",
    limit: 10,
    offset: 0
  });

  assert.equal(reviewQueue.total, 1);
  assert.equal(reviewQueue.items[0]?.withdrawalId, "withdrawal-list-1");
  assert.equal(reviewQueue.items[0]?.reviewStatus, "pending");
});

test("withdrawal address book can create, list, whitelist and unwhitelist addresses", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
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
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: () => new Date("2026-03-07T09:00:00.000Z")
  });

  const created = await service.createWithdrawalAddressBookEntry({
    userId: "user-1",
    network: "ethereum",
    address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    label: "Primary wallet"
  });

  assert.equal(created.address, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(created.isWhitelisted, false);

  const whitelisted = await service.whitelistWithdrawalAddress(created.addressBookId);
  assert.equal(whitelisted.isWhitelisted, true);

  const listed = await service.listWithdrawalAddressBookEntries({
    userId: "user-1",
    network: "ethereum",
    isWhitelisted: true,
    limit: 10,
    offset: 0
  });

  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]?.addressBookId, created.addressBookId);

  const unwhitelisted = await service.unwhitelistWithdrawalAddress(created.addressBookId);
  assert.equal(unwhitelisted.isWhitelisted, false);
});

test("validateWithdrawalRequest enforces whitelist, 2FA and daily limit rules", async () => {
  const repository = new InMemoryWalletRepository();

  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };
  const verifiedCodes: string[] = [];
  const identityClient: IdentityClient = {
    async getTwoFactorStatus(userId) {
      return {
        userId,
        enabled: true,
        pendingEnrollment: false,
        enabledAt: "2026-03-07T09:59:59.000Z"
      };
    },
    async verifyTwoFactor(command) {
      verifiedCodes.push(command.code);
      return {
        verifiedAt: "2026-03-07T10:00:01.000Z",
        purpose: command.purpose
      };
    },
    async getKycProfile(userId) {
      return { userId, tier: "unverified" };
    }
  };

  const service = new WalletApplicationService(
    repository,
    ledgerClient,
    custodyClient,
    {
      now: () => new Date("2026-03-07T10:00:00.000Z"),
      createId: () => "withdrawal-rule-1",
      withdrawalValidationRules: {
        requireTwoFactor: true,
        requireWhitelist: true,
        minAmountByAsset: {
          USDT: "10"
        },
        minFeeByNetwork: {
          ethereum: "1"
        },
        singleLimitByAsset: {
          USDT: "100"
        },
        dailyLimitByAsset: {
          USDT: "120"
        }
      }
    },
    identityClient
  );

  await service.createWithdrawalAddressBookEntry({
    userId: "user-1",
    network: "ethereum",
    address: "0x7777777777777777777777777777777777777777",
    label: "Approved payout",
    isWhitelisted: true
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x7777777777777777777777777777777777777777",
    amount: "40",
    fee: "1",
    twoFactorCode: "123456"
  });

  const valid = await service.validateWithdrawalRequest({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x7777777777777777777777777777777777777777",
    amount: "50",
    fee: "1"
  });

  assert.equal(valid.valid, true);
  assert.equal(valid.frozenAmount, "51");
  assert.equal(valid.appliedRules.dailyUsedAmount, "40");
  assert.deepEqual(verifiedCodes, ["123456"]);

  await assert.rejects(
    () =>
      service.validateWithdrawalRequest({
        userId: "user-1",
        ledgerAccountId: "ledger-account-1",
        assetCode: "USDT",
        network: "ethereum",
        toAddress: "0x7777777777777777777777777777777777777777",
        amount: "81",
        fee: "1"
      }),
    /daily limit/
  );

  await assert.rejects(
    () =>
      service.validateWithdrawalRequest({
        userId: "user-1",
        ledgerAccountId: "ledger-account-1",
        assetCode: "USDT",
        network: "ethereum",
        toAddress: "0x8888888888888888888888888888888888888888",
        amount: "20",
        fee: "1"
      }),
    /not whitelisted/
  );

  await assert.rejects(
    () =>
      service.requestWithdrawal({
        userId: "user-1",
        ledgerAccountId: "ledger-account-1",
        assetCode: "USDT",
        network: "ethereum",
        toAddress: "0x7777777777777777777777777777777777777777",
        amount: "20",
        fee: "1"
      }),
    /verification code is required/
  );
});

test("requestWithdrawal rejects invalid destination address", async () => {
  const repository = new InMemoryWalletRepository();
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
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
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    createId: () => "withdrawal-invalid-address"
  });

  await assert.rejects(
    () =>
      service.requestWithdrawal({
        userId: "user-1",
        ledgerAccountId: "ledger-account-1",
        assetCode: "USDT",
        network: "ethereum",
        toAddress: "not-an-evm-address",
        amount: "20",
        fee: "1"
      }),
    /not valid for ethereum/
  );
});

test("approveWithdrawal broadcasts transfer and stores custody details", async () => {
  const repository = new InMemoryWalletRepository();
  let releaseCalls = 0;
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      releaseCalls += 1;
      return {
        lockId: "lock-1"
      };
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      return {
        custodyRequestId: "custody-request-1",
        providerName: "mock-custody",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      };
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: () => new Date("2026-03-07T03:04:05.000Z"),
    createId: () => "withdrawal-approve-1"
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "50",
    fee: "1"
  });

  const approved = await service.approveWithdrawal({
    withdrawalId: "withdrawal-approve-1",
    reviewedBy: "risk-operator",
    note: "passed aml review"
  });

  assert.equal(approved.status, "broadcasted");
  assert.equal(approved.reviewStatus, "approved");
  assert.equal(approved.approvedAt, "2026-03-07T03:04:05.000Z");
  assert.equal(approved.broadcastedAt, "2026-03-07T03:04:05.000Z");
  assert.equal(approved.custodyRequestId, "custody-request-1");
  assert.equal(
    approved.txHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  assert.equal(releaseCalls, 0);

  const approvalLogs = await service.listWithdrawalAuditLogs({
    withdrawalId: "withdrawal-approve-1",
    action: "approved",
    limit: 10,
    offset: 0
  });
  assert.equal(approvalLogs.total, 1);
  assert.equal(approvalLogs.items[0]?.operatorId, "risk-operator");

  const broadcastLogs = await service.listWithdrawalAuditLogs({
    withdrawalId: "withdrawal-approve-1",
    action: "broadcasted",
    limit: 10,
    offset: 0
  });
  assert.equal(broadcastLogs.total, 1);
  assert.equal(broadcastLogs.items[0]?.operatorRole, "system");

  const approvedNotifications = await service.listWalletNotifications({
    withdrawalId: "withdrawal-approve-1",
    eventType: "withdrawal.approved",
    limit: 10,
    offset: 0
  });
  assert.equal(approvedNotifications.total, 1);

  const broadcastNotifications = await service.listWalletNotifications({
    withdrawalId: "withdrawal-approve-1",
    eventType: "withdrawal.broadcasted",
    limit: 10,
    offset: 0
  });
  assert.equal(broadcastNotifications.total, 1);
});

test("rebroadcastWithdrawal resumes an approved withdrawal after custody failure", async () => {
  const repository = new InMemoryWalletRepository();
  let createTransferCalls = 0;
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      createTransferCalls += 1;
      if (createTransferCalls === 1) {
        throw new Error("temporary custody failure");
      }

      return {
        custodyRequestId: "custody-request-retry-1",
        providerName: "mock-custody",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      };
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: () => new Date("2026-03-07T03:04:05.000Z"),
    createId: () => "withdrawal-rebroadcast-1"
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2323232323232323232323232323232323232323",
    amount: "25",
    fee: "1"
  });

  await assert.rejects(
    () =>
      service.approveWithdrawal({
        withdrawalId: "withdrawal-rebroadcast-1",
        reviewedBy: "risk-operator"
      }),
    /temporary custody failure/
  );

  const approved = await service.getWithdrawal("withdrawal-rebroadcast-1");
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.reviewStatus, "approved");

  const rebroadcasted = await service.rebroadcastWithdrawal({
    withdrawalId: "withdrawal-rebroadcast-1",
    requestedBy: "ops-operator",
    note: "resume stale approved withdrawal"
  });

  assert.equal(rebroadcasted.status, "broadcasted");
  assert.equal(rebroadcasted.custodyRequestId, "custody-request-retry-1");
  assert.equal(
    rebroadcasted.txHash,
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  );
});

test("rejectWithdrawal releases balance and marks withdrawal rejected", async () => {
  const repository = new InMemoryWalletRepository();
  const releasedReferences: string[] = [];
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance(command) {
      releasedReferences.push(`${command.accountId}:${command.referenceId}`);
      return {
        lockId: "lock-1"
      };
    },
    async consumeBalance() {
      throw new Error("consumeBalance should not be called");
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      throw new Error("custody client should not be called");
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: () => new Date("2026-03-07T04:05:06.000Z"),
    createId: () => "withdrawal-reject-1"
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x3333333333333333333333333333333333333333",
    amount: "40",
    fee: "0.5"
  });

  const rejected = await service.rejectWithdrawal({
    withdrawalId: "withdrawal-reject-1",
    reviewedBy: "risk-operator",
    reason: "manual review rejected"
  });

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewStatus, "rejected");
  assert.deepEqual(releasedReferences, ["ledger-account-1:withdrawal-reject-1"]);

  const rejectionLogs = await service.listWithdrawalAuditLogs({
    withdrawalId: "withdrawal-reject-1",
    action: "rejected",
    limit: 10,
    offset: 0
  });
  assert.equal(rejectionLogs.total, 1);
  assert.equal(rejectionLogs.items[0]?.operatorId, "risk-operator");

  const rejectionNotifications = await service.listWalletNotifications({
    withdrawalId: "withdrawal-reject-1",
    eventType: "withdrawal.rejected",
    limit: 10,
    offset: 0
  });
  assert.equal(rejectionNotifications.total, 1);
});

test("confirmWithdrawal at threshold consumes balance lock and marks withdrawal confirmed", async () => {
  const repository = new InMemoryWalletRepository();
  const consumedReferences: string[] = [];
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("postDepositCredit should not be called");
    },
    async freezeBalance() {
      return {
        lockId: "lock-1"
      };
    },
    async releaseBalance() {
      throw new Error("releaseBalance should not be called");
    },
    async consumeBalance(command) {
      consumedReferences.push(`${command.accountId}:${command.referenceId}`);
      return {
        lockId: "lock-1"
      };
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer() {
      return {
        custodyRequestId: "custody-request-2",
        providerName: "mock-custody",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      };
    }
  };

  const service = new WalletApplicationService(repository, ledgerClient, custodyClient, {
    now: () => new Date("2026-03-07T05:06:07.000Z"),
    createId: () => "withdrawal-confirm-1",
    withdrawalConfirmationThreshold: 12
  });

  await service.requestWithdrawal({
    userId: "user-1",
    ledgerAccountId: "ledger-account-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x4444444444444444444444444444444444444444",
    amount: "60",
    fee: "1"
  });

  await service.approveWithdrawal({
    withdrawalId: "withdrawal-confirm-1",
    reviewedBy: "risk-operator"
  });

  const confirmed = await service.confirmWithdrawal({
    network: "ethereum",
    txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    confirmations: 12,
    blockNumber: 123
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedAt, "2026-03-07T05:06:07.000Z");
  assert.deepEqual(consumedReferences, ["ledger-account-1:withdrawal-confirm-1"]);

  const confirmationLogs = await service.listWithdrawalAuditLogs({
    withdrawalId: "withdrawal-confirm-1",
    action: "confirmed",
    limit: 10,
    offset: 0
  });
  assert.equal(confirmationLogs.total, 1);
  assert.equal(confirmationLogs.items[0]?.operatorRole, "system");

  const confirmationNotifications = await service.listWalletNotifications({
    withdrawalId: "withdrawal-confirm-1",
    eventType: "withdrawal.confirmed",
    limit: 10,
    offset: 0
  });
  assert.equal(confirmationNotifications.total, 1);
});

test("assets come from config/markets.json: SOL works without code changes, unknown assets are rejected", async () => {
  const unused = async () => {
    throw new Error("should not be called");
  };
  const service = new WalletApplicationService(
    new InMemoryWalletRepository(),
    { postDepositCredit: unused, freezeBalance: unused, releaseBalance: unused, consumeBalance: unused },
    { createTransfer: unused }
  );

  const address = await service.createDepositAddress({
    userId: "user-sol",
    ledgerAccountId: "ledger-account-sol",
    assetCode: "SOL",
    network: "ethereum"
  });
  assert.match(address.address, /^0x[0-9a-f]{40}$/);

  const validation = await service.validateWithdrawalRequest({
    userId: "user-sol",
    ledgerAccountId: "ledger-account-sol",
    assetCode: "SOL",
    network: "ethereum",
    toAddress: "0x7777777777777777777777777777777777777777",
    amount: "3",
    fee: "0.01"
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.frozenAmount, "3.01");

  await assert.rejects(
    service.createDepositAddress({
      userId: "user-sol",
      ledgerAccountId: "ledger-account-sol",
      assetCode: "DOGE",
      network: "ethereum"
    }),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_ASSET"
  );
  await assert.rejects(
    service.createDepositAddress({
      userId: "user-sol",
      ledgerAccountId: "ledger-account-sol",
      assetCode: "SOL",
      network: "solana"
    }),
    /not supported on solana/
  );
});
