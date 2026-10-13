import type {
  AccountType,
  AssetCode,
  Network,
  OrderStatus,
  OrderType,
  SpotMarket,
  TimeInForce
} from "@web3-cex/domain";

export interface RegisterCustomerRequestDto {
  email: string;
  password: string;
  displayName?: string;
}

export interface CreateCustomerSessionRequestDto {
  email: string;
  password: string;
  twoFactorCode?: string;
  /** Long-lived random id trader-web keeps in localStorage (new-device detection). */
  deviceId?: string;
}

export interface TwoFactorCodeRequestDto {
  /** 6-digit TOTP code (disable also accepts a recovery code). */
  code?: string;
}

export interface SubmitKycRequestDto {
  requestedTier?: "L1" | "L2";
  /** Demo field — never enter real personal data. */
  fullName?: string;
  /** Demo field — masked to the last 4 characters before it is stored. */
  idNumber?: string;
}

export interface CreateApiKeyRequestDto {
  label: string;
  /** Subset of read / trade / withdraw; defaults to read + trade. */
  scopes?: string[];
  expiresAt?: string;
}

export interface ListBalancesQueryDto {
  accountId?: string;
  assetCode?: AssetCode;
  accountType?: AccountType;
  accountStatus?: "active" | "suspended" | "closed";
  limit?: string;
  offset?: string;
}

export interface CreateDepositAddressRequestDto {
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
}

export interface ListDepositAddressesQueryDto {
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: "active" | "disabled";
  address?: string;
  limit?: string;
  offset?: string;
}

export interface ListDepositsQueryDto {
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: string;
  txHash?: string;
  address?: string;
  limit?: string;
  offset?: string;
}

export interface ListWithdrawalsQueryDto {
  ledgerAccountId?: string;
  assetCode?: AssetCode;
  network?: Network;
  status?: string;
  reviewStatus?: string;
  txHash?: string;
  toAddress?: string;
  limit?: string;
  offset?: string;
}

export interface ListWalletNotificationsQueryDto {
  withdrawalId?: string;
  depositId?: string;
  eventType?: string;
  status?: string;
  channel?: string;
  /** read | unread (customer read marker). */
  readState?: string;
  limit?: string;
  offset?: string;
}

export interface GetLedgerStatementQueryDto {
  assetCode?: string;
  /** deposit | withdrawal | trade | adjustment | fee */
  category?: string;
  /** Alias accepted for the raw ledger journal business type. */
  businessType?: string;
  /** "false" hides freeze / release lines. */
  includeLockEvents?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

export interface ValidateWithdrawalRequestDto {
  ledgerAccountId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  twoFactorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestWithdrawalRequestDto extends ValidateWithdrawalRequestDto {}

export interface ListWithdrawalAddressBookQueryDto {
  network?: Network;
  address?: string;
  isWhitelisted?: string;
  limit?: string;
  offset?: string;
}

export interface CreateWithdrawalAddressBookEntryRequestDto {
  network: Network;
  address: string;
  label: string;
  isWhitelisted?: boolean;
}

export interface CreateSpotOrderRequestDto {
  accountId: string;
  market: SpotMarket;
  side: "buy" | "sell";
  type: OrderType;
  timeInForce?: TimeInForce;
  price?: string;
  quantity: string;
  idempotencyKey: string;
  traceId?: string;
}

export interface ListSpotOrdersQueryDto {
  accountId?: string;
  market?: SpotMarket;
  status?: OrderStatus;
  limit?: string;
  offset?: string;
}

export interface ListSpotTradesQueryDto {
  market?: SpotMarket;
  orderId?: string;
  limit?: string;
  offset?: string;
}
