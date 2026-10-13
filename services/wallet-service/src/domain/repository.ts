import type { Network } from "@web3-cex/domain";

import type { AddressBlacklistEntry } from "./withdrawal-risk.js";
import type {
  CreateWithdrawalAddressBookEntryCommand,
  ListAddressBlacklistQuery,
  ConfirmDepositCommand,
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
} from "./types.js";

export interface WalletRepository {
  withTransaction<T>(operation: (repository: WalletRepository) => Promise<T>): Promise<T>;
  createDepositAddress(
    command: CreateDepositAddressCommand,
    address: string,
    now: string
  ): Promise<WalletAddress>;
  findDepositAddress(network: Network, address: string): Promise<WalletAddress | null>;
  findDepositByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<DepositRecord | null>;
  listDepositAddresses(query: ListDepositAddressesQuery): Promise<PagedResult<WalletAddress>>;
  saveDeposit(record: DepositRecord): Promise<void>;
  findDepositById(depositId: string): Promise<DepositRecord | null>;
  listDeposits(query: ListDepositsQuery): Promise<PagedResult<DepositRecord>>;
  saveWithdrawal(record: WithdrawalRecord): Promise<void>;
  findWithdrawalById(withdrawalId: string): Promise<WithdrawalRecord | null>;
  findWithdrawalByTxHash(network: Network, txHash: string): Promise<WithdrawalRecord | null>;
  listWithdrawals(query: ListWithdrawalsQuery): Promise<PagedResult<WithdrawalRecord>>;
  saveWithdrawalAuditLog(record: WithdrawalAuditLogRecord): Promise<void>;
  listWithdrawalAuditLogs(
    query: ListWithdrawalAuditLogsQuery
  ): Promise<PagedResult<WithdrawalAuditLogRecord>>;
  saveWalletNotification(record: WalletNotificationRecord): Promise<void>;
  listDeliverableWalletNotifications(
    limit: number,
    now: string
  ): Promise<WalletNotificationRecord[]>;
  markWalletNotificationDelivered(params: {
    notificationId: string;
    attemptedAt: string;
    deliveredAt: string;
    deliveryReceipt?: Record<string, unknown>;
  }): Promise<void>;
  recordWalletNotificationFailure(params: {
    notificationId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    failedAt?: string;
  }): Promise<void>;
  listWalletNotifications(
    query: ListWithdrawalNotificationsQuery
  ): Promise<PagedResult<WalletNotificationRecord>>;
  findWalletNotificationById(notificationId: string): Promise<WalletNotificationRecord | null>;
  /**
   * Sets read_at on the user's unread notifications (all of them when
   * notificationIds is omitted). Rows of other users are never touched.
   * Returns how many rows changed.
   */
  markWalletNotificationsRead(params: {
    userId: string;
    notificationIds?: string[];
    readAt: string;
  }): Promise<number>;
  countUnreadWalletNotifications(userId: string): Promise<number>;
  upsertWithdrawalAddressBookEntry(
    command: UpsertWithdrawalAddressBookEntryCommand,
    now: string
  ): Promise<WithdrawalAddressBookEntry>;
  findWithdrawalAddressBookEntryById(addressBookId: string): Promise<WithdrawalAddressBookEntry | null>;
  findWithdrawalAddressBookEntryByUniqueKey(
    command: Pick<CreateWithdrawalAddressBookEntryCommand, "userId" | "network" | "address">
  ): Promise<WithdrawalAddressBookEntry | null>;
  listWithdrawalAddressBookEntries(
    query: ListWithdrawalAddressBookQuery
  ): Promise<PagedResult<WithdrawalAddressBookEntry>>;
  setWithdrawalAddressWhitelistStatus(
    command: SetWithdrawalAddressWhitelistStatusCommand
  ): Promise<WithdrawalAddressBookEntry | null>;
  isWithdrawalAddressWhitelisted(
    userId: string,
    network: Network,
    address: string
  ): Promise<boolean>;
  sumWithdrawalsForUser(params: {
    userId: string;
    assetCode: DepositRecord["assetCode"];
    from: string;
    to: string;
  }): Promise<string>;
  // --- simplified KYT ------------------------------------------------------
  /** Withdrawals of the user to this address that were approved or went further. */
  countSuccessfulWithdrawalsToAddress(params: {
    userId: string;
    network: Network;
    address: string;
  }): Promise<number>;
  listAddressBlacklist(query: ListAddressBlacklistQuery): Promise<PagedResult<AddressBlacklistEntry>>;
  findActiveAddressBlacklistEntry(network: Network, address: string): Promise<AddressBlacklistEntry | null>;
  findAddressBlacklistEntryById(entryId: string): Promise<AddressBlacklistEntry | null>;
  /** Inserts or updates (by entryId). */
  saveAddressBlacklistEntry(entry: AddressBlacklistEntry): Promise<void>;
}
