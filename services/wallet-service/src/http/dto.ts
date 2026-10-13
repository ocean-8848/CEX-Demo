import type { AssetCode, Network } from "@web3-cex/domain";
import type {
  DepositStatus,
  WalletNotificationChannel,
  WalletNotificationEventType,
  WalletNotificationReadState,
  WalletNotificationStatus,
  WithdrawalAuditAction,
  WithdrawalNotificationEventType,
  WithdrawalReviewStatus,
  WithdrawalStatus
} from "../domain/types.js";

export interface CreateDepositAddressRequestDto {
  userId: string;
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
}

export interface ConfirmDepositRequestDto {
  network: Network;
  txHash: string;
  address: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
}

export interface ListDepositAddressesQueryDto {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: "active" | "disabled";
  address?: string;
  limit?: string;
  offset?: string;
}

export interface ListDepositsQueryDto {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: DepositStatus;
  txHash?: string;
  address?: string;
  limit?: string;
  offset?: string;
}

export interface CreateWithdrawalAddressBookEntryRequestDto {
  userId: string;
  network: Network;
  address: string;
  label: string;
  isWhitelisted?: boolean;
}

export interface ListWithdrawalAddressBookQueryDto {
  userId?: string;
  network?: Network;
  address?: string;
  isWhitelisted?: string;
  limit?: string;
  offset?: string;
}

export interface RequestWithdrawalRequestDto {
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

export interface ListWithdrawalsQueryDto {
  userId?: string;
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: WithdrawalStatus;
  reviewStatus?: WithdrawalReviewStatus;
  txHash?: string;
  toAddress?: string;
  riskLevel?: string;
  limit?: string;
  offset?: string;
}

export interface ListWithdrawalAuditLogsQueryDto {
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
  limit?: string;
  offset?: string;
}

export interface ListWalletNotificationsQueryDto {
  userId?: string;
  withdrawalId?: string;
  depositId?: string;
  eventType?: WalletNotificationEventType;
  status?: WalletNotificationStatus;
  channel?: WalletNotificationChannel;
  readState?: WalletNotificationReadState;
  limit?: string;
  offset?: string;
}

export interface ApproveWithdrawalRequestDto {
  reviewedBy?: string;
  note?: string;
}

export interface RejectWithdrawalRequestDto {
  reviewedBy?: string;
  reason?: string;
}

export interface ConfirmWithdrawalRequestDto {
  network: Network;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
}

export interface MarkWalletNotificationsReadRequestDto {
  userId: string;
  /** Omit to mark every unread notification of the user. */
  notificationIds?: string[];
}

export interface DeliverWalletNotificationsRequestDto {
  limit?: number;
}

export interface ReconcileStaleWithdrawalsRequestDto {
  staleMinutes?: number;
  rebroadcastAutoConfirm?: boolean;
  forceConfirmations?: number;
  forceBlockNumber?: number;
  pageSize?: number;
  operatorId?: string;
}

export interface ListAddressBlacklistQueryDto {
  network?: Network;
  address?: string;
  status?: string;
  category?: string;
  limit?: string;
  offset?: string;
}

export interface AddAddressBlacklistEntryRequestDto {
  network?: Network;
  address?: string;
  category?: string;
  reason?: string;
  createdBy?: string;
}

export interface RemoveAddressBlacklistEntryRequestDto {
  reason?: string;
  removedBy?: string;
}

export interface CreateSecurityNotificationRequestDto {
  userId?: string;
  eventType?: string;
  subject?: string;
  body?: string;
  payload?: Record<string, unknown>;
}
