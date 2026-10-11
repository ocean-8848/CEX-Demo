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
