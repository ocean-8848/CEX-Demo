export class LedgerError extends Error {
  constructor(
    public readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "BALANCE_NOT_FOUND"
      | "INSUFFICIENT_AVAILABLE_BALANCE"
      | "DUPLICATE_IDEMPOTENCY_KEY"
      | "JOURNAL_NOT_BALANCED"
      | "BALANCE_LOCK_NOT_FOUND"
      | "INVALID_BALANCE_LOCK_STATE"
      | "DUPLICATE_BALANCE_LOCK"
      | "SETTLEMENT_ACCOUNT_REQUIRED"
      | "INVALID_AMOUNT",
    message: string
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/**
 * Raised by a repository when a journal insert hits the unique idempotency key
 * (a concurrent request committed the same key first). The surrounding
 * transaction is aborted; postJournal re-reads the winner and decides between
 * an idempotent replay and a 409.
 */
export class DuplicateJournalIdempotencyKeyError extends LedgerError {
  constructor(readonly idempotencyKey: string) {
    super(
      "DUPLICATE_IDEMPOTENCY_KEY",
      `A journal with idempotency key ${idempotencyKey} already exists`
    );
    this.name = "DuplicateJournalIdempotencyKeyError";
  }
}
