import type { AssetCode, Network } from "@web3-cex/domain";

import type {
  CooldownStatus,
  KycTier,
  KycTierLimitTable
} from "./withdrawal-policy.js";

export type DepositStatus = "detected" | "confirming" | "confirmed" | "credited" | "failed";
export type WithdrawalStatus =
  | "requested"
  | "under_review"
  | "approved"
  | "broadcasted"
  | "confirmed"
  | "failed"
  | "rejected";

/**
 * `pending_second_approval`: a dual-approval withdrawal (M5-2) got its first
 * approval and waits for a different operator.
 */
export type WithdrawalReviewStatus = "pending" | "pending_second_approval" | "approved" | "rejected";
export type WithdrawalAuditAction =
  | "requested"
  | "first_approved"
  | "approved"
  | "rejected"
  | "broadcasted"
  | "confirmed";
export type WithdrawalNotificationEventType =
  | "withdrawal.requested"
  | "withdrawal.approved"
  | "withdrawal.rejected"
  | "withdrawal.broadcasted"
  | "withdrawal.confirmed";
export type DepositNotificationEventType = "deposit.credited";
export type WalletNotificationEventType =
  | WithdrawalNotificationEventType
  | DepositNotificationEventType;
export type WalletNotificationReadState = "read" | "unread";
export type WalletNotificationChannel = "inbox";
export type WalletNotificationStatus = "pending" | "delivered" | "failed";

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateDepositAddressCommand {
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
}

export interface ConfirmDepositCommand {
  network: Network;
  txHash: string;
  address: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
}

export interface ListDepositAddressesQuery {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: WalletAddress["status"];
  address?: string;
  limit?: number;
  offset?: number;
}

export interface ListDepositsQuery {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: DepositStatus;
  txHash?: string;
  address?: string;
  limit?: number;
  offset?: number;
}

