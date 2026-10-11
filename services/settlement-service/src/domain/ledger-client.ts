import type { AccountType, AssetCode } from "@web3-cex/domain";

export interface SettlementLedgerAccount {
  accountId: string;
  userId?: string;
  accountType: AccountType;
  status: "active" | "suspended" | "closed";
}

export interface SettlementLedgerClient {
  getAccount(accountId: string): Promise<SettlementLedgerAccount | null>;
  createAccount(command: {
    accountId: string;
    userId?: string;
    accountType: AccountType;
  }): Promise<SettlementLedgerAccount>;
  consumeBalance(command: {
    accountId: string;
    assetCode: AssetCode;
    referenceType: string;
    referenceId: string;
    amount: string;
    settlementAccountId: string;
    businessId: string;
    traceId: string;
    description: string;
  }): Promise<Record<string, unknown>>;
  postJournal(command: {
    businessType: string;
    businessId: string;
    idempotencyKey: string;
    traceId: string;
    description: string;
    entries: Array<{
      accountId: string;
      assetCode: AssetCode;
      direction: "debit" | "credit";
      amount: string;
      referenceType: string;
      referenceId: string;
    }>;
  }): Promise<{ journalId: string }>;
}
