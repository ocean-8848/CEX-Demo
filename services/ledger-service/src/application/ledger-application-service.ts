import type { AssetCode } from "@web3-cex/domain";

import { DuplicateJournalIdempotencyKeyError, LedgerError } from "../domain/errors.js";
import {
  addAmounts,
  compareAmounts,
  isPositiveAmount,
  subtractAmounts
} from "../domain/money.js";
import type { LedgerRepository } from "../domain/repository.js";
import { buildAccountStatement } from "./account-statement.js";
import { resolveJournalReplay } from "./journal-idempotency.js";
import type {
  AccountStatement,
  AccountStatementQuery,
  BalanceLock,
  LedgerBalanceListItem,
  BalanceSnapshot,
  ConsumeBalanceCommand,
  CreateAccountCommand,
  FreezeBalanceCommand,
  JournalLine,
  LedgerAccount,
  LedgerEntryRecord,
  LedgerEvent,
  LedgerJournal,
  LedgerJournalSummary,
  ListBalancesQuery,
  ListEntriesQuery,
  ListJournalsQuery,
  PagedResult,
  PostJournalCommand,
  ReleaseBalanceCommand
} from "../domain/types.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
}

export class LedgerApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: LedgerRepository,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      (() => {
        if (typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }

        return `id_${Date.now()}`;
      });
  }

  async createAccount(command: CreateAccountCommand): Promise<LedgerAccount> {
    return this.repository.withTransaction((repository) =>
      repository.createAccount({
        ...command,
        status: command.status ?? "active"
      })
    );
  }

  async getAccount(accountId: string): Promise<LedgerAccount | null> {
    return this.repository.findAccountById(accountId);
  }

  async postJournal(command: PostJournalCommand): Promise<LedgerJournal> {
    try {
      return await this.postJournalOnce(command);
    } catch (error) {
      if (!(error instanceof DuplicateJournalIdempotencyKeyError)) {
        throw error;
      }

      // A concurrent request with the same key committed first and our
      // transaction was rolled back; answer from the winner instead of a 500.
      const winner = await this.repository.findJournalByIdempotencyKey(command.idempotencyKey);
      if (!winner) {
        throw error;
      }

      return resolveJournalReplay(winner, command);
    }
  }

  private async postJournalOnce(command: PostJournalCommand): Promise<LedgerJournal> {
    return this.repository.withTransaction(async (repository) => {
      this.ensureBalanced(command.entries);

      const existing = await repository.findJournalByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        return resolveJournalReplay(existing, command);
      }

      for (const entry of command.entries) {
        await repository.ensureAccount(entry.accountId);
      }
      await repository.lockBalances(command.entries, { createMissing: true });

      // Re-check under the balance row locks: a concurrent request with the
      // same key touching the same balances has committed by now.
      const raced = await repository.findJournalByIdempotencyKey(command.idempotencyKey);
      if (raced) {
        return resolveJournalReplay(raced, command);
      }

      const createdAt = this.now().toISOString();
      const journal: LedgerJournal = {
        journalId: this.createId(),
        businessType: command.businessType,
        businessId: command.businessId,
        idempotencyKey: command.idempotencyKey,
        traceId: command.traceId,
        description: command.description,
        entries: command.entries,
        createdAt
      };

      for (const entry of command.entries) {
        await repository.ensureAccount(entry.accountId);
        const balance = await this.getOrCreateBalance(repository, entry.accountId, entry.assetCode);
        // Opening-balance (equity) accounts are the source of seeded funds and
        // legitimately carry a negative balance; every other account must not.
        const account = await repository.findAccountById(entry.accountId);
        const nextBalance = this.applyEntry(balance, entry, createdAt, {
          allowNegative: account?.accountType === "opening_balance"
        });
        await repository.saveBalance(nextBalance);
      }

      await repository.saveJournal(journal);
      await repository.saveEvent(this.createJournalPostedEvent(journal));

      return journal;
    });
  }

  async freezeBalance(command: FreezeBalanceCommand): Promise<BalanceLock> {
    return this.repository.withTransaction(async (repository) => {
      this.ensurePositiveAmount(command.amount);
      await repository.ensureAccount(command.accountId);
      await repository.lockBalances([command]);

      const existing = await repository.findBalanceLock(
        command.accountId,
        command.assetCode,
        command.referenceType,
        command.referenceId
      );

      if (existing) {
        if (existing.status === "locked") {
          throw new LedgerError(
            "DUPLICATE_BALANCE_LOCK",
            "Balance lock already exists for this reference"
          );
        }

        return existing;
      }

      const balance = await this.getExistingBalance(repository, command.accountId, command.assetCode);
      if (compareAmounts(balance.available, command.amount) < 0) {
        throw new LedgerError(
          "INSUFFICIENT_AVAILABLE_BALANCE",
          "Available balance is not enough to freeze requested amount"
        );
      }

      const updatedAt = this.now().toISOString();
      const nextBalance: BalanceSnapshot = {
        ...balance,
        available: subtractAmounts(balance.available, command.amount),
        locked: addAmounts(balance.locked, command.amount),
        version: balance.version + 1,
        updatedAt
      };

      const lock: BalanceLock = {
        lockId: this.createId(),
        accountId: command.accountId,
        assetCode: command.assetCode,
        referenceType: command.referenceType,
        referenceId: command.referenceId,
        amount: command.amount,
        remainingAmount: command.amount,
        status: "locked",
        createdAt: updatedAt
      };

      await repository.saveBalance(nextBalance);
      await repository.saveBalanceLock(lock);
      await repository.saveEvent(
        this.createBalanceEvent(
          "balance.locked",
          command.accountId,
          command.assetCode,
          command.amount,
          command.referenceType,
          command.referenceId
        )
      );

      return lock;
    });
  }

  async releaseBalance(command: ReleaseBalanceCommand): Promise<BalanceLock> {
    return this.repository.withTransaction(async (repository) => {
      await repository.ensureAccount(command.accountId);
      await repository.lockBalances([command]);

      const lock = await repository.findBalanceLock(
        command.accountId,
        command.assetCode,
        command.referenceType,
        command.referenceId
      );

      if (!lock || lock.status !== "locked") {
        throw new LedgerError("BALANCE_LOCK_NOT_FOUND", "Balance lock does not exist");
      }

      const releaseAmount = this.resolveLockAdjustmentAmount(lock, command.amount);
      const balance = await this.getExistingBalance(repository, command.accountId, command.assetCode);
      const updatedAt = this.now().toISOString();
      const remainingAmount = subtractAmounts(lock.remainingAmount, releaseAmount);
      const nextStatus = this.isZeroAmount(remainingAmount) ? "released" : "locked";
      const nextBalance: BalanceSnapshot = {
        ...balance,
        available: addAmounts(balance.available, releaseAmount),
        locked: subtractAmounts(balance.locked, releaseAmount),
        version: balance.version + 1,
        updatedAt
      };

      const releasedLock: BalanceLock = {
        ...lock,
        remainingAmount,
        status: nextStatus,
        releasedAt: nextStatus === "released" ? updatedAt : lock.releasedAt,
        consumedAt: lock.consumedAt
      };

      await repository.saveBalance(nextBalance);
      await repository.saveBalanceLock(releasedLock);
      await repository.saveEvent(
        this.createBalanceEvent(
          "balance.released",
          command.accountId,
          command.assetCode,
          releaseAmount,
          command.referenceType,
          command.referenceId
        )
      );

      return releasedLock;
    });
  }

  /**
   * Consumes (part of) a lock by journaling it into a settlement account.
   * There is deliberately no "just decrease locked" path: funds that leave a
   * user must always appear as a balanced journal, or reconciliation and
   * replay can no longer explain where they went.
   */
  async consumeBalance(command: ConsumeBalanceCommand): Promise<BalanceLock> {
    return this.settleConsumedBalance(command);
  }

  async getBalance(accountId: string, assetCode: AssetCode): Promise<BalanceSnapshot> {
    await this.repository.ensureAccount(accountId);
    return this.getOrCreateBalance(this.repository, accountId, assetCode);
  }

  async getJournal(journalId: string): Promise<LedgerJournal | null> {
    return this.repository.findJournalById(journalId);
  }

  async listJournals(query: ListJournalsQuery): Promise<LedgerJournalSummary[]> {
    return this.repository.listJournals({
      ...query,
      limit: this.normalizeLimit(query.limit),
      offset: this.normalizeOffset(query.offset)
    });
  }

  async listBalances(query: ListBalancesQuery): Promise<PagedResult<LedgerBalanceListItem>> {
    return this.repository.listBalances({
      ...query,
      limit: this.normalizeLimit(query.limit),
      offset: this.normalizeOffset(query.offset)
    });
  }

  async listEntries(query: ListEntriesQuery): Promise<LedgerEntryRecord[]> {
    await this.repository.ensureAccount(query.accountId);
    return this.repository.listEntries({
      ...query,
      limit: this.normalizeLimit(query.limit),
      offset: this.normalizeOffset(query.offset)
    });
  }

  /**
   * Customer statement (资金流水) of one account: journal entries merged with
   * freeze / release events, newest first, with running balances when the
   * replayed history matches the balance snapshot.
   */
  async getAccountStatement(query: AccountStatementQuery): Promise<AccountStatement> {
    const account = await this.repository.findAccountById(query.accountId);
    if (!account) {
      throw new LedgerError("ACCOUNT_NOT_FOUND", `Account ${query.accountId} does not exist`);
    }

    const [sources, balances] = await Promise.all([
      this.repository.listStatementSources(query.accountId, query.assetCode),
      this.repository.listBalances({
        accountId: query.accountId,
        assetCode: query.assetCode,
        limit: 200,
        offset: 0
      })
    ]);

    return buildAccountStatement({
      query,
      entries: sources.entries,
      lockEvents: sources.lockEvents,
      balances: balances.items,
      limit: this.normalizeLimit(query.limit),
      offset: this.normalizeOffset(query.offset)
    });
  }

  private ensureBalanced(entries: JournalLine[]): void {
    const totals = new Map<AssetCode, { debit: string; credit: string }>();

    for (const entry of entries) {
      this.ensurePositiveAmount(entry.amount);
      const current = totals.get(entry.assetCode) ?? { debit: "0", credit: "0" };
      if (entry.direction === "debit") {
        current.debit = addAmounts(current.debit, entry.amount);
      } else {
        current.credit = addAmounts(current.credit, entry.amount);
      }
      totals.set(entry.assetCode, current);
    }

    for (const [assetCode, total] of totals.entries()) {
      if (compareAmounts(total.debit, total.credit) !== 0) {
        throw new LedgerError(
          "JOURNAL_NOT_BALANCED",
          `Journal is not balanced for asset ${assetCode}`
        );
      }
    }
  }

  private ensurePositiveAmount(amount: string): void {
    if (!isPositiveAmount(amount)) {
      throw new LedgerError("INVALID_AMOUNT", "Amount must be greater than zero");
    }
  }

  private resolveLockAdjustmentAmount(lock: BalanceLock, requestedAmount?: string): string {
    const amount = requestedAmount ?? lock.remainingAmount;
    this.ensurePositiveAmount(amount);

    if (compareAmounts(lock.remainingAmount, amount) < 0) {
      throw new LedgerError(
        "INVALID_BALANCE_LOCK_STATE",
        "Requested amount exceeds the remaining balance lock amount"
      );
    }

    return amount;
  }

  private isZeroAmount(amount: string): boolean {
    return compareAmounts(amount, "0") === 0;
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return 50;
    }

    return Math.min(Math.max(Math.trunc(limit), 1), 200);
  }

  private normalizeOffset(offset: number | undefined): number {
    if (offset === undefined) {
      return 0;
    }

    return Math.max(Math.trunc(offset), 0);
  }

  private async getOrCreateBalance(
    repository: LedgerRepository,
    accountId: string,
    assetCode: AssetCode
  ): Promise<BalanceSnapshot> {
    const existing = await repository.findBalance(accountId, assetCode);
    if (existing) {
      return existing;
    }

    const emptyBalance: BalanceSnapshot = {
      accountId,
      assetCode,
      available: "0",
      locked: "0",
      version: 0,
      updatedAt: this.now().toISOString()
    };

    await repository.saveBalance(emptyBalance);
    return emptyBalance;
  }

  private async getExistingBalance(
    repository: LedgerRepository,
    accountId: string,
    assetCode: AssetCode
  ): Promise<BalanceSnapshot> {
    const balance = await repository.findBalance(accountId, assetCode);
    if (!balance) {
      throw new LedgerError("BALANCE_NOT_FOUND", "Balance does not exist");
    }

    return balance;
  }

  private applyEntry(
    balance: BalanceSnapshot,
    entry: JournalLine,
    updatedAt: string,
    options: { allowNegative?: boolean } = {}
  ): BalanceSnapshot {
    if (entry.direction === "credit") {
      return {
        ...balance,
        available: addAmounts(balance.available, entry.amount),
        version: balance.version + 1,
        updatedAt
      };
    }

    if (!options.allowNegative && compareAmounts(balance.available, entry.amount) < 0) {
      throw new LedgerError(
        "INSUFFICIENT_AVAILABLE_BALANCE",
        "Available balance is not enough for journal debit"
      );
    }

    return {
      ...balance,
      available: subtractAmounts(balance.available, entry.amount),
      version: balance.version + 1,
      updatedAt
    };
  }

  private async settleConsumedBalance(command: ConsumeBalanceCommand): Promise<BalanceLock> {
    const settlementAccountId = command.settlementAccountId;

    if (!settlementAccountId) {
      throw new LedgerError(
        "SETTLEMENT_ACCOUNT_REQUIRED",
        "Settlement account is required for balance settlement"
      );
    }

    return this.repository.withTransaction(async (repository) => {
      await repository.ensureAccount(command.accountId);
      await repository.ensureAccount(settlementAccountId);
      await repository.lockBalances(
        [
          { accountId: command.accountId, assetCode: command.assetCode },
          { accountId: settlementAccountId, assetCode: command.assetCode }
        ],
        { createMissing: true }
      );

      const lock = await repository.findBalanceLock(
        command.accountId,
        command.assetCode,
        command.referenceType,
        command.referenceId
      );

      if (!lock) {
        throw new LedgerError("BALANCE_LOCK_NOT_FOUND", "Balance lock does not exist");
      }

      if (lock.status === "settled") {
        return lock;
      }

      if (lock.status !== "locked") {
        throw new LedgerError(
          "INVALID_BALANCE_LOCK_STATE",
          `Balance lock is ${lock.status} and cannot be settled`
        );
      }

      const settlementBusinessId = command.businessId ?? command.referenceId;
      const settlementAmount = this.resolveLockAdjustmentAmount(lock, command.amount);
      const idempotencyKey = [
        command.referenceType,
        command.referenceId,
        command.assetCode,
        "settlement",
        settlementBusinessId
      ].join(":");
      const existingJournal = await repository.findJournalByIdempotencyKey(idempotencyKey);
      if (existingJournal) {
        return lock;
      }

      const balance = await this.getExistingBalance(repository, command.accountId, command.assetCode);
      if (compareAmounts(balance.locked, settlementAmount) < 0) {
        throw new LedgerError(
          "INVALID_BALANCE_LOCK_STATE",
          "Locked balance is lower than the balance lock amount"
        );
      }

      const settlementBalance = await this.getOrCreateBalance(
        repository,
        settlementAccountId,
        command.assetCode
      );
      const updatedAt = this.now().toISOString();
      const remainingAmount = subtractAmounts(lock.remainingAmount, settlementAmount);
      const nextStatus = this.isZeroAmount(remainingAmount) ? "settled" : "locked";
      const unlockedBalance: BalanceSnapshot = {
        ...balance,
        available: addAmounts(balance.available, settlementAmount),
        locked: subtractAmounts(balance.locked, settlementAmount),
        version: balance.version + 1,
        updatedAt
      };

      const journal: LedgerJournal = {
        journalId: this.createId(),
        // Named after what the lock was for, so a trade's lock consumption does
        // not read as a withdrawal in journal listings.
        businessType:
          command.referenceType === "spot_order" ? "spot_order_lock_settled" : "withdrawal_settled",
        businessId: settlementBusinessId,
        idempotencyKey,
        traceId: command.traceId ?? `${command.referenceType}:${command.referenceId}`,
        description:
          command.description ??
          `Settled ${command.referenceType} ${command.referenceId} from locked balance`,
        entries: [
          {
            accountId: command.accountId,
            assetCode: command.assetCode,
            direction: "debit",
            amount: settlementAmount,
            referenceType: command.referenceType,
            referenceId: command.referenceId
          },
          {
            accountId: settlementAccountId,
            assetCode: command.assetCode,
            direction: "credit",
            amount: settlementAmount,
            referenceType: command.referenceType,
            referenceId: command.referenceId
          }
        ],
        createdAt: updatedAt
      };
      const [sourceEntry, settlementEntry] = journal.entries;

      const nextSourceBalance = this.applyEntry(unlockedBalance, sourceEntry!, updatedAt);
      const nextSettlementBalance = this.applyEntry(
        settlementBalance,
        settlementEntry!,
        updatedAt
      );
      const settledLock: BalanceLock = {
        ...lock,
        remainingAmount,
        status: nextStatus,
        releasedAt: nextStatus === "settled" ? updatedAt : lock.releasedAt,
        consumedAt: nextStatus === "settled" ? updatedAt : lock.consumedAt
      };

      await repository.saveBalance(nextSourceBalance);
      await repository.saveBalance(nextSettlementBalance);
      await repository.saveJournal(journal);
      await repository.saveBalanceLock(settledLock);
      await repository.saveEvent(this.createJournalPostedEvent(journal));
      await repository.saveEvent(
        this.createBalanceEvent(
          "balance.consumed",
          command.accountId,
          command.assetCode,
          settlementAmount,
          command.referenceType,
          command.referenceId,
          // The outflow is recorded by the settlement journal posted in the same
          // transaction; replay treats this consumption as an unlock.
          { settled: true, settlementAccountId }
        )
      );

      return settledLock;
    });
  }

  private createJournalPostedEvent(journal: LedgerJournal): LedgerEvent {
    const assetCodes = [...new Set(journal.entries.map((entry) => entry.assetCode))];
    return {
      eventId: this.createId(),
      eventType: "ledger.journal_posted",
      aggregateType: "journal",
      aggregateId: journal.journalId,
      traceId: journal.traceId,
      occurredAt: this.now().toISOString(),
      payload: {
        journalId: journal.journalId,
        businessType: journal.businessType,
        businessId: journal.businessId,
        entryCount: journal.entries.length,
        assetCodes
      }
    };
  }

  private createBalanceEvent(
    eventType: "balance.locked" | "balance.released" | "balance.consumed",
    accountId: string,
    assetCode: AssetCode,
    amount: string,
    referenceType: string,
    referenceId: string,
    extra: Record<string, unknown> = {}
  ): LedgerEvent {
    return {
      eventId: this.createId(),
      eventType,
      aggregateType: "balance",
      aggregateId: `${accountId}:${assetCode}`,
      traceId: `${referenceType}:${referenceId}`,
      occurredAt: this.now().toISOString(),
      payload: {
        accountId,
        assetCode,
        referenceType,
        referenceId,
        amount,
        ...extra
      }
    };
  }
}
