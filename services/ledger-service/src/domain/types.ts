import type {
  AccountType,
  AssetCode,
  DomainEvent,
  TransferDirection
} from "@web3-cex/domain";

export interface CreateAccountCommand {
  accountId: string;
  userId?: string;
  accountType: AccountType;
  status?: "active" | "suspended" | "closed";
}

export interface LedgerAccount {
  accountId: string;
  userId?: string;
  accountType: AccountType;
  status: "active" | "suspended" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface JournalLine {
  accountId: string;
  assetCode: AssetCode;
  direction: TransferDirection;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface PostJournalCommand {
  businessType: string;
  businessId: string;
  idempotencyKey: string;
  traceId: string;
  description?: string;
  entries: JournalLine[];
}

export interface FreezeBalanceCommand {
  accountId: string;
  assetCode: AssetCode;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface ReleaseBalanceCommand {
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
  amount?: string;
}

export interface ConsumeBalanceCommand {
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

export interface LedgerJournal {
  journalId: string;
  businessType: string;
  businessId: string;
  idempotencyKey: string;
  traceId: string;
  description?: string;
  entries: JournalLine[];
  createdAt: string;
}

export interface LedgerJournalSummary {
  journalId: string;
  businessType: string;
  businessId: string;
  idempotencyKey: string;
  traceId: string;
  description?: string;
  entryCount: number;
  assetCodes: AssetCode[];
  createdAt: string;
}

export interface ListJournalsQuery {
  businessType?: string;
  businessId?: string;
  idempotencyKey?: string;
  limit?: number;
  offset?: number;
}

export interface BalanceSnapshot {
  accountId: string;
  assetCode: AssetCode;
  available: string;
  locked: string;
  version: number;
  updatedAt: string;
}

export interface BalanceLock {
  lockId: string;
  accountId: string;
  assetCode: AssetCode;
  referenceType: string;
  referenceId: string;
  amount: string;
  remainingAmount: string;
  status: "locked" | "released" | "consumed" | "settled";
  createdAt: string;
  releasedAt?: string;
  consumedAt?: string;
}

export interface LedgerEntryRecord extends JournalLine {
  entryId: string;
  journalId: string;
  businessType: string;
  businessId: string;
  traceId: string;
  description?: string;
  createdAt: string;
}

export interface ListEntriesQuery {
  accountId: string;
  assetCode?: AssetCode;
  journalId?: string;
  businessType?: string;
  businessId?: string;
  referenceType?: string;
  referenceId?: string;
  limit?: number;
  offset?: number;
}

export interface LedgerBalanceListItem extends BalanceSnapshot {
  userId?: string;
  accountType: AccountType;
  accountStatus: LedgerAccount["status"];
  total: string;
}

export interface ListBalancesQuery {
  userId?: string;
  accountId?: string;
  assetCode?: AssetCode;
  accountType?: AccountType;
  accountStatus?: LedgerAccount["status"];
  limit?: number;
  offset?: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type LedgerEventPayload =
  | {
      journalId: string;
      businessType: string;
      businessId: string;
      entryCount: number;
      assetCodes: AssetCode[];
    }
  | {
      accountId: string;
      assetCode: AssetCode;
      referenceType: string;
      referenceId: string;
      amount: string;
    };

export type LedgerEvent = DomainEvent<LedgerEventPayload>;

export interface OutboxEventRecord {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  publishedAt?: string;
  publishAttempts: number;
  lastError?: string;
  lastAttemptedAt?: string;
  nextAttemptAt?: string;
  deadLetteredAt?: string;
}

// ---------------------------------------------------------------------------
// Account statement (M4-5): customer-facing 资金流水
// ---------------------------------------------------------------------------

/** A journal entry of the account plus the fee charged in the same journal (trade credits only). */
export interface StatementEntrySource extends LedgerEntryRecord {
  feeAmount?: string;
  feeAssetCode?: AssetCode;
}

/** A balance.locked / balance.released / balance.consumed outbox event of the account. */
export interface StatementLockEventSource {
  eventId: string;
  eventType: "balance.locked" | "balance.released" | "balance.consumed";
  assetCode: AssetCode;
  amount: string;
  referenceType: string;
  referenceId: string;
  /** balance.consumed that was journaled into a settlement account. */
  settled: boolean;
  createdAt: string;
}

export type StatementCategory = "deposit" | "withdrawal" | "trade" | "adjustment";

export type StatementAction =
  | "deposit_credit"
  | "withdrawal_freeze"
  | "withdrawal_release"
  | "withdrawal_debit"
  | "order_freeze"
  | "order_release"
  | "trade_debit"
  | "trade_credit"
  | "adjustment_credit"
  | "adjustment_debit";

export interface StatementBalance {
  total: string;
  available: string;
  locked: string;
}

export interface StatementLine {
  /** entry:<entryId> or lock:<eventId>; stable across requests. */
  lineId: string;
  source: "entry" | "lock_event";
  occurredAt: string;
  assetCode: AssetCode;
  category: StatementCategory;
  action: StatementAction;
  /** Absolute amount of the movement. */
  amount: string;
  /** Signed effect on total (available + locked); "0" for freeze / release. */
  totalDelta: string;
  availableDelta: string;
  lockedDelta: string;
  /** Running balance after this line; omitted when history cannot explain the snapshot. */
  balanceAfter?: StatementBalance;
  businessType?: string;
  businessId?: string;
  referenceType: string;
  referenceId: string;
  journalId?: string;
  entryId?: string;
  direction?: "debit" | "credit";
  feeAmount?: string;
  feeAssetCode?: AssetCode;
  description?: string;
}

export type StatementCategoryFilter = StatementCategory | "fee";

export interface AccountStatementQuery {
  accountId: string;
  assetCode?: AssetCode;
  /** deposit | withdrawal | trade | adjustment | fee (trade lines that charged a fee). */
  category?: StatementCategoryFilter;
  /** Raw ledger business type filter (journal entries only). */
  businessType?: string;
  /** Default true; false hides freeze / release lines. */
  includeLockEvents?: boolean;
  /** Inclusive ISO timestamp. */
  from?: string;
  /** Exclusive ISO timestamp. */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AccountStatement {
  accountId: string;
  items: StatementLine[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Per asset: whether replaying the history reproduces the current balance
   * snapshot. When false, running balances are not shown for that asset.
   */
  balanceDerivable: Record<string, boolean>;
}
