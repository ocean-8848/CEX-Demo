import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import { WalletOpsService } from "../application/wallet-ops-service.js";
import { WalletNotificationDispatcher } from "../application/wallet-notification-dispatcher.js";
import type { WalletEventPublisher } from "../domain/event-publisher.js";
import type { AddressBlacklistEntry, AddressRiskLabel } from "../domain/withdrawal-risk.js";
import type {
  AddAddressBlacklistEntryCommand,
  CreateSecurityNotificationCommand,
  ListAddressBlacklistQuery,
  RemoveAddressBlacklistEntryCommand,
  ApproveWithdrawalCommand,
  ConfirmWithdrawalCommand,
  ConfirmDepositCommand,
  CreateWithdrawalAddressBookEntryCommand,
  CreateDepositAddressCommand,
  DepositRecord,
  ListWithdrawalAuditLogsQuery,
  ListDepositAddressesQuery,
  ListWithdrawalAddressBookQuery,
  ListWithdrawalNotificationsQuery,
  MarkWalletNotificationsReadCommand,
  ListDepositsQuery,
  ListWithdrawalsQuery,
  PagedResult,
  RejectWithdrawalCommand,
  RequestWithdrawalCommand,
  WalletNotificationRecord,
  WithdrawalLimitsView,
  WithdrawalValidationResult,
  WithdrawalAuditLogRecord,
  WithdrawalAddressBookEntry,
  WithdrawalRecord,
  WalletAddress
} from "../domain/types.js";
import type { WalletRepository } from "../domain/repository.js";
import { HttpCustodyClient } from "../infrastructure/http-custody-client.js";
import { HttpIdentityClient } from "../infrastructure/http-identity-client.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { ConsoleWalletNotificationTransport } from "../infrastructure/console-wallet-notification-transport.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";
import { NoopWalletEventPublisher } from "../infrastructure/noop-wallet-event-publisher.js";
import { createWalletPool } from "../infrastructure/postgres.js";
import { PostgresWalletRepository } from "../infrastructure/postgres-wallet-repository.js";
import {
  createWalletRedisClient,
  RedisWalletEventPublisher
} from "../infrastructure/redis-wallet-event-publisher.js";
import { loadWithdrawalValidationRulesFromEnv } from "../infrastructure/withdrawal-validation-rules.js";

