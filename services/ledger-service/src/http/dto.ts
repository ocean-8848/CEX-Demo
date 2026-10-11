import type { AccountType, AssetCode, TransferDirection } from "@web3-cex/domain";

export interface CreateAccountRequestDto {
  accountId: string;
  userId?: string;
  accountType: AccountType;
  status?: "active" | "suspended" | "closed";
}

export interface JournalLineDto {
  accountId: string;
  assetCode: AssetCode;
  direction: TransferDirection;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface PostJournalRequestDto {
  businessType: string;
  businessId: string;
  idempotencyKey: string;
  traceId: string;
  description?: string;
  entries: JournalLineDto[];
}

export interface FreezeBalanceRequestDto {
  accountId: string;
  assetCode: AssetCode;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface ReleaseBalanceRequestDto {
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
  amount?: string;
}

export interface ConsumeBalanceRequestDto {
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
  amount?: string;
  settlementAccountId?: string;
  traceId?: string;
  businessId?: string;
  description?: string;
}

export interface ListJournalsQueryDto {
  businessType?: string;
  businessId?: string;
  idempotencyKey?: string;
  limit?: string;
  offset?: string;
}

export interface ListBalancesQueryDto {
  userId?: string;
  accountId?: string;
  assetCode?: AssetCode;
  accountType?: AccountType;
  accountStatus?: "active" | "suspended" | "closed";
  limit?: string;
  offset?: string;
}

export interface ListEntriesQueryDto {
  assetCode?: AssetCode;
  journalId?: string;
  businessType?: string;
  businessId?: string;
  referenceType?: string;
  referenceId?: string;
  limit?: string;
  offset?: string;
}

export interface GetAccountStatementQueryDto {
  assetCode?: AssetCode;
  category?: string;
  businessType?: string;
  includeLockEvents?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

export interface GetLedgerReconciliationQueryDto {
  accountId?: string;
  assetCode?: AssetCode;
  includeMatched?: string;
}

export interface GetLedgerReplayQueryDto {
  accountId?: string;
  assetCode?: AssetCode;
}

export interface GetLedgerOpsOverviewQueryDto {
  staleLockMinutes?: string;
}

export interface RunLedgerReconciliationRequestDto {
  accountId?: string;
  assetCode?: AssetCode;
  includeMatched?: boolean;
}

export interface RunLedgerReplayRequestDto {
  accountId: string;
  assetCode: AssetCode;
}

export interface DrainLedgerOutboxRequestDto {
  requeueDeadLetter?: boolean;
  maxCycles?: number;
}
