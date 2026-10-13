import { randomBytes, randomUUID } from "node:crypto";

import { getAssetDefinition, type AssetCode } from "@web3-cex/domain";
import { currentTraceId } from "@web3-cex/telemetry";

import type { CustodyClient } from "../domain/custody-client.js";
import type { WalletEventPublisher } from "../domain/event-publisher.js";
import { WalletError } from "../domain/errors.js";
import type { IdentityClient } from "../domain/identity-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import { addAmounts, compareAmounts, isPositiveOrZero, toAtomicUnits } from "../domain/money.js";
import type { WalletRepository } from "../domain/repository.js";
import {
  applyApproval,
  checkWithdrawalLimits,
  describeCooldown,
  evaluateCooldown,
  normalizeKycTier,
  readApprovalPolicy,
  readApprovals,
  remainingAmount,
  resolveApprovalPolicy,
  resolveEffectiveLimits,
  utcDayWindow,
  type CooldownStatus,
  type KycTier,
  type SecurityChange
} from "../domain/withdrawal-policy.js";
import type {
  ApproveWithdrawalCommand,
  ConfirmWithdrawalCommand,
  ConfirmDepositCommand,
  CreateWithdrawalAddressBookEntryCommand,
  CreateDepositAddressCommand,
  DepositRecord,
  ListDepositAddressesQuery,
  ListWithdrawalAuditLogsQuery,
  ListWithdrawalAddressBookQuery,
  ListWithdrawalNotificationsQuery,
  ListDepositsQuery,
  ListWithdrawalsQuery,
  MarkWalletNotificationsReadCommand,
  MarkWalletNotificationsReadResult,
  PagedResult,
  RebroadcastWithdrawalCommand,
  RejectWithdrawalCommand,
  RequestWithdrawalCommand,
  WalletNotificationRecord,
  SetWithdrawalAddressWhitelistStatusCommand,
  WithdrawalAssetLimitView,
  WithdrawalAuditAction,
  WithdrawalAuditLogRecord,
  WithdrawalLimitsView,
  WithdrawalValidationResult,
  WithdrawalAddressBookEntry,
  WithdrawalNotificationEventType,
  WithdrawalValidationRules,
  WithdrawalRecord,
  WalletAddress
} from "../domain/types.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  depositConfirmationThreshold?: number;
  withdrawalConfirmationThreshold?: number;
  withdrawalValidationRules?: WithdrawalValidationRules;
}

interface InternalWithdrawalValidationResult extends WithdrawalValidationResult {
  normalizedToAddress: string;
  twoFactorVerifiedAt?: string;
}

const unconfiguredIdentityClient: IdentityClient = {
  async getTwoFactorStatus() {
    throw new WalletError(
      "IDENTITY_SERVICE_FAILED",
      "Identity service is required for withdrawal two-factor verification"
    );
  },
  async verifyTwoFactor() {
    throw new WalletError(
      "IDENTITY_SERVICE_FAILED",
      "Identity service is required for withdrawal two-factor verification"
    );
  },
  async getKycProfile() {
    throw new WalletError(
      "IDENTITY_SERVICE_FAILED",
      "Identity service is required for KYC withdrawal limits"
    );
  }
};

const noopWalletEventPublisher: WalletEventPublisher = {
  async publishDepositUpdated() {},
  async publishWithdrawalUpdated() {},
  async publishNotificationCreated() {}
};

