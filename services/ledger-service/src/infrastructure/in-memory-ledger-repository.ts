import type { AssetCode } from "@web3-cex/domain";

import { DuplicateJournalIdempotencyKeyError, LedgerError } from "../domain/errors.js";
import { addAmounts } from "../domain/money.js";
import type { LedgerRepository } from "../domain/repository.js";
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
} from "../domain/types.js";

function balanceKey(accountId: string, assetCode: AssetCode): string {
  return `${accountId}:${assetCode}`;
}

function lockKey(
  accountId: string,
  assetCode: AssetCode,
  referenceType: string,
  referenceId: string
): string {
  return `${accountId}:${assetCode}:${referenceType}:${referenceId}`;
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly balances = new Map<string, BalanceSnapshot>();
  private readonly journalsById = new Map<string, LedgerJournal>();
  private readonly journalsByIdempotencyKey = new Map<string, LedgerJournal>();
  private readonly balanceLocks = new Map<string, BalanceLock>();
  private readonly events: LedgerEvent[] = [];
  private readonly outboxEvents = new Map<string, OutboxEventRecord>();

  async withTransaction<T>(operation: (repository: LedgerRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async createAccount(command: CreateAccountCommand): Promise<LedgerAccount> {
    const existing = this.accounts.get(command.accountId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const account: LedgerAccount = {
      accountId: command.accountId,
      userId: command.userId,
      accountType: command.accountType,
      status: command.status ?? "active",
      createdAt: now,
      updatedAt: now
    };

    this.accounts.set(command.accountId, account);
    return account;
  }

  async findAccountById(accountId: string): Promise<LedgerAccount | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async ensureAccount(accountId: string): Promise<void> {
    if (!this.accounts.has(accountId)) {
      throw new LedgerError("ACCOUNT_NOT_FOUND", `Account ${accountId} does not exist`);
    }
  }

  async lockBalances(): Promise<void> {
    // Single-threaded in-memory store: nothing to lock.
  }

  async findBalance(accountId: string, assetCode: AssetCode): Promise<BalanceSnapshot | null> {
    return this.balances.get(balanceKey(accountId, assetCode)) ?? null;
  }

  async saveBalance(balance: BalanceSnapshot): Promise<void> {
    this.balances.set(balanceKey(balance.accountId, balance.assetCode), balance);
  }

  async saveJournal(journal: LedgerJournal): Promise<void> {
    const existing = this.journalsByIdempotencyKey.get(journal.idempotencyKey);
    if (existing && existing.journalId !== journal.journalId) {
      // Mirrors the unique (idempotency_key) constraint of ledger_journals.
      throw new DuplicateJournalIdempotencyKeyError(journal.idempotencyKey);
    }
    this.journalsById.set(journal.journalId, journal);
    this.journalsByIdempotencyKey.set(journal.idempotencyKey, journal);
  }

  async findJournalById(journalId: string): Promise<LedgerJournal | null> {
    return this.journalsById.get(journalId) ?? null;
  }

  async findJournalByIdempotencyKey(idempotencyKey: string): Promise<LedgerJournal | null> {
    return this.journalsByIdempotencyKey.get(idempotencyKey) ?? null;
  }

  async listJournals(query: ListJournalsQuery): Promise<LedgerJournalSummary[]> {
    const journals = [...this.journalsById.values()]
      .filter((journal) => {
        if (query.businessType && journal.businessType !== query.businessType) {
          return false;
        }

        if (query.businessId && journal.businessId !== query.businessId) {
          return false;
        }

        if (query.idempotencyKey && journal.idempotencyKey !== query.idempotencyKey) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50));

    return journals.map((journal) => ({
      journalId: journal.journalId,
      businessType: journal.businessType,
      businessId: journal.businessId,
      idempotencyKey: journal.idempotencyKey,
      traceId: journal.traceId,
      description: journal.description,
      entryCount: journal.entries.length,
      assetCodes: [...new Set(journal.entries.map((entry) => entry.assetCode))],
      createdAt: journal.createdAt
    }));
  }

  async listBalances(query: ListBalancesQuery): Promise<PagedResult<LedgerBalanceListItem>> {
    const items: LedgerBalanceListItem[] = [...this.balances.values()]
      .flatMap((balance) => {
        const account = this.accounts.get(balance.accountId);
        if (!account) {
          return [];
        }

        return [{
          ...balance,
          userId: account.userId,
          accountType: account.accountType,
          accountStatus: account.status,
          total: addAmounts(balance.available, balance.locked)
        }];
      })
      .filter((item) => {
        if (query.userId && item.userId !== query.userId) {
          return false;
        }

        if (query.accountId && item.accountId !== query.accountId) {
          return false;
        }

        if (query.assetCode && item.assetCode !== query.assetCode) {
          return false;
        }

        if (query.accountType && item.accountType !== query.accountType) {
          return false;
        }

        if (query.accountStatus && item.accountStatus !== query.accountStatus) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;

    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset
    };
  }

  async listEntries(query: ListEntriesQuery): Promise<LedgerEntryRecord[]> {
    const entries = [...this.journalsById.values()]
      .flatMap((journal) =>
        journal.entries.map<LedgerEntryRecord>((entry, index) => ({
          entryId: `${journal.journalId}:${index}`,
          journalId: journal.journalId,
          businessType: journal.businessType,
          businessId: journal.businessId,
          traceId: journal.traceId,
          description: journal.description,
          createdAt: journal.createdAt,
          ...entry
        }))
      )
      .filter((entry) => {
        if (entry.accountId !== query.accountId) {
          return false;
        }

        if (query.assetCode && entry.assetCode !== query.assetCode) {
          return false;
        }

        if (query.journalId && entry.journalId !== query.journalId) {
          return false;
        }

        if (query.businessType && entry.businessType !== query.businessType) {
          return false;
        }

        if (query.businessId && entry.businessId !== query.businessId) {
          return false;
        }

        if (query.referenceType && entry.referenceType !== query.referenceType) {
          return false;
        }

        if (query.referenceId && entry.referenceId !== query.referenceId) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return entries.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50));
  }

  async listStatementSources(
    accountId: string,
    assetCode?: AssetCode
  ): Promise<{ entries: StatementEntrySource[]; lockEvents: StatementLockEventSource[] }> {
    const entries: StatementEntrySource[] = [];
    for (const journal of this.journalsById.values()) {
      const feeLines = journal.entries.filter((line) => line.referenceType === "spot_trade_fee");
      journal.entries.forEach((entry, index) => {
        if (entry.accountId !== accountId || (assetCode && entry.assetCode !== assetCode)) {
          return;
        }
        const chargesFee =
          entry.direction === "credit" && entry.referenceType === "spot_trade" && feeLines.length > 0;
        entries.push({
          entryId: `${journal.journalId}:${index}`,
          journalId: journal.journalId,
          businessType: journal.businessType,
          businessId: journal.businessId,
          traceId: journal.traceId,
          description: journal.description,
          createdAt: journal.createdAt,
          ...entry,
          feeAmount: chargesFee
            ? feeLines.reduce((sum, line) => addAmounts(sum, line.amount), "0")
            : undefined,
          feeAssetCode: chargesFee ? feeLines[0]?.assetCode : undefined
        });
      });
    }

    const lockEvents: StatementLockEventSource[] = [];
    for (const event of this.outboxEvents.values()) {
      if (
        event.aggregateType !== "balance" ||
        !event.aggregateId.startsWith(`${accountId}:`) ||
        !["balance.locked", "balance.released", "balance.consumed"].includes(event.eventType)
      ) {
        continue;
      }
      const envelope = event.payload as { payload?: Record<string, unknown> };
      const payload = (envelope.payload ?? event.payload) as Record<string, unknown>;
      const eventAsset = String(payload.assetCode ?? event.aggregateId.slice(accountId.length + 1));
      if (assetCode && eventAsset !== assetCode) {
        continue;
      }
      lockEvents.push({
        eventId: event.eventId,
        eventType: event.eventType as StatementLockEventSource["eventType"],
        assetCode: eventAsset as AssetCode,
        amount: String(payload.amount ?? "0"),
        referenceType: String(payload.referenceType ?? ""),
        referenceId: String(payload.referenceId ?? ""),
        settled: payload.settled === true,
        createdAt: event.createdAt
      });
    }

    return {
      entries: entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      lockEvents: lockEvents.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
  }

  async saveBalanceLock(lock: BalanceLock): Promise<void> {
    this.balanceLocks.set(
      lockKey(lock.accountId, lock.assetCode, lock.referenceType, lock.referenceId),
      lock
    );
  }

  async findBalanceLock(
    accountId: string,
    assetCode: AssetCode,
    referenceType: string,
    referenceId: string
  ): Promise<BalanceLock | null> {
    return this.balanceLocks.get(lockKey(accountId, assetCode, referenceType, referenceId)) ?? null;
  }

  async saveEvent(event: LedgerEvent): Promise<void> {
    this.events.push(event);
    this.outboxEvents.set(event.eventId, {
      eventId: event.eventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: {
        trace_id: event.traceId,
        occurred_at: event.occurredAt,
        payload: event.payload
      },
      createdAt: event.occurredAt,
      publishAttempts: 0
    });
  }

  async listPendingOutboxEvents(limit: number, now: string): Promise<OutboxEventRecord[]> {
    return [...this.outboxEvents.values()]
      .filter(
        (event) =>
          !event.publishedAt &&
          !event.deadLetteredAt &&
          (!event.nextAttemptAt || event.nextAttemptAt <= now)
      )
      .sort((left, right) =>
        (left.nextAttemptAt ?? left.createdAt).localeCompare(right.nextAttemptAt ?? right.createdAt)
      )
      .slice(0, limit);
  }

  async listDeadLetteredOutboxEvents(limit: number): Promise<OutboxEventRecord[]> {
    return [...this.outboxEvents.values()]
      .filter((event) => !!event.deadLetteredAt && !event.publishedAt)
      .sort((left, right) =>
        (left.deadLetteredAt ?? left.createdAt).localeCompare(right.deadLetteredAt ?? right.createdAt)
      )
      .slice(0, limit);
  }

  async requeueOutboxEvents(eventIds: string[], _requeuedAt: string): Promise<void> {
    for (const eventId of eventIds) {
      const existing = this.outboxEvents.get(eventId);
      if (!existing) {
        continue;
      }

      this.outboxEvents.set(eventId, {
        ...existing,
        publishAttempts: 0,
        lastError: undefined,
        lastAttemptedAt: undefined,
        nextAttemptAt: undefined,
        deadLetteredAt: undefined
      });
    }
  }

  async markOutboxEventsPublished(eventIds: string[], publishedAt: string): Promise<void> {
    for (const eventId of eventIds) {
      const existing = this.outboxEvents.get(eventId);
      if (existing) {
        this.outboxEvents.set(eventId, {
          ...existing,
          publishedAt,
          lastError: undefined,
          nextAttemptAt: undefined
        });
      }
    }
  }

  async recordOutboxEventFailure(params: {
    eventId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    deadLetteredAt?: string;
  }): Promise<void> {
    const existing = this.outboxEvents.get(params.eventId);
    if (!existing) {
      return;
    }

    this.outboxEvents.set(params.eventId, {
      ...existing,
      publishAttempts: existing.publishAttempts + 1,
      lastError: params.errorMessage,
      lastAttemptedAt: params.attemptedAt,
      nextAttemptAt: params.nextAttemptAt,
      deadLetteredAt: params.deadLetteredAt
    });
  }

  listEvents(): LedgerEvent[] {
    return [...this.events];
  }

  getOutboxEvent(eventId: string): OutboxEventRecord | null {
    return this.outboxEvents.get(eventId) ?? null;
  }
}
