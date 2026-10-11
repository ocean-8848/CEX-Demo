import type { AssetCode } from "@web3-cex/domain";

import type {
  CreateAccountCommand,
  BalanceLock,
  LedgerBalanceListItem,
  PagedResult,
  BalanceSnapshot,
  LedgerEntryRecord,
  LedgerAccount,
  LedgerEvent,
  LedgerJournal,
  LedgerJournalSummary,
  ListBalancesQuery,
  ListEntriesQuery,
  ListJournalsQuery,
  OutboxEventRecord,
  StatementEntrySource,
  StatementLockEventSource
} from "./types.js";

export interface LedgerRepository {
  withTransaction<T>(operation: (repository: LedgerRepository) => Promise<T>): Promise<T>;
  createAccount(command: CreateAccountCommand): Promise<LedgerAccount>;
  findAccountById(accountId: string): Promise<LedgerAccount | null>;
  ensureAccount(accountId: string): Promise<void>;
  findBalance(accountId: string, assetCode: AssetCode): Promise<BalanceSnapshot | null>;
  /**
   * Row-locks the given balances for the rest of the current transaction, in a
   * deterministic (accountId, assetCode) order so concurrent writers serialize
   * instead of overwriting each other (lost updates) or deadlocking.
   * `createMissing` inserts zero rows first so brand-new balances are locked too.
   * Must be called before any balance-lock row is read in the same transaction.
   */
  lockBalances(
    keys: Array<{ accountId: string; assetCode: AssetCode }>,
    options?: { createMissing?: boolean }
  ): Promise<void>;
  saveBalance(balance: BalanceSnapshot): Promise<void>;
  saveJournal(journal: LedgerJournal): Promise<void>;
  findJournalById(journalId: string): Promise<LedgerJournal | null>;
  findJournalByIdempotencyKey(idempotencyKey: string): Promise<LedgerJournal | null>;
  listJournals(query: ListJournalsQuery): Promise<LedgerJournalSummary[]>;
  listBalances(query: ListBalancesQuery): Promise<PagedResult<LedgerBalanceListItem>>;
  listEntries(query: ListEntriesQuery): Promise<LedgerEntryRecord[]>;
  /**
   * Full chronological history of one account for the customer statement:
   * its journal entries (with the fee booked in the same trade journal) and
   * its balance lock outbox events.
   */
  listStatementSources(
    accountId: string,
    assetCode?: AssetCode
  ): Promise<{ entries: StatementEntrySource[]; lockEvents: StatementLockEventSource[] }>;
  saveBalanceLock(lock: BalanceLock): Promise<void>;
  findBalanceLock(
    accountId: string,
    assetCode: AssetCode,
    referenceType: string,
    referenceId: string
  ): Promise<BalanceLock | null>;
  saveEvent(event: LedgerEvent): Promise<void>;
  listPendingOutboxEvents(limit: number, now: string): Promise<OutboxEventRecord[]>;
  listDeadLetteredOutboxEvents(limit: number): Promise<OutboxEventRecord[]>;
  requeueOutboxEvents(eventIds: string[], requeuedAt: string): Promise<void>;
  markOutboxEventsPublished(eventIds: string[], publishedAt: string): Promise<void>;
  recordOutboxEventFailure(params: {
    eventId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    deadLetteredAt?: string;
  }): Promise<void>;
}