export class WalletApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly depositConfirmationThreshold: number;
  private readonly withdrawalConfirmationThreshold: number;
  private readonly withdrawalValidationRules: WithdrawalValidationRules;

  constructor(
    private readonly repository: WalletRepository,
    private readonly ledgerClient: LedgerClient,
    private readonly custodyClient: CustodyClient,
    options: ServiceOptions = {},
    private readonly identityClient: IdentityClient = unconfiguredIdentityClient,
    private readonly eventPublisher: WalletEventPublisher = noopWalletEventPublisher
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.depositConfirmationThreshold = options.depositConfirmationThreshold ?? 12;
    this.withdrawalConfirmationThreshold = options.withdrawalConfirmationThreshold ?? 12;
    this.withdrawalValidationRules = options.withdrawalValidationRules ?? {};
  }

  async createDepositAddress(command: CreateDepositAddressCommand): Promise<WalletAddress> {
    this.assertSupportedAsset(command.assetCode, command.network);
    const now = this.now().toISOString();
    const address = this.generateAddress(command.network);
    return this.repository.withTransaction((repository) =>
      repository.createDepositAddress(command, address, now)
    );
  }

  async confirmDeposit(command: ConfirmDepositCommand): Promise<DepositRecord> {
    if (command.confirmations < 0) {
      throw new WalletError(
        "INVALID_CONFIRMATION_COUNT",
        "Confirmations must be greater than or equal to zero"
      );
    }

    if (!this.isPositiveAmount(command.amount)) {
      throw new WalletError("INVALID_AMOUNT", "Amount must be greater than zero");
    }

    const now = this.now().toISOString();
    const deposit = await this.repository.withTransaction(async (repository) => {
      const depositAddress = await repository.findDepositAddress(command.network, command.address);
      if (!depositAddress) {
        throw new WalletError("ADDRESS_NOT_FOUND", "Deposit address does not exist");
      }

      const existing = await repository.findDepositByUniqueKey(
        command.network,
        command.txHash,
        command.address
      );

      const baseRecord: DepositRecord = existing ?? {
        depositId: this.createId(),
        userId: depositAddress.userId,
        ledgerAccountId: depositAddress.ledgerAccountId,
        assetCode: depositAddress.assetCode,
        network: command.network,
        address: command.address,
        txHash: command.txHash,
        amount: command.amount,
        confirmations: command.confirmations,
        status: "detected",
        blockNumber: command.blockNumber,
        detectedAt: now,
        metadata: {}
      };

      const nextStatus =
        command.confirmations >= this.depositConfirmationThreshold ? "confirmed" : "confirming";

      const nextRecord: DepositRecord = {
        ...baseRecord,
        amount: command.amount,
        confirmations: command.confirmations,
        blockNumber: command.blockNumber,
        status: baseRecord.status === "credited" ? "credited" : nextStatus,
        confirmedAt:
          command.confirmations >= this.depositConfirmationThreshold
            ? baseRecord.confirmedAt ?? now
            : baseRecord.confirmedAt
      };

      await repository.saveDeposit(nextRecord);
      return nextRecord;
    });

    await this.publishDeposit(deposit);

    if (deposit.status === "credited") {
      return deposit;
    }

    if (deposit.confirmations < this.depositConfirmationThreshold) {
      return deposit;
    }

    const traceId = `deposit:${deposit.depositId}`;
    const { journalId } = await this.ledgerClient.postDepositCredit({
      depositId: deposit.depositId,
      ledgerAccountId: deposit.ledgerAccountId,
      assetCode: deposit.assetCode,
      amount: deposit.amount,
      traceId
    });

    return this.repository.withTransaction(async (repository) => {
      const latest = await repository.findDepositById(deposit.depositId);
      if (!latest) {
        throw new WalletError("ADDRESS_NOT_FOUND", "Deposit disappeared during credit flow");
      }

      if (latest.status === "credited") {
        return latest;
      }

      const credited: DepositRecord = {
        ...latest,
        status: "credited",
        creditedAt: this.now().toISOString(),
        ledgerJournalId: journalId
      };

      await repository.saveDeposit(credited);
      // The "credited" notification commits atomically with the status change.
      const notification = this.buildDepositCreditedNotification(credited);
      await repository.saveWalletNotification(notification);
      return { deposit: credited, notification };
    }).then(async (result) => {
      if ("notification" in result) {
        await this.publishDeposit(result.deposit);
        await this.publishNotifications([result.notification]);
        return result.deposit;
      }
      await this.publishDeposit(result);
      return result;
    });
  }

  async getDeposit(depositId: string): Promise<DepositRecord | null> {
    return this.repository.findDepositById(depositId);
  }

  async listDepositAddresses(query: ListDepositAddressesQuery): Promise<PagedResult<WalletAddress>> {
    return this.repository.listDepositAddresses(normalizePagination(query));
  }

  async listDeposits(query: ListDepositsQuery): Promise<PagedResult<DepositRecord>> {
    return this.repository.listDeposits(normalizePagination(query));
  }

  async createWithdrawalAddressBookEntry(
    command: CreateWithdrawalAddressBookEntryCommand
  ): Promise<WithdrawalAddressBookEntry> {
    const label = command.label.trim();
    if (!label) {
      throw new WalletError("INVALID_ADDRESS_BOOK_LABEL", "Address label cannot be empty");
    }

    const normalizedAddress = this.normalizeAddress(command.network, command.address);
    this.assertDestinationAddress(command.network, normalizedAddress);

    const existing = await this.repository.findWithdrawalAddressBookEntryByUniqueKey({
      userId: command.userId,
      network: command.network,
      address: normalizedAddress
    });

    return this.repository.withTransaction((repository) =>
      repository.upsertWithdrawalAddressBookEntry(
        {
          userId: command.userId,
          network: command.network,
          address: normalizedAddress,
          label,
          isWhitelisted: command.isWhitelisted ?? existing?.isWhitelisted ?? false
        },
        this.now().toISOString()
      )
    );
  }

  async listWithdrawalAddressBookEntries(
    query: ListWithdrawalAddressBookQuery
  ): Promise<PagedResult<WithdrawalAddressBookEntry>> {
    return this.repository.listWithdrawalAddressBookEntries(
      normalizePagination({
        ...query,
        address:
          query.address && query.network
            ? this.normalizeAddress(query.network, query.address)
            : query.address?.trim()
      })
    );
  }

  async whitelistWithdrawalAddress(addressBookId: string): Promise<WithdrawalAddressBookEntry> {
    return this.setWithdrawalAddressWhitelistStatus({
      addressBookId,
      isWhitelisted: true
    });
  }

  async unwhitelistWithdrawalAddress(addressBookId: string): Promise<WithdrawalAddressBookEntry> {
    return this.setWithdrawalAddressWhitelistStatus({
      addressBookId,
      isWhitelisted: false
    });
  }

  async validateWithdrawalRequest(
    command: RequestWithdrawalCommand
  ): Promise<WithdrawalValidationResult> {
    const validation = await this.validateWithdrawal(command, false);
    return {
      valid: true,
      frozenAmount: validation.frozenAmount,
      appliedRules: validation.appliedRules
    };
  }

  async requestWithdrawal(command: RequestWithdrawalCommand): Promise<WithdrawalRecord> {
    const validation = await this.validateWithdrawal(command, true);
    const frozenAmount = validation.frozenAmount;

    const now = this.now().toISOString();
    const withdrawalId = this.createId();
    const metadata = this.buildWithdrawalMetadata(command.metadata, validation);

    const initialRecord: WithdrawalRecord = {
      withdrawalId,
      userId: command.userId,
      ledgerAccountId: command.ledgerAccountId,
      assetCode: command.assetCode,
      network: command.network,
      toAddress: validation.normalizedToAddress,
      amount: command.amount,
      fee: command.fee,
      frozenAmount: "0",
      freezeReferenceId: withdrawalId,
      status: "requested",
      reviewStatus: "pending",
      requestedAt: now,
      metadata
    };

    await this.repository.withTransaction((repository) => repository.saveWithdrawal(initialRecord));

    try {
      await this.ledgerClient.freezeBalance({
        accountId: command.ledgerAccountId,
        assetCode: command.assetCode,
        amount: frozenAmount,
        referenceType: "withdrawal",
        referenceId: withdrawalId
      });
    } catch (error) {
      const failedRecord: WithdrawalRecord = {
        ...initialRecord,
        status: "failed",
        metadata: {
          ...initialRecord.metadata,
          freezeError: error instanceof Error ? error.message : "unknown freeze error"
        }
      };

      await this.repository.withTransaction((repository) => repository.saveWithdrawal(failedRecord));

      throw new WalletError(
        "LEDGER_FREEZE_FAILED",
        error instanceof Error ? error.message : "Failed to freeze balance"
      );
    }

    const finalRecord: WithdrawalRecord = {
      ...initialRecord,
      frozenAmount
    };

    await this.persistWithdrawalTransition({
      after: finalRecord,
      action: "requested",
      operatorId: command.userId,
      operatorRole: "user",
      notifications: ["withdrawal.requested"],
      metadata: {
        source: "wallet-service",
        trigger: "requestWithdrawal"
      }
    });
    return finalRecord;
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalRecord | null> {
    return this.repository.findWithdrawalById(withdrawalId);
  }

  async listWithdrawals(query: ListWithdrawalsQuery): Promise<PagedResult<WithdrawalRecord>> {
    return this.repository.listWithdrawals(normalizePagination(query));
  }

  async listWithdrawalReviewQueue(
    query: Omit<ListWithdrawalsQuery, "reviewStatus">
  ): Promise<PagedResult<WithdrawalRecord>> {
    // Dual-approval withdrawals stay in the queue until the second approval.
    return this.repository.listWithdrawals(
      normalizePagination({
        ...query,
        reviewStatuses: ["pending", "pending_second_approval"]
      })
    );
  }

  async listWithdrawalAuditLogs(
    query: ListWithdrawalAuditLogsQuery
  ): Promise<PagedResult<WithdrawalAuditLogRecord>> {
    return this.repository.listWithdrawalAuditLogs(normalizePagination(query));
  }

  async listWalletNotifications(
    query: ListWithdrawalNotificationsQuery
  ): Promise<PagedResult<WalletNotificationRecord>> {
    return this.repository.listWalletNotifications(normalizePagination(query));
  }

  async countUnreadWalletNotifications(userId: string): Promise<{ unreadCount: number }> {
    if (!userId) {
      throw new WalletError("NOTIFICATION_NOT_FOUND", "userId is required");
    }
    return { unreadCount: await this.repository.countUnreadWalletNotifications(userId) };
  }

  /**
   * Customer read marker. With notificationIds every id must belong to the
   * user (unknown / foreign ids are a 404, so ids cannot be probed); without
   * them all of the user's unread notifications are marked. Idempotent.
   */
  async markWalletNotificationsRead(
    command: MarkWalletNotificationsReadCommand
  ): Promise<MarkWalletNotificationsReadResult> {
    if (!command.userId) {
      throw new WalletError("NOTIFICATION_NOT_FOUND", "userId is required");
    }

    const notificationIds = command.notificationIds
      ? [...new Set(command.notificationIds.filter((id) => typeof id === "string" && id))]
      : undefined;
    if (notificationIds) {
      for (const notificationId of notificationIds) {
        const record = await this.repository.findWalletNotificationById(notificationId);
        if (!record || record.userId !== command.userId) {
          throw new WalletError(
            "NOTIFICATION_NOT_FOUND",
            `Notification ${notificationId} does not exist`
          );
        }
      }
    }

    const readAt = this.now().toISOString();
    const updated =
      notificationIds && notificationIds.length === 0
        ? 0
        : await this.repository.markWalletNotificationsRead({
            userId: command.userId,
            notificationIds,
            readAt
          });

    return {
      updated,
      readAt,
      unreadCount: await this.repository.countUnreadWalletNotifications(command.userId)
    };
  }

  async confirmWithdrawal(command: ConfirmWithdrawalCommand): Promise<WithdrawalRecord> {
    if (command.confirmations < 0) {
      throw new WalletError(
        "INVALID_CONFIRMATION_COUNT",
        "Confirmations must be greater than or equal to zero"
      );
    }

    const withdrawal = await this.repository.findWithdrawalByTxHash(command.network, command.txHash);
    if (!withdrawal) {
      throw new WalletError(
        "WITHDRAWAL_NOT_FOUND",
        `Withdrawal with txHash ${command.txHash} not found`
      );
    }

    if (withdrawal.status === "confirmed") {
      return withdrawal;
    }

    if (withdrawal.status !== "broadcasted") {
      throw new WalletError(
        "INVALID_WITHDRAWAL_STATE",
        `Withdrawal ${withdrawal.withdrawalId} cannot be confirmed from status ${withdrawal.status}`
      );
    }

    const observedAt = this.now().toISOString();
    const observedRecord: WithdrawalRecord = {
      ...withdrawal,
      metadata: {
        ...withdrawal.metadata,
        blockchain: {
          txHash: command.txHash,
          confirmations: command.confirmations,
          blockNumber: command.blockNumber,
          observedAt
        }
      }
    };

    await this.repository.withTransaction((repository) => repository.saveWithdrawal(observedRecord));

    if (command.confirmations < this.withdrawalConfirmationThreshold) {
      return observedRecord;
    }

    try {
      await this.ledgerClient.consumeBalance({
        accountId: observedRecord.ledgerAccountId,
        assetCode: observedRecord.assetCode,
        referenceType: "withdrawal",
        referenceId: observedRecord.freezeReferenceId
      });
    } catch (error) {
      const failedConfirmationRecord: WithdrawalRecord = {
        ...observedRecord,
        metadata: {
          ...observedRecord.metadata,
          confirmationError: error instanceof Error ? error.message : "unknown ledger consume error"
        }
      };

      await this.repository.withTransaction((repository) =>
        repository.saveWithdrawal(failedConfirmationRecord)
      );

      throw new WalletError(
        "LEDGER_CONSUME_FAILED",
        error instanceof Error ? error.message : "Failed to consume withdrawal balance lock"
      );
    }

    const confirmedAt = this.now().toISOString();
    const confirmedRecord: WithdrawalRecord = {
      ...observedRecord,
      status: "confirmed",
      confirmedAt,
      metadata: {
        ...observedRecord.metadata,
        settlement: {
          action: "settled_balance_lock",
          confirmedAt,
          txHash: command.txHash,
          confirmations: command.confirmations,
          blockNumber: command.blockNumber
        }
      }
    };

    await this.persistWithdrawalTransition({
      before: observedRecord,
      after: confirmedRecord,
      action: "confirmed",
      operatorRole: "system",
      notifications: ["withdrawal.confirmed"],
      metadata: {
        source: "wallet-service",
        trigger: "confirmWithdrawal",
        txHash: command.txHash,
        confirmations: command.confirmations,
        blockNumber: command.blockNumber
      }
    });
    return confirmedRecord;
  }

  async approveWithdrawal(command: ApproveWithdrawalCommand): Promise<WithdrawalRecord> {
    const withdrawal = await this.getRequiredWithdrawal(command.withdrawalId);

    if (withdrawal.status === "broadcasted" || withdrawal.status === "confirmed") {
      return withdrawal;
    }

    let approvedRecord = withdrawal;
    if (withdrawal.reviewStatus !== "approved") {
      this.ensureReviewableWithdrawal(withdrawal, "approve");

      const approvedAt = this.now().toISOString();
      // M5-2: the policy stored at request time wins; legacy rows fall back to
      // the current threshold configuration.
      const policy = readApprovalPolicy(
        withdrawal.metadata,
        resolveApprovalPolicy(
          withdrawal.amount,
          this.withdrawalValidationRules.dualApprovalThresholdByAsset?.[withdrawal.assetCode]
        )
      );
      const decision = applyApproval({
        policy,
        existing: readApprovals(withdrawal.metadata),
        operatorId: command.reviewedBy,
        approvedAt,
        note: command.note
      });

      if (decision.kind === "error") {
        throw new WalletError(
          decision.code === "SAME_APPROVER" ? "WITHDRAWAL_SAME_APPROVER" : "WITHDRAWAL_APPROVER_REQUIRED",
          decision.message
        );
      }

      if (decision.kind === "pending_second_approval") {
        const firstApproved: WithdrawalRecord = {
          ...withdrawal,
          status: "under_review",
          reviewStatus: "pending_second_approval",
          metadata: {
            ...withdrawal.metadata,
            approvalPolicy: policy,
            approvals: decision.approvals,
            review: {
              action: "first_approved",
              reviewedAt: approvedAt,
              reviewedBy: command.reviewedBy,
              note: command.note,
              approvals: `${decision.approvals.length}/${policy.requiredApprovals}`
            }
          }
        };

        await this.persistWithdrawalTransition({
          before: withdrawal,
          after: firstApproved,
          action: "first_approved",
          operatorId: command.reviewedBy,
          operatorRole: "reviewer",
          metadata: {
            source: "wallet-service",
            trigger: "approveWithdrawal",
            note: command.note,
            approvalIndex: decision.approvals.length,
            requiredApprovals: policy.requiredApprovals,
            threshold: policy.threshold
          }
        });
        return firstApproved;
      }

      approvedRecord = {
        ...withdrawal,
        status: "approved",
        reviewStatus: "approved",
        approvedAt,
        metadata: {
          ...withdrawal.metadata,
          approvalPolicy: policy,
          approvals: decision.approvals,
          review: {
            action: "approved",
            reviewedAt: approvedAt,
            reviewedBy: command.reviewedBy,
            note: command.note,
            approvals: `${decision.approvals.length}/${policy.requiredApprovals}`
          }
        }
      };

      await this.persistWithdrawalTransition({
        before: withdrawal,
        after: approvedRecord,
        action: "approved",
        operatorId: command.reviewedBy,
        operatorRole: "reviewer",
        notifications: ["withdrawal.approved"],
        metadata: {
          source: "wallet-service",
          trigger: "approveWithdrawal",
          note: command.note,
          approvalIndex: decision.approvals.length,
          requiredApprovals: policy.requiredApprovals,
          approvedBy: decision.approvals.map((approval) => approval.operatorId)
        }
      });
    } else if (withdrawal.status !== "approved") {
      throw new WalletError(
        "INVALID_WITHDRAWAL_STATE",
        `Withdrawal ${withdrawal.withdrawalId} cannot be approved from status ${withdrawal.status}`
      );
    }

    return this.broadcastApprovedWithdrawal(approvedRecord, {
      requestedBy: command.reviewedBy,
      note: command.note,
      trigger: "approveWithdrawal"
    });
  }

  async rebroadcastWithdrawal(command: RebroadcastWithdrawalCommand): Promise<WithdrawalRecord> {
    const withdrawal = await this.getRequiredWithdrawal(command.withdrawalId);

    if (withdrawal.status === "broadcasted" || withdrawal.status === "confirmed") {
      return withdrawal;
    }

    if (withdrawal.reviewStatus !== "approved" || withdrawal.status !== "approved") {
      throw new WalletError(
        "INVALID_WITHDRAWAL_STATE",
        `Withdrawal ${withdrawal.withdrawalId} cannot be rebroadcast from status ${withdrawal.status}`
      );
    }

    return this.broadcastApprovedWithdrawal(withdrawal, {
      requestedBy: command.requestedBy,
      note: command.note,
      trigger: "rebroadcastWithdrawal"
    });
  }

  async rejectWithdrawal(command: RejectWithdrawalCommand): Promise<WithdrawalRecord> {
    const withdrawal = await this.getRequiredWithdrawal(command.withdrawalId);

    if (withdrawal.reviewStatus === "rejected") {
      return withdrawal;
    }

    this.ensureReviewableWithdrawal(withdrawal, "reject");

    try {
      await this.ledgerClient.releaseBalance({
        accountId: withdrawal.ledgerAccountId,
        assetCode: withdrawal.assetCode,
        referenceType: "withdrawal",
        referenceId: withdrawal.freezeReferenceId
      });
    } catch (error) {
      throw new WalletError(
        "LEDGER_RELEASE_FAILED",
        error instanceof Error ? error.message : "Failed to release frozen balance"
      );
    }

    const reviewedAt = this.now().toISOString();
    const rejectedRecord: WithdrawalRecord = {
      ...withdrawal,
      status: "rejected",
      reviewStatus: "rejected",
      metadata: {
        ...withdrawal.metadata,
        review: {
          action: "rejected",
          reviewedAt,
          reviewedBy: command.reviewedBy,
          reason: command.reason
        }
      }
    };

    await this.persistWithdrawalTransition({
      before: withdrawal,
      after: rejectedRecord,
      action: "rejected",
      operatorId: command.reviewedBy,
      operatorRole: "reviewer",
      notifications: ["withdrawal.rejected"],
      metadata: {
        source: "wallet-service",
        trigger: "rejectWithdrawal",
        reason: command.reason
      }
    });
    return rejectedRecord;
  }

  private async validateWithdrawal(
    command: RequestWithdrawalCommand,
    verifyTwoFactorCode: boolean
  ): Promise<InternalWithdrawalValidationResult> {
    let frozenAmount: string;
    try {
      this.assertSupportedAsset(command.assetCode, command.network);
      if (!this.isPositiveAmount(command.amount)) {
        throw new WalletError("INVALID_AMOUNT", "Amount must be greater than zero");
      }

      if (!isPositiveOrZero(command.fee)) {
        throw new WalletError("INVALID_AMOUNT", "Fee must be greater than or equal to zero");
      }

      frozenAmount = addAmounts(command.amount, command.fee);
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }

      throw new WalletError("INVALID_AMOUNT", "Amount or fee is invalid");
    }

    const normalizedToAddress = this.normalizeAddress(command.network, command.toAddress);
    this.assertDestinationAddress(command.network, normalizedToAddress);

    const rules = this.withdrawalValidationRules;
    const requireTwoFactor = rules.requireTwoFactor ?? false;

    // 2FA status is needed both for "2FA required" and for the cooldown after a
    // 2FA change. Without an identity client (unit tests) it is only fetched
    // when the platform flag demands it, which then fails loudly.
    const twoFactorStatus =
      this.hasIdentityClient() || requireTwoFactor
        ? await this.identityClient.getTwoFactorStatus(command.userId)
        : undefined;

    // M5-2 cooldown runs before any 2FA code is consumed.
    const cooldown = await this.evaluateSecurityCooldown(command.userId, twoFactorStatus?.changedAt);
    if (cooldown.active) {
      throw new WalletError("WITHDRAWAL_SECURITY_COOLDOWN", describeCooldown(cooldown));
    }

    if (requireTwoFactor && !twoFactorStatus?.enabled) {
      throw new WalletError(
        "WITHDRAWAL_2FA_NOT_ENABLED",
        "Two-factor authentication must be enabled before requesting a withdrawal (enable it on the account page)"
      );
    }
    // Once a user has turned 2FA on, every withdrawal needs a code, even when
    // the platform-wide WITHDRAWAL_REQUIRE_2FA flag is off (M4-1).
    const twoFactorChecked = requireTwoFactor || Boolean(twoFactorStatus?.enabled);

    const kycTier = await this.resolveKycTier(command.userId);
    const limits = resolveEffectiveLimits({
      assetCode: command.assetCode,
      tier: kycTier ?? "unverified",
      tierLimits: kycTier ? rules.kycTierLimits : undefined,
      platformSingleLimit: rules.singleLimitByAsset?.[command.assetCode],
      platformDailyLimit: rules.dailyLimitByAsset?.[command.assetCode]
    });
    const approvalPolicy = resolveApprovalPolicy(
      command.amount,
      rules.dualApprovalThresholdByAsset?.[command.assetCode]
    );

    const appliedRules: WithdrawalValidationResult["appliedRules"] = {
      requireTwoFactor: twoFactorChecked,
      requireWhitelist: rules.requireWhitelist ?? false,
      minAmount: rules.minAmountByAsset?.[command.assetCode],
      minFee: rules.minFeeByNetwork?.[command.network],
      singleLimit: limits.singleLimit,
      dailyLimit: limits.dailyLimit,
      dailyUsedAmount: "0",
      kycTier,
      tierSingleLimit: limits.tierLimit?.single,
      tierDailyLimit: limits.tierLimit?.daily,
      requiredApprovals: approvalPolicy.requiredApprovals,
      dualApprovalThreshold: approvalPolicy.threshold,
      securityCooldownSeconds: cooldown.cooldownSeconds
    };

    if (
      appliedRules.minAmount &&
      compareAmounts(command.amount, appliedRules.minAmount) < 0
    ) {
      throw new WalletError(
        "WITHDRAWAL_AMOUNT_BELOW_MINIMUM",
        `Withdrawal amount must be greater than or equal to ${appliedRules.minAmount} ${command.assetCode}`
      );
    }

    if (appliedRules.minFee && compareAmounts(command.fee, appliedRules.minFee) < 0) {
      throw new WalletError(
        "WITHDRAWAL_FEE_BELOW_MINIMUM",
        `Withdrawal fee must be greater than or equal to ${appliedRules.minFee} on ${command.network}`
      );
    }

    if (appliedRules.requireWhitelist) {
      const whitelisted = await this.repository.isWithdrawalAddressWhitelisted(
        command.userId,
        command.network,
        normalizedToAddress
      );

      if (!whitelisted) {
        throw new WalletError(
          "WITHDRAWAL_ADDRESS_NOT_WHITELISTED",
          "Destination address is not whitelisted for this user"
        );
      }
    }

    if (appliedRules.dailyLimit) {
      const { startAt, endAt } = utcDayWindow(this.now());
      appliedRules.dailyUsedAmount = await this.repository.sumWithdrawalsForUser({
        userId: command.userId,
        assetCode: command.assetCode,
        from: startAt,
        to: endAt
      });
    }

    const limitCheck = checkWithdrawalLimits({
      amount: command.amount,
      usedToday: appliedRules.dailyUsedAmount,
      singleLimit: appliedRules.singleLimit,
      dailyLimit: appliedRules.dailyLimit
    });
    if (!limitCheck.ok) {
      const tierNote = kycTier ? ` (KYC tier ${kycTier})` : "";
      throw limitCheck.code === "SINGLE_LIMIT_EXCEEDED"
        ? new WalletError(
            "WITHDRAWAL_SINGLE_LIMIT_EXCEEDED",
            `Withdrawal amount exceeds the single-withdrawal limit of ${limitCheck.limit} ${command.assetCode}${tierNote}`
          )
        : new WalletError(
            "WITHDRAWAL_DAILY_LIMIT_EXCEEDED",
            `Withdrawal amount exceeds the daily limit of ${limitCheck.limit} ${command.assetCode}${tierNote}; ` +
              `used today ${appliedRules.dailyUsedAmount}, remaining ${limitCheck.remainingToday ?? "0"}`
          );
    }

    // The TOTP code is verified last so a request rejected by another rule does
    // not burn the user's current code (codes are single-use).
    let twoFactorVerifiedAt: string | undefined;
    if (twoFactorChecked && verifyTwoFactorCode) {
      const twoFactorCode = this.resolveTwoFactorCode(command);
      if (!twoFactorCode) {
        throw new WalletError(
          "WITHDRAWAL_2FA_REQUIRED",
          "Two-factor verification code is required before requesting a withdrawal"
        );
      }

      const verification = await this.identityClient.verifyTwoFactor({
        userId: command.userId,
        code: twoFactorCode,
        purpose: "wallet_withdrawal_request"
      });
      twoFactorVerifiedAt = verification.verifiedAt;
    }

    return {
      valid: true,
      frozenAmount,
      appliedRules,
      normalizedToAddress,
      twoFactorVerifiedAt
    };
  }

  /** Customer-facing view of tier, limits, today's usage and cooldown. */
  async getWithdrawalLimits(userId: string): Promise<WithdrawalLimitsView> {
    const rules = this.withdrawalValidationRules;
    const twoFactorStatus = this.hasIdentityClient()
      ? await this.identityClient.getTwoFactorStatus(userId)
      : undefined;
    const kycTier = await this.resolveKycTier(userId);
    const cooldown = await this.evaluateSecurityCooldown(userId, twoFactorStatus?.changedAt);
    const dayWindow = utcDayWindow(this.now());

    const assetCodes = new Set<AssetCode>([
      ...(Object.keys(rules.kycTierLimits?.[kycTier ?? "unverified"] ?? {}) as AssetCode[]),
      ...(Object.keys(rules.singleLimitByAsset ?? {}) as AssetCode[]),
      ...(Object.keys(rules.dailyLimitByAsset ?? {}) as AssetCode[])
    ]);

    const assets: WithdrawalAssetLimitView[] = [];
    for (const assetCode of assetCodes) {
      const limits = resolveEffectiveLimits({
        assetCode,
        tier: kycTier ?? "unverified",
        tierLimits: kycTier ? rules.kycTierLimits : undefined,
        platformSingleLimit: rules.singleLimitByAsset?.[assetCode],
        platformDailyLimit: rules.dailyLimitByAsset?.[assetCode]
      });
      const usedToday = await this.repository.sumWithdrawalsForUser({
        userId,
        assetCode,
        from: dayWindow.startAt,
        to: dayWindow.endAt
      });
      assets.push({
        assetCode,
        singleLimit: limits.singleLimit,
        dailyLimit: limits.dailyLimit,
        tierSingleLimit: limits.tierLimit?.single,
        tierDailyLimit: limits.tierLimit?.daily,
        usedToday,
        remainingToday: limits.dailyLimit ? remainingAmount(limits.dailyLimit, usedToday) : undefined,
        dualApprovalThreshold: rules.dualApprovalThresholdByAsset?.[assetCode]
      });
    }

    return {
      userId,
      kycTier,
      kycEnforced: Boolean(kycTier && rules.kycTierLimits),
      requireTwoFactor: rules.requireTwoFactor ?? false,
      twoFactorEnabled: twoFactorStatus?.enabled,
      requireWhitelist: rules.requireWhitelist ?? false,
      dayWindow,
      cooldown,
      assets
    };
  }

  private hasIdentityClient(): boolean {
    return this.identityClient !== unconfiguredIdentityClient;
  }

  /** KYC tiers only apply when tier limits are configured and identity is reachable. */
  private async resolveKycTier(userId: string): Promise<KycTier | undefined> {
    if (!this.withdrawalValidationRules.kycTierLimits || !this.hasIdentityClient()) {
      return undefined;
    }
    const profile = await this.identityClient.getKycProfile(userId);
    return normalizeKycTier(profile.tier);
  }

  private async evaluateSecurityCooldown(
    userId: string,
    twoFactorChangedAt: string | undefined
  ): Promise<CooldownStatus> {
    const cooldownSeconds = this.withdrawalValidationRules.securityCooldownSeconds ?? 0;
    if (cooldownSeconds <= 0) {
      return { active: false, cooldownSeconds: 0, remainingSeconds: 0 };
    }

    const changes: SecurityChange[] = [];
    const latestAddress = await this.repository.listWithdrawalAddressBookEntries({
      userId,
      limit: 1,
      offset: 0
    });
    const newestEntry = latestAddress.items[0];
    if (newestEntry) {
      changes.push({ kind: "withdrawal_address_added", at: newestEntry.createdAt });
    }
    if (twoFactorChangedAt) {
      changes.push({ kind: "two_factor_changed", at: twoFactorChangedAt });
    }
    return evaluateCooldown({ now: this.now(), cooldownSeconds, changes });
  }

  /** Asset and asset/network pair must exist in config/markets.json. */
  private assertSupportedAsset(assetCode: string, network: string): void {
    const asset = getAssetDefinition(assetCode);
    if (!asset) {
      throw new WalletError("UNSUPPORTED_ASSET", `Asset ${assetCode} is not configured`);
    }
    if (!(asset.networks as string[]).includes(network)) {
      throw new WalletError(
        "UNSUPPORTED_ASSET",
        `Asset ${assetCode} is not supported on ${network} (configured: ${asset.networks.join(", ")})`
      );
    }
  }

  private generateAddress(network: CreateDepositAddressCommand["network"]): string {
    if (network === "ethereum" || network === "bsc" || network === "base") {
      return `0x${randomBytes(20).toString("hex")}`;
    }

    return `${network}_${randomBytes(16).toString("hex")}`;
  }

  private isPositiveAmount(amount: string): boolean {
    return toAtomicUnits(amount) > 0n;
  }

  private normalizeAddress(
    network: CreateDepositAddressCommand["network"],
    address: string
  ): string {
    const trimmed = address.trim();
    if (network === "ethereum" || network === "bsc" || network === "base") {
      return trimmed.toLowerCase();
    }

    return trimmed;
  }

  private assertDestinationAddress(network: RequestWithdrawalCommand["network"], address: string): void {
    const trimmed = address.trim();
    const validators: Record<RequestWithdrawalCommand["network"], RegExp> = {
      ethereum: /^0x[a-fA-F0-9]{40}$/,
      bsc: /^0x[a-fA-F0-9]{40}$/,
      base: /^0x[a-fA-F0-9]{40}$/,
      solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      bitcoin: /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/
    };

    if (!validators[network].test(trimmed)) {
      throw new WalletError(
        "INVALID_DESTINATION_ADDRESS",
        `Destination address is not valid for ${network}`
      );
    }
  }

  private resolveTwoFactorCode(command: RequestWithdrawalCommand): string | undefined {
    if (command.twoFactorCode?.trim()) {
      return command.twoFactorCode.trim();
    }

    const metadata = command.metadata;
    if (!metadata) {
      return undefined;
    }

    if (typeof metadata.twoFactorCode === "string" && metadata.twoFactorCode.trim()) {
      return metadata.twoFactorCode.trim();
    }

    const security = metadata.security;
    if (typeof security !== "object" || security === null) {
      return undefined;
    }

    const nestedCode = (security as Record<string, unknown>).twoFactorCode;
    return typeof nestedCode === "string" && nestedCode.trim() ? nestedCode.trim() : undefined;
  }

  private buildWithdrawalMetadata(
    metadata: Record<string, unknown> | undefined,
    validation: InternalWithdrawalValidationResult
  ): Record<string, unknown> {
    const nextMetadata = metadata ? { ...metadata } : {};
    delete nextMetadata.twoFactorCode;
    delete nextMetadata.twoFactorVerified;

    const existingSecurity =
      typeof nextMetadata.security === "object" && nextMetadata.security !== null
        ? { ...(nextMetadata.security as Record<string, unknown>) }
        : {};
    delete existingSecurity.twoFactorCode;
    delete existingSecurity.twoFactorVerified;

    if (validation.twoFactorVerifiedAt) {
      existingSecurity.twoFactorVerifiedAt = validation.twoFactorVerifiedAt;
      existingSecurity.twoFactorPurpose = "wallet_withdrawal_request";
      existingSecurity.twoFactorProvider = "identity-service";
    }

    const otelTraceId = currentTraceId();
    return {
      ...nextMetadata,
      validation: validation.appliedRules,
      // M5-2: fixed at request time so a config change cannot downgrade review.
      approvalPolicy: {
        requiredApprovals: validation.appliedRules.requiredApprovals ?? 1,
        threshold: validation.appliedRules.dualApprovalThreshold
      },
      approvals: [],
      security: existingSecurity,
      // Jaeger deep link for the request that created the withdrawal.
      ...(otelTraceId ? { otelTraceId } : {})
    };
  }

  private async setWithdrawalAddressWhitelistStatus(
    command: SetWithdrawalAddressWhitelistStatusCommand
  ): Promise<WithdrawalAddressBookEntry> {
    const entry = await this.repository.findWithdrawalAddressBookEntryById(command.addressBookId);
    if (!entry) {
      throw new WalletError(
        "ADDRESS_BOOK_ENTRY_NOT_FOUND",
        `Withdrawal address book entry ${command.addressBookId} not found`
      );
    }

    const updated = await this.repository.withTransaction((repository) =>
      repository.setWithdrawalAddressWhitelistStatus(command)
    );
    if (!updated) {
      throw new WalletError(
        "ADDRESS_BOOK_ENTRY_NOT_FOUND",
        `Withdrawal address book entry ${command.addressBookId} not found`
      );
    }

    return updated;
  }

  private async persistWithdrawalTransition(params: {
    before?: WithdrawalRecord;
    after: WithdrawalRecord;
    action: WithdrawalAuditAction;
    operatorId?: string;
    operatorRole?: string;
    notifications?: WithdrawalNotificationEventType[];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const createdAt = this.now().toISOString();
    const auditLog = this.buildWithdrawalAuditLog({
      before: params.before,
      after: params.after,
      action: params.action,
      operatorId: params.operatorId,
      operatorRole: params.operatorRole,
      metadata: params.metadata,
      createdAt
    });
    const notifications = (params.notifications ?? []).map((eventType) =>
      this.buildWithdrawalNotification(params.after, eventType, createdAt)
    );

    await this.repository.withTransaction(async (repository) => {
      await repository.saveWithdrawal(params.after);
      await repository.saveWithdrawalAuditLog(auditLog);

      for (const notification of notifications) {
        await repository.saveWalletNotification(notification);
      }
    });

    await this.publishWithdrawal(params.after);
    await this.publishNotifications(notifications);
  }

  private buildWithdrawalAuditLog(params: {
    before?: WithdrawalRecord;
    after: WithdrawalRecord;
    action: WithdrawalAuditAction;
    operatorId?: string;
    operatorRole?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }): WithdrawalAuditLogRecord {
    return {
      auditLogId: randomUUID(),
      withdrawalId: params.after.withdrawalId,
      operatorId: params.operatorId,
      operatorRole: params.operatorRole,
      action: params.action,
      traceId: `withdrawal:${params.after.withdrawalId}:${params.action}`,
      beforeSnapshot: snapshotWithdrawal(params.before),
      afterSnapshot: snapshotWithdrawal(params.after),
      metadata: params.metadata ?? {},
      createdAt: params.createdAt
    };
  }

  private async broadcastApprovedWithdrawal(
    approvedRecord: WithdrawalRecord,
    params: {
      requestedBy?: string;
      note?: string;
      trigger: string;
    }
  ): Promise<WithdrawalRecord> {
    try {
      const transfer = await this.custodyClient.createTransfer({
        withdrawalId: approvedRecord.withdrawalId,
        assetCode: approvedRecord.assetCode,
        network: approvedRecord.network,
        toAddress: approvedRecord.toAddress,
        amount: approvedRecord.amount,
        fee: approvedRecord.fee,
        metadata: {
          userId: approvedRecord.userId,
          reviewedBy: params.requestedBy,
          note: params.note,
          // Custody layering: withdrawals are always paid from the hot wallet.
          sourceWallet: "hot"
        }
      });

      const broadcastedAt = this.now().toISOString();
      const broadcastedRecord: WithdrawalRecord = {
        ...approvedRecord,
        status: "broadcasted",
        broadcastedAt,
        custodyRequestId: transfer.custodyRequestId,
        txHash: transfer.txHash,
        metadata: {
          ...approvedRecord.metadata,
          broadcast: {
            providerName: transfer.providerName,
            custodyRequestId: transfer.custodyRequestId,
            txHash: transfer.txHash,
            broadcastedAt
          }
        }
      };

      await this.persistWithdrawalTransition({
        before: approvedRecord,
        after: broadcastedRecord,
        action: "broadcasted",
        operatorRole: "system",
        notifications: ["withdrawal.broadcasted"],
        metadata: {
          source: "wallet-service",
          trigger: params.trigger,
          requestedBy: params.requestedBy,
          note: params.note,
          providerName: transfer.providerName,
          custodyRequestId: transfer.custodyRequestId,
          txHash: transfer.txHash
        }
      });
      return broadcastedRecord;
    } catch (error) {
      const nextApprovedRecord: WithdrawalRecord = {
        ...approvedRecord,
        metadata: {
          ...approvedRecord.metadata,
          broadcastError: error instanceof Error ? error.message : "unknown custody error"
        }
      };

      await this.repository.withTransaction((repository) =>
        repository.saveWithdrawal(nextApprovedRecord)
      );

      throw new WalletError(
        "CUSTODY_TRANSFER_FAILED",
        error instanceof Error ? error.message : "Failed to broadcast custody transfer"
      );
    }
  }

  private buildWithdrawalNotification(
    record: WithdrawalRecord,
    eventType: WithdrawalNotificationEventType,
    createdAt: string
  ): WalletNotificationRecord {
    const content = this.getWithdrawalNotificationContent(record, eventType);

    return {
      notificationId: randomUUID(),
      userId: record.userId,
      withdrawalId: record.withdrawalId,
      eventType,
      channel: "inbox",
      status: "pending",
      subject: content.subject,
      body: content.body,
      payload: {
        withdrawalId: record.withdrawalId,
        assetCode: record.assetCode,
        network: record.network,
        amount: record.amount,
        fee: record.fee,
        toAddress: record.toAddress,
        status: record.status,
        reviewStatus: record.reviewStatus,
        txHash: record.txHash,
        custodyRequestId: record.custodyRequestId
      },
      createdAt,
      deliveryAttempts: 0,
      deliveryReceipt: {}
    };
  }

  private buildDepositCreditedNotification(record: DepositRecord): WalletNotificationRecord {
    return {
      notificationId: randomUUID(),
      userId: record.userId,
      depositId: record.depositId,
      eventType: "deposit.credited",
      channel: "inbox",
      status: "pending",
      subject: "Deposit credited",
      body: `Deposit ${record.depositId} for ${record.amount} ${record.assetCode} has been credited to your spot account.`,
      payload: {
        depositId: record.depositId,
        assetCode: record.assetCode,
        network: record.network,
        amount: record.amount,
        txHash: record.txHash,
        status: record.status,
        ledgerJournalId: record.ledgerJournalId
      },
      createdAt: record.creditedAt ?? this.now().toISOString(),
      deliveryAttempts: 0,
      deliveryReceipt: {}
    };
  }

  private getWithdrawalNotificationContent(
    record: WithdrawalRecord,
    eventType: WithdrawalNotificationEventType
  ): { subject: string; body: string } {
    switch (eventType) {
      case "withdrawal.requested":
        return {
          subject: "Withdrawal request received",
          body: `Withdrawal ${record.withdrawalId} for ${record.amount} ${record.assetCode} has been received and is pending review.`
        };
      case "withdrawal.approved":
        return {
          subject: "Withdrawal approved",
          body: `Withdrawal ${record.withdrawalId} for ${record.amount} ${record.assetCode} has passed review.`
        };
      case "withdrawal.rejected":
        return {
          subject: "Withdrawal rejected",
          body: `Withdrawal ${record.withdrawalId} for ${record.amount} ${record.assetCode} was rejected during review.`
        };
      case "withdrawal.broadcasted":
        return {
          subject: "Withdrawal broadcasted",
          body: `Withdrawal ${record.withdrawalId} has been broadcast on ${record.network} with txHash ${record.txHash ?? "pending"}.`
        };
      case "withdrawal.confirmed":
        return {
          subject: "Withdrawal confirmed",
          body: `Withdrawal ${record.withdrawalId} has been confirmed on ${record.network}.`
        };
      default:
        return {
          subject: "Withdrawal update",
          body: `Withdrawal ${record.withdrawalId} has a new status ${record.status}.`
        };
    }
  }

  private async publishNotifications(notifications: WalletNotificationRecord[]): Promise<void> {
    const results = await Promise.allSettled(
      notifications.map((notification) => this.eventPublisher.publishNotificationCreated(notification))
    );

    for (const result of results) {
      if (result.status === "rejected") {
        process.stderr.write(
          `[wallet-service] notification event publish degraded: ${
            result.reason instanceof Error ? result.reason.message : "unknown error"
          }\n`
        );
      }
    }
  }

  private async publishDeposit(deposit: DepositRecord): Promise<void> {
    try {
      await this.eventPublisher.publishDepositUpdated(deposit);
    } catch (error) {
      process.stderr.write(
        `[wallet-service] deposit event publish degraded: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`
      );
    }
  }

  private async publishWithdrawal(withdrawal: WithdrawalRecord): Promise<void> {
    try {
      await this.eventPublisher.publishWithdrawalUpdated(withdrawal);
    } catch (error) {
      process.stderr.write(
        `[wallet-service] withdrawal event publish degraded: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`
      );
    }
  }

  private async getRequiredWithdrawal(withdrawalId: string): Promise<WithdrawalRecord> {
    const withdrawal = await this.repository.findWithdrawalById(withdrawalId);
    if (!withdrawal) {
      throw new WalletError("WITHDRAWAL_NOT_FOUND", `Withdrawal ${withdrawalId} not found`);
    }

    return withdrawal;
  }

  private ensureReviewableWithdrawal(
    withdrawal: WithdrawalRecord,
    action: "approve" | "reject"
  ): void {
    if (withdrawal.reviewStatus !== "pending" && withdrawal.reviewStatus !== "pending_second_approval") {
      throw new WalletError(
        "INVALID_WITHDRAWAL_STATE",
        `Withdrawal ${withdrawal.withdrawalId} cannot be ${action}d from review status ${withdrawal.reviewStatus}`
      );
    }

    if (withdrawal.status !== "requested" && withdrawal.status !== "under_review") {
      throw new WalletError(
        "INVALID_WITHDRAWAL_STATE",
        `Withdrawal ${withdrawal.withdrawalId} cannot be ${action}d from status ${withdrawal.status}`
      );
    }
  }
}

function normalizePagination<T extends { limit?: number; offset?: number }>(query: T): T {
  return {
    ...query,
    limit: query.limit && query.limit > 0 ? Math.min(query.limit, 200) : 50,
    offset: query.offset && query.offset > 0 ? query.offset : 0
  };
}

function snapshotWithdrawal(record: WithdrawalRecord | undefined): Record<string, unknown> {
  if (!record) {
    return {};
  }

  return {
    withdrawalId: record.withdrawalId,
    userId: record.userId,
    ledgerAccountId: record.ledgerAccountId,
    assetCode: record.assetCode,
    network: record.network,
    toAddress: record.toAddress,
    amount: record.amount,
    fee: record.fee,
    frozenAmount: record.frozenAmount,
    freezeReferenceId: record.freezeReferenceId,
    status: record.status,
    reviewStatus: record.reviewStatus,
    requestedAt: record.requestedAt,
    approvedAt: record.approvedAt,
    broadcastedAt: record.broadcastedAt,
    confirmedAt: record.confirmedAt,
    custodyRequestId: record.custodyRequestId,
    txHash: record.txHash,
    metadata: record.metadata
  };
}