@Injectable()
export class WalletHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly applicationService: WalletApplicationService;
  private readonly opsService: WalletOpsService;
  private readonly pool?: Pool;
  private readonly repository: WalletRepository;
  private readonly walletEventPublisher: WalletEventPublisher;
  private readonly walletRedisClient?: RedisClientType;

  constructor() {
    const repositoryMode = process.env.WALLET_REPOSITORY ?? "postgres";
    const eventPublisherMode = process.env.WALLET_EVENT_PUBLISHER ?? "redis";

    if (repositoryMode === "memory") {
      this.repository = new InMemoryWalletRepository();
    } else {
      this.pool = createWalletPool();
      this.repository = new PostgresWalletRepository(this.pool, this.pool);
    }

    if (eventPublisherMode === "redis") {
      this.walletRedisClient = createWalletRedisClient(
        process.env.WALLET_REDIS_URL ?? "redis://127.0.0.1:6379"
      );
      this.walletEventPublisher = new RedisWalletEventPublisher(
        this.walletRedisClient,
        process.env.WALLET_NOTIFICATION_EVENT_CHANNEL ?? "web3-cex:wallet.notifications"
      );
    } else {
      this.walletEventPublisher = new NoopWalletEventPublisher();
    }

    this.applicationService = new WalletApplicationService(
      this.repository,
      new HttpLedgerClient(
        process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001",
        process.env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
          "00000000-0000-0000-0000-000000000098",
        process.env.LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID ??
          process.env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
          "00000000-0000-0000-0000-000000000098"
      ),
      new HttpCustodyClient(
        process.env.CUSTODY_ADAPTER_BASE_URL ?? "http://127.0.0.1:3004"
      ),
      {
        depositConfirmationThreshold: Number(
          process.env.DEPOSIT_CONFIRMATION_THRESHOLD ?? "12"
        ),
        withdrawalConfirmationThreshold: Number(
          process.env.WITHDRAWAL_CONFIRMATION_THRESHOLD ?? "12"
        ),
        withdrawalValidationRules: loadWithdrawalValidationRulesFromEnv()
      },
      new HttpIdentityClient(
        process.env.IDENTITY_SERVICE_BASE_URL ?? "http://127.0.0.1:3005"
      ),
      this.walletEventPublisher
    );
    this.opsService = new WalletOpsService(
      this.applicationService,
      new WalletNotificationDispatcher(
        this.repository,
        new ConsoleWalletNotificationTransport(),
        {
          batchSize: Number(process.env.WALLET_NOTIFICATION_BATCH_SIZE ?? "100"),
          maxAttempts: Number(process.env.WALLET_NOTIFICATION_MAX_ATTEMPTS ?? "5"),
          retryDelayMs: Number(process.env.WALLET_NOTIFICATION_RETRY_DELAY_MS ?? "5000")
        }
      )
    );
  }

  /** Same database pool / memory store, shared with the treasury module. */
  get sharedStore(): { repository: WalletRepository; pool?: Pool } {
    return { repository: this.repository, pool: this.pool };
  }

  async onModuleInit(): Promise<void> {
    // Without an open connection every deposit / withdrawal / notification event
    // is dropped and the gateway's private WebSocket never pushes funding updates.
    if (this.walletRedisClient && !this.walletRedisClient.isOpen) {
      try {
        await this.walletRedisClient.connect();
      } catch (error) {
        console.warn(
          `[wallet-service] redis event publisher unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.walletEventPublisher.close?.();
    await this.pool?.end();
  }

  async createDepositAddress(command: CreateDepositAddressCommand): Promise<WalletAddress> {
    return this.applicationService.createDepositAddress(command);
  }

  async listDepositAddresses(query: ListDepositAddressesQuery): Promise<PagedResult<WalletAddress>> {
    return this.applicationService.listDepositAddresses(query);
  }

  async confirmDeposit(command: ConfirmDepositCommand): Promise<DepositRecord> {
    return this.applicationService.confirmDeposit(command);
  }

  async getDeposit(depositId: string): Promise<DepositRecord | null> {
    return this.applicationService.getDeposit(depositId);
  }

  async listDeposits(query: ListDepositsQuery): Promise<PagedResult<DepositRecord>> {
    return this.applicationService.listDeposits(query);
  }

  async createWithdrawalAddressBookEntry(
    command: CreateWithdrawalAddressBookEntryCommand
  ): Promise<WithdrawalAddressBookEntry> {
    return this.applicationService.createWithdrawalAddressBookEntry(command);
  }

  async listWithdrawalAddressBookEntries(
    query: ListWithdrawalAddressBookQuery
  ): Promise<PagedResult<WithdrawalAddressBookEntry>> {
    return this.applicationService.listWithdrawalAddressBookEntries(query);
  }

  async whitelistWithdrawalAddress(addressBookId: string): Promise<WithdrawalAddressBookEntry> {
    return this.applicationService.whitelistWithdrawalAddress(addressBookId);
  }

  async unwhitelistWithdrawalAddress(addressBookId: string): Promise<WithdrawalAddressBookEntry> {
    return this.applicationService.unwhitelistWithdrawalAddress(addressBookId);
  }

  async validateWithdrawalRequest(
    command: RequestWithdrawalCommand
  ): Promise<WithdrawalValidationResult> {
    return this.applicationService.validateWithdrawalRequest(command);
  }

  async requestWithdrawal(command: RequestWithdrawalCommand): Promise<WithdrawalRecord> {
    return this.applicationService.requestWithdrawal(command);
  }

  async getWithdrawalLimits(userId: string): Promise<WithdrawalLimitsView> {
    return this.applicationService.getWithdrawalLimits(userId);
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalRecord | null> {
    return this.applicationService.getWithdrawal(withdrawalId);
  }

  async listWithdrawals(query: ListWithdrawalsQuery): Promise<PagedResult<WithdrawalRecord>> {
    return this.applicationService.listWithdrawals(query);
  }

  async listWithdrawalReviewQueue(
    query: Omit<ListWithdrawalsQuery, "reviewStatus">
  ): Promise<PagedResult<WithdrawalRecord>> {
    return this.applicationService.listWithdrawalReviewQueue(query);
  }

  async listWithdrawalAuditLogs(
    query: ListWithdrawalAuditLogsQuery
  ): Promise<PagedResult<WithdrawalAuditLogRecord>> {
    return this.applicationService.listWithdrawalAuditLogs(query);
  }

  async listWalletNotifications(
    query: ListWithdrawalNotificationsQuery
  ): Promise<PagedResult<WalletNotificationRecord>> {
    return this.applicationService.listWalletNotifications(query);
  }

  async countUnreadWalletNotifications(userId: string): Promise<{ unreadCount: number }> {
    return this.applicationService.countUnreadWalletNotifications(userId);
  }

  async markWalletNotificationsRead(command: MarkWalletNotificationsReadCommand) {
    return this.applicationService.markWalletNotificationsRead(command);
  }

  async deliverNotifications(params: {
    limit?: number;
  }): Promise<{
    deliveredCount: number;
    retriedCount: number;
    failedCount: number;
    notificationIds: string[];
  }> {
    return this.opsService.deliverNotifications(params.limit);
  }

  async reconcileStaleWithdrawals(params: {
    staleMinutes?: number;
    rebroadcastAutoConfirm?: boolean;
    forceConfirmations?: number;
    forceBlockNumber?: number;
    pageSize?: number;
    operatorId?: string;
  }): Promise<{
    staleMinutes: number;
    scannedCount: number;
    rejectedCount: number;
    rebroadcastedCount: number;
    confirmedCount: number;
    skippedCount: number;
    processedWithdrawalIds: string[];
  }> {
    return this.opsService.reconcileStaleWithdrawals(params);
  }

  async confirmWithdrawal(command: ConfirmWithdrawalCommand): Promise<WithdrawalRecord> {
    return this.applicationService.confirmWithdrawal(command);
  }

  async approveWithdrawal(command: ApproveWithdrawalCommand): Promise<WithdrawalRecord> {
    return this.applicationService.approveWithdrawal(command);
  }

  async rejectWithdrawal(command: RejectWithdrawalCommand): Promise<WithdrawalRecord> {
    return this.applicationService.rejectWithdrawal(command);
  }

  async listAddressBlacklist(
    query: ListAddressBlacklistQuery
  ): Promise<PagedResult<AddressBlacklistEntry>> {
    return this.applicationService.listAddressBlacklist(query);
  }

  async addAddressBlacklistEntry(command: AddAddressBlacklistEntryCommand) {
    return this.applicationService.addAddressBlacklistEntry(command);
  }

  async removeAddressBlacklistEntry(
    command: RemoveAddressBlacklistEntryCommand
  ): Promise<AddressBlacklistEntry> {
    return this.applicationService.removeAddressBlacklistEntry(command);
  }

  listAddressRiskLabels(): AddressRiskLabel[] {
    return this.applicationService.listAddressRiskLabels();
  }

  async createSecurityNotification(
    command: CreateSecurityNotificationCommand
  ): Promise<WalletNotificationRecord> {
    return this.applicationService.createSecurityNotification(command);
  }
}