export interface WalletAddress {
  walletAddressId: string;
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
  address: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface DepositRecord {
  depositId: string;
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
  address: string;
  txHash: string;
  amount: string;
  confirmations: number;
  status: DepositStatus;
  blockNumber?: number;
  detectedAt: string;
  confirmedAt?: string;
  creditedAt?: string;
  ledgerJournalId?: string;
  metadata: Record<string, unknown>;
}

export interface LedgerDepositCreditCommand {
  depositId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  amount: string;
  traceId: string;
}

export interface LedgerFreezeBalanceCommand {
  accountId: string;
  assetCode: AssetCode;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface LedgerReleaseBalanceCommand {
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
}

export interface LedgerConsumeBalanceCommand {
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
}

export interface RequestWithdrawalCommand {
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  twoFactorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface ListWithdrawalsQuery {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: WithdrawalStatus;
  reviewStatus?: WithdrawalReviewStatus;
  /** Matches any of these review statuses (used by the review queue). */
  reviewStatuses?: WithdrawalReviewStatus[];
  txHash?: string;
  toAddress?: string;
  limit?: number;
  offset?: number;
}

export interface ListWithdrawalAuditLogsQuery {
  withdrawalId?: string;
  userId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: WithdrawalStatus;
  reviewStatus?: WithdrawalReviewStatus;
  txHash?: string;
  toAddress?: string;
  action?: WithdrawalAuditAction;
  operatorId?: string;
  limit?: number;
  offset?: number;
}

export interface ListWithdrawalNotificationsQuery {
  userId?: string;
  withdrawalId?: string;
  depositId?: string;
  eventType?: WalletNotificationEventType;
  status?: WalletNotificationStatus;
  channel?: WalletNotificationChannel;
  /** Customer-facing read marker filter (independent of delivery status). */
  readState?: WalletNotificationReadState;
  limit?: number;
  offset?: number;
}

export interface CreateWithdrawalAddressBookEntryCommand {
  userId: string;
  network: Network;
  address: string;
  label: string;
  isWhitelisted?: boolean;
}

export interface UpsertWithdrawalAddressBookEntryCommand {
  userId: string;
  network: Network;
  address: string;
  label: string;
  isWhitelisted: boolean;
}

export interface ListWithdrawalAddressBookQuery {
  userId?: string;
  network?: Network;
  address?: string;
  isWhitelisted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SetWithdrawalAddressWhitelistStatusCommand {
  addressBookId: string;
  isWhitelisted: boolean;
}

export interface WithdrawalAddressBookEntry {
  addressBookId: string;
  userId: string;
  network: Network;
  address: string;
  label: string;
  isWhitelisted: boolean;
  createdAt: string;
}

export interface WithdrawalValidationRules {
  requireTwoFactor?: boolean;
  requireWhitelist?: boolean;
  minAmountByAsset?: Partial<Record<AssetCode, string>>;
  minFeeByNetwork?: Partial<Record<Network, string>>;
  singleLimitByAsset?: Partial<Record<AssetCode, string>>;
  dailyLimitByAsset?: Partial<Record<AssetCode, string>>;
  /** M4-4: per-tier limits; when omitted KYC tiers are not enforced. */
  kycTierLimits?: KycTierLimitTable;
  /** M5-2: amounts strictly above this need two different approvers. */
  dualApprovalThresholdByAsset?: Partial<Record<AssetCode, string>>;
  /** M5-2: lock withdrawals after a security change (0 disables). */
  securityCooldownSeconds?: number;
}

export interface WithdrawalValidationResult {
  valid: true;
  frozenAmount: string;
  appliedRules: {
    requireTwoFactor: boolean;
    requireWhitelist: boolean;
    minAmount?: string;
    minFee?: string;
    singleLimit?: string;
    dailyLimit?: string;
    dailyUsedAmount: string;
    kycTier?: KycTier;
    tierSingleLimit?: string;
    tierDailyLimit?: string;
    requiredApprovals?: 1 | 2;
    dualApprovalThreshold?: string;
    securityCooldownSeconds?: number;
  };
}

export interface WithdrawalAssetLimitView {
  assetCode: AssetCode;
  singleLimit?: string;
  dailyLimit?: string;
  tierSingleLimit?: string;
  tierDailyLimit?: string;
  usedToday: string;
  remainingToday?: string;
  dualApprovalThreshold?: string;
}

/** What the customer sees on the account / withdraw pages. */
export interface WithdrawalLimitsView {
  userId: string;
  kycTier?: KycTier;
  kycEnforced: boolean;
  requireTwoFactor: boolean;
  twoFactorEnabled?: boolean;
  requireWhitelist: boolean;
  dayWindow: { startAt: string; endAt: string };
  cooldown: CooldownStatus;
  assets: WithdrawalAssetLimitView[];
}

export interface ApproveWithdrawalCommand {
  withdrawalId: string;
  reviewedBy?: string;
  note?: string;
}

export interface RebroadcastWithdrawalCommand {
  withdrawalId: string;
  requestedBy?: string;
  note?: string;
}

export interface RejectWithdrawalCommand {
  withdrawalId: string;
  reviewedBy?: string;
  reason?: string;
}

export interface ConfirmWithdrawalCommand {
  network: Network;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  frozenAmount: string;
  freezeReferenceId: string;
  status: WithdrawalStatus;
  reviewStatus: WithdrawalReviewStatus;
  requestedAt: string;
  approvedAt?: string;
  broadcastedAt?: string;
  confirmedAt?: string;
  custodyRequestId?: string;
  txHash?: string;
  metadata: Record<string, unknown>;
}

export interface WithdrawalAuditLogRecord {
  auditLogId: string;
  withdrawalId: string;
  operatorId?: string;
  operatorRole?: string;
  action: WithdrawalAuditAction;
  traceId?: string;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WalletNotificationRecord {
  notificationId: string;
  userId: string;
  /** Exactly one of withdrawalId / depositId is set. */
  withdrawalId?: string;
  depositId?: string;
  eventType: WalletNotificationEventType;
  channel: WalletNotificationChannel;
  status: WalletNotificationStatus;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  createdAt: string;
  deliveryAttempts: number;
  deliveryReceipt: Record<string, unknown>;
  lastAttemptedAt?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  lastError?: string;
  /** When the customer marked it read; undefined means unread. */
  readAt?: string;
}

export interface MarkWalletNotificationsReadCommand {
  userId: string;
  /** Omitted = mark every unread notification of the user. */
  notificationIds?: string[];
}

export interface MarkWalletNotificationsReadResult {
  updated: number;
  readAt: string;
  unreadCount: number;
}
