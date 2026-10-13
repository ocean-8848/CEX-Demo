import type { Network } from "@web3-cex/domain";

import type { WalletRepository } from "../domain/repository.js";
import { sumAmounts } from "../domain/money.js";
import type { AddressBlacklistEntry } from "../domain/withdrawal-risk.js";
import type {
  CreateWithdrawalAddressBookEntryCommand,
  ListAddressBlacklistQuery,
  CreateDepositAddressCommand,
  DepositRecord,
  ListWithdrawalAuditLogsQuery,
  ListDepositAddressesQuery,
  ListWithdrawalAddressBookQuery,
  ListWithdrawalNotificationsQuery,
  ListDepositsQuery,
  ListWithdrawalsQuery,
  PagedResult,
  SetWithdrawalAddressWhitelistStatusCommand,
  UpsertWithdrawalAddressBookEntryCommand,
  WalletNotificationRecord,
  WithdrawalAuditLogRecord,
  WithdrawalRecord,
  WithdrawalAddressBookEntry,
  WalletAddress
} from "../domain/types.js";

function depositKey(network: Network, txHash: string, address: string): string {
  return `${network}:${txHash}:${address}`;
}

function addressKey(network: Network, address: string): string {
  return `${network}:${address}`;
}

function withdrawalTxKey(network: Network, txHash: string): string {
  return `${network}:${txHash}`;
}

function withdrawalAddressBookKey(
  userId: string,
  network: Network,
  address: string
): string {
  return `${userId}:${network}:${address}`;
}

export class InMemoryWalletRepository implements WalletRepository {
  private readonly depositAddresses = new Map<string, WalletAddress>();
  private readonly depositsById = new Map<string, DepositRecord>();
  private readonly depositsByUniqueKey = new Map<string, DepositRecord>();
  private readonly withdrawalsById = new Map<string, WithdrawalRecord>();
  private readonly withdrawalsByTxHash = new Map<string, WithdrawalRecord>();
  private readonly withdrawalAuditLogsById = new Map<string, WithdrawalAuditLogRecord>();
  private readonly walletNotificationsById = new Map<string, WalletNotificationRecord>();
  private readonly withdrawalAddressBookById = new Map<string, WithdrawalAddressBookEntry>();
  private readonly withdrawalAddressBookByUniqueKey = new Map<string, WithdrawalAddressBookEntry>();
  private readonly addressBlacklistById = new Map<string, AddressBlacklistEntry>();

