import { LedgerError } from "../domain/errors.js";
import { fromAtomicUnits, toAtomicUnits } from "../domain/money.js";
import type { JournalLine, LedgerJournal, PostJournalCommand } from "../domain/types.js";

/**
 * Canonical form of what a journal *does*: business identity plus the set of
 * entries (order-insensitive, amounts normalised). traceId and description are
 * diagnostics and may legitimately differ between retries of the same request.
 */
export function journalFingerprint(input: {
  businessType: string;
  businessId: string;
  entries: JournalLine[];
}): string {
  const entries = input.entries
    .map((entry) =>
      [
        entry.accountId,
        entry.assetCode,
        entry.direction,
        fromAtomicUnits(toAtomicUnits(entry.amount)),
        entry.referenceType,
        entry.referenceId
      ].join("|")
    )
    .sort();
  return JSON.stringify([input.businessType, input.businessId, entries]);
}

/**
 * Same idempotency key + same payload → the original journal (idempotent
 * replay). Same key + different payload → 409 DUPLICATE_IDEMPOTENCY_KEY.
 */
export function resolveJournalReplay(
  existing: LedgerJournal,
  command: PostJournalCommand
): LedgerJournal {
  if (journalFingerprint(existing) === journalFingerprint(command)) {
    return existing;
  }

  throw new LedgerError(
    "DUPLICATE_IDEMPOTENCY_KEY",
    `Idempotency key ${command.idempotencyKey} was already used by journal ${existing.journalId} with a different payload`
  );
}