  async withTransaction<T>(operation: (repository: WalletRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async createDepositAddress(
    command: CreateDepositAddressCommand,
    address: string,
    now: string
  ): Promise<WalletAddress> {
    const record: WalletAddress = {
      walletAddressId: crypto.randomUUID(),
      userId: command.userId,
      ledgerAccountId: command.ledgerAccountId,
      assetCode: command.assetCode,
      network: command.network,
      address,
      status: "active",
      createdAt: now
    };

    this.depositAddresses.set(addressKey(command.network, address), record);
    return record;
  }

  async findDepositAddress(network: Network, address: string): Promise<WalletAddress | null> {
    return this.depositAddresses.get(addressKey(network, address)) ?? null;
  }

  async findDepositByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<DepositRecord | null> {
    return this.depositsByUniqueKey.get(depositKey(network, txHash, address)) ?? null;
  }

  async listDepositAddresses(query: ListDepositAddressesQuery): Promise<PagedResult<WalletAddress>> {
    const items = [...this.depositAddresses.values()]
      .filter((record) => {
        if (query.userId && record.userId !== query.userId) {
          return false;
        }
        if (query.ledgerAccountId && record.ledgerAccountId !== query.ledgerAccountId) {
          return false;
        }
        if (query.assetCode && record.assetCode !== query.assetCode) {
          return false;
        }
        if (query.network && record.network !== query.network) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        if (query.address && record.address !== query.address) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async saveDeposit(record: DepositRecord): Promise<void> {
    this.depositsById.set(record.depositId, record);
    this.depositsByUniqueKey.set(depositKey(record.network, record.txHash, record.address), record);
  }

  async findDepositById(depositId: string): Promise<DepositRecord | null> {
    return this.depositsById.get(depositId) ?? null;
  }

  async listDeposits(query: ListDepositsQuery): Promise<PagedResult<DepositRecord>> {
    const items = [...this.depositsById.values()]
      .filter((record) => {
        if (query.userId && record.userId !== query.userId) {
          return false;
        }
        if (query.ledgerAccountId && record.ledgerAccountId !== query.ledgerAccountId) {
          return false;
        }
        if (query.assetCode && record.assetCode !== query.assetCode) {
          return false;
        }
        if (query.network && record.network !== query.network) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        if (query.txHash && record.txHash !== query.txHash) {
          return false;
        }
        if (query.address && record.address !== query.address) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async saveWithdrawal(record: WithdrawalRecord): Promise<void> {
    this.withdrawalsById.set(record.withdrawalId, record);
    if (record.txHash) {
      this.withdrawalsByTxHash.set(withdrawalTxKey(record.network, record.txHash), record);
    }
  }

  async findWithdrawalById(withdrawalId: string): Promise<WithdrawalRecord | null> {
    return this.withdrawalsById.get(withdrawalId) ?? null;
  }

  async findWithdrawalByTxHash(network: Network, txHash: string): Promise<WithdrawalRecord | null> {
    return this.withdrawalsByTxHash.get(withdrawalTxKey(network, txHash)) ?? null;
  }

  async listWithdrawals(query: ListWithdrawalsQuery): Promise<PagedResult<WithdrawalRecord>> {
    const items = [...this.withdrawalsById.values()]
      .filter((record) => {
        if (query.userId && record.userId !== query.userId) {
          return false;
        }
        if (query.ledgerAccountId && record.ledgerAccountId !== query.ledgerAccountId) {
          return false;
        }
        if (query.assetCode && record.assetCode !== query.assetCode) {
          return false;
        }
        if (query.network && record.network !== query.network) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        if (query.reviewStatus && record.reviewStatus !== query.reviewStatus) {
          return false;
        }
        if (query.reviewStatuses && !query.reviewStatuses.includes(record.reviewStatus)) {
          return false;
        }
        if (query.txHash && record.txHash !== query.txHash) {
          return false;
        }
        if (query.toAddress && record.toAddress !== query.toAddress) {
          return false;
        }
        if (query.riskLevel && record.riskLevel !== query.riskLevel) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async saveWithdrawalAuditLog(record: WithdrawalAuditLogRecord): Promise<void> {
    this.withdrawalAuditLogsById.set(record.auditLogId, record);
  }

  async listWithdrawalAuditLogs(
    query: ListWithdrawalAuditLogsQuery
  ): Promise<PagedResult<WithdrawalAuditLogRecord>> {
    const items = [...this.withdrawalAuditLogsById.values()]
      .filter((record) => {
        const withdrawal = this.withdrawalsById.get(record.withdrawalId);

        if (query.withdrawalId && record.withdrawalId !== query.withdrawalId) {
          return false;
        }
        if (query.userId && withdrawal?.userId !== query.userId) {
          return false;
        }
        if (query.assetCode && withdrawal?.assetCode !== query.assetCode) {
          return false;
        }
        if (query.network && withdrawal?.network !== query.network) {
          return false;
        }
        if (query.status && withdrawal?.status !== query.status) {
          return false;
        }
        if (query.reviewStatus && withdrawal?.reviewStatus !== query.reviewStatus) {
          return false;
        }
        if (query.txHash && withdrawal?.txHash !== query.txHash) {
          return false;
        }
        if (query.toAddress && withdrawal?.toAddress !== query.toAddress) {
          return false;
        }
        if (query.action && record.action !== query.action) {
          return false;
        }
        if (query.operatorId && record.operatorId !== query.operatorId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async saveWalletNotification(record: WalletNotificationRecord): Promise<void> {
    // Mirrors the partial unique index: one notification per (deposit, event).
    if (record.depositId) {
      for (const existing of this.walletNotificationsById.values()) {
        if (existing.depositId === record.depositId && existing.eventType === record.eventType) {
          return;
        }
      }
    }
    this.walletNotificationsById.set(record.notificationId, record);
  }

  async listDeliverableWalletNotifications(
    limit: number,
    now: string
  ): Promise<WalletNotificationRecord[]> {
    return [...this.walletNotificationsById.values()]
      .filter(
        (record) =>
          record.status === "pending" &&
          (!record.nextAttemptAt || record.nextAttemptAt <= now)
      )
      .sort((left, right) =>
        (left.nextAttemptAt ?? left.createdAt).localeCompare(right.nextAttemptAt ?? right.createdAt)
      )
      .slice(0, limit);
  }

  async markWalletNotificationDelivered(params: {
    notificationId: string;
    attemptedAt: string;
    deliveredAt: string;
    deliveryReceipt?: Record<string, unknown>;
  }): Promise<void> {
    const existing = this.walletNotificationsById.get(params.notificationId);
    if (!existing) {
      return;
    }

    this.walletNotificationsById.set(params.notificationId, {
      ...existing,
      status: "delivered",
      deliveryAttempts: existing.deliveryAttempts + 1,
      lastAttemptedAt: params.attemptedAt,
      deliveredAt: params.deliveredAt,
      failedAt: undefined,
      lastError: undefined,
      nextAttemptAt: undefined,
      deliveryReceipt: params.deliveryReceipt ?? existing.deliveryReceipt
    });
  }

  async recordWalletNotificationFailure(params: {
    notificationId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    failedAt?: string;
  }): Promise<void> {
    const existing = this.walletNotificationsById.get(params.notificationId);
    if (!existing) {
      return;
    }

    this.walletNotificationsById.set(params.notificationId, {
      ...existing,
      status: params.failedAt ? "failed" : "pending",
      deliveryAttempts: existing.deliveryAttempts + 1,
      lastAttemptedAt: params.attemptedAt,
      nextAttemptAt: params.nextAttemptAt,
      failedAt: params.failedAt,
      lastError: params.errorMessage
    });
  }

  async listWalletNotifications(
    query: ListWithdrawalNotificationsQuery
  ): Promise<PagedResult<WalletNotificationRecord>> {
    const items = [...this.walletNotificationsById.values()]
      .filter((record) => {
        if (query.userId && record.userId !== query.userId) {
          return false;
        }
        if (query.withdrawalId && record.withdrawalId !== query.withdrawalId) {
          return false;
        }
        if (query.eventType && record.eventType !== query.eventType) {
          return false;
        }
        if (query.status && record.status !== query.status) {
          return false;
        }
        if (query.channel && record.channel !== query.channel) {
          return false;
        }
        if (query.depositId && record.depositId !== query.depositId) {
          return false;
        }
        if (query.readState === "read" && !record.readAt) {
          return false;
        }
        if (query.readState === "unread" && record.readAt) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async findWalletNotificationById(notificationId: string): Promise<WalletNotificationRecord | null> {
    return this.walletNotificationsById.get(notificationId) ?? null;
  }

  async markWalletNotificationsRead(params: {
    userId: string;
    notificationIds?: string[];
    readAt: string;
  }): Promise<number> {
    const targetIds = params.notificationIds ? new Set(params.notificationIds) : null;
    let updated = 0;
    for (const record of this.walletNotificationsById.values()) {
      if (record.userId !== params.userId || record.readAt) {
        continue;
      }
      if (targetIds && !targetIds.has(record.notificationId)) {
        continue;
      }
      this.walletNotificationsById.set(record.notificationId, { ...record, readAt: params.readAt });
      updated += 1;
    }
    return updated;
  }

  async countUnreadWalletNotifications(userId: string): Promise<number> {
    let count = 0;
    for (const record of this.walletNotificationsById.values()) {
      if (record.userId === userId && !record.readAt) {
        count += 1;
      }
    }
    return count;
  }

  async upsertWithdrawalAddressBookEntry(
    command: UpsertWithdrawalAddressBookEntryCommand,
    now: string
  ): Promise<WithdrawalAddressBookEntry> {
    const existing = this.withdrawalAddressBookByUniqueKey.get(
      withdrawalAddressBookKey(command.userId, command.network, command.address)
    );

    const record: WithdrawalAddressBookEntry = {
      addressBookId: existing?.addressBookId ?? crypto.randomUUID(),
      userId: command.userId,
      network: command.network,
      address: command.address,
      label: command.label,
      isWhitelisted: command.isWhitelisted,
      createdAt: existing?.createdAt ?? now
    };

    this.withdrawalAddressBookById.set(record.addressBookId, record);
    this.withdrawalAddressBookByUniqueKey.set(
      withdrawalAddressBookKey(record.userId, record.network, record.address),
      record
    );

    return record;
  }

  async findWithdrawalAddressBookEntryById(
    addressBookId: string
  ): Promise<WithdrawalAddressBookEntry | null> {
    return this.withdrawalAddressBookById.get(addressBookId) ?? null;
  }

  async findWithdrawalAddressBookEntryByUniqueKey(
    command: Pick<CreateWithdrawalAddressBookEntryCommand, "userId" | "network" | "address">
  ): Promise<WithdrawalAddressBookEntry | null> {
    return (
      this.withdrawalAddressBookByUniqueKey.get(
        withdrawalAddressBookKey(command.userId, command.network, command.address)
      ) ?? null
    );
  }

  async listWithdrawalAddressBookEntries(
    query: ListWithdrawalAddressBookQuery
  ): Promise<PagedResult<WithdrawalAddressBookEntry>> {
    const items = [...this.withdrawalAddressBookById.values()]
      .filter((record) => {
        if (query.userId && record.userId !== query.userId) {
          return false;
        }
        if (query.network && record.network !== query.network) {
          return false;
        }
        if (query.address && record.address !== query.address) {
          return false;
        }
        if (
          query.isWhitelisted !== undefined &&
          record.isWhitelisted !== query.isWhitelisted
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async setWithdrawalAddressWhitelistStatus(
    command: SetWithdrawalAddressWhitelistStatusCommand
  ): Promise<WithdrawalAddressBookEntry | null> {
    const existing = this.withdrawalAddressBookById.get(command.addressBookId);
    if (!existing) {
      return null;
    }

    const record: WithdrawalAddressBookEntry = {
      ...existing,
      isWhitelisted: command.isWhitelisted
    };

    this.withdrawalAddressBookById.set(record.addressBookId, record);
    this.withdrawalAddressBookByUniqueKey.set(
      withdrawalAddressBookKey(record.userId, record.network, record.address),
      record
    );

    return record;
  }

  async isWithdrawalAddressWhitelisted(
    userId: string,
    network: Network,
    address: string
  ): Promise<boolean> {
    return (
      this.withdrawalAddressBookByUniqueKey.get(
        withdrawalAddressBookKey(userId, network, address)
      )?.isWhitelisted ?? false
    );
  }

  async sumWithdrawalsForUser(params: {
    userId: string;
    assetCode: DepositRecord["assetCode"];
    from: string;
    to: string;
  }): Promise<string> {
    return sumAmounts(
      [...this.withdrawalsById.values()]
      .filter((record) => {
        if (record.userId !== params.userId || record.assetCode !== params.assetCode) {
          return false;
        }
        if (record.status === "failed" || record.status === "rejected") {
          return false;
        }
        return record.requestedAt >= params.from && record.requestedAt < params.to;
      })
      .map((record) => record.amount)
    );
  }

  async countSuccessfulWithdrawalsToAddress(params: {
    userId: string;
    network: Network;
    address: string;
  }): Promise<number> {
    return [...this.withdrawalsById.values()].filter(
      (record) =>
        record.userId === params.userId &&
        record.network === params.network &&
        record.toAddress === params.address &&
        (record.status === "approved" || record.status === "broadcasted" || record.status === "confirmed")
    ).length;
  }

  async listAddressBlacklist(
    query: ListAddressBlacklistQuery
  ): Promise<PagedResult<AddressBlacklistEntry>> {
    const items = [...this.addressBlacklistById.values()]
      .filter(
        (entry) =>
          (!query.network || entry.network === query.network) &&
          (!query.address || entry.address === query.address) &&
          (!query.status || entry.status === query.status) &&
          (!query.category || entry.category === query.category)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return page(items, query.limit ?? 50, query.offset ?? 0);
  }

  async findActiveAddressBlacklistEntry(
    network: Network,
    address: string
  ): Promise<AddressBlacklistEntry | null> {
    return (
      [...this.addressBlacklistById.values()].find(
        (entry) => entry.network === network && entry.address === address && entry.status === "active"
      ) ?? null
    );
  }

  async findAddressBlacklistEntryById(entryId: string): Promise<AddressBlacklistEntry | null> {
    return this.addressBlacklistById.get(entryId) ?? null;
  }

  async saveAddressBlacklistEntry(entry: AddressBlacklistEntry): Promise<void> {
    this.addressBlacklistById.set(entry.entryId, { ...entry });
  }

  addWhitelistedAddress(userId: string, network: Network, address: string): void {
    const record: WithdrawalAddressBookEntry = {
      addressBookId: crypto.randomUUID(),
      userId,
      network,
      address,
      label: "test entry",
      isWhitelisted: true,
      createdAt: new Date().toISOString()
    };

    this.withdrawalAddressBookById.set(record.addressBookId, record);
    this.withdrawalAddressBookByUniqueKey.set(
      withdrawalAddressBookKey(userId, network, address),
      record
    );
  }
}

function page<T>(items: T[], limit: number, offset: number): PagedResult<T> {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset
  };
}
