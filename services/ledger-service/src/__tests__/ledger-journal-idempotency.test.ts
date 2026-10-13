import assert from "node:assert/strict";
import test from "node:test";

import { LedgerApplicationService } from "../application/ledger-application-service.js";
import { journalFingerprint } from "../application/journal-idempotency.js";
import { DuplicateJournalIdempotencyKeyError, LedgerError } from "../domain/errors.js";
import type { LedgerJournal, PostJournalCommand } from "../domain/types.js";
import { InMemoryLedgerRepository } from "../infrastructure/in-memory-ledger-repository.js";

function createService(repository = new InMemoryLedgerRepository()) {
  const service = new LedgerApplicationService(repository, {
    now: () => new Date("2026-03-07T00:00:00.000Z"),
    createId: (() => {
      let counter = 0;
      return () => `id_${++counter}`;
    })()
  });
  return { repository, service };
}

async function seedAccounts(service: LedgerApplicationService) {
  await service.createAccount({ accountId: "opening", accountType: "opening_balance" });
  await service.createAccount({ accountId: "user-a", accountType: "spot" });
  await service.createAccount({ accountId: "user-b", accountType: "spot" });
}

function airdrop(overrides: Partial<PostJournalCommand> = {}, amount = "100"): PostJournalCommand {
  return {
    businessType: "airdrop",
    businessId: "airdrop-1",
    idempotencyKey: "airdrop-1",
    traceId: "trace-1",
    entries: [
      { accountId: "opening", assetCode: "USDT", direction: "debit", amount, referenceType: "airdrop", referenceId: "a1" },
      { accountId: "user-a", assetCode: "USDT", direction: "credit", amount, referenceType: "airdrop", referenceId: "a1" }
    ],
    ...overrides
  };
}

function isDuplicateKeyConflict(error: unknown): boolean {
  return (
    error instanceof LedgerError &&
    !(error instanceof DuplicateJournalIdempotencyKeyError) &&
    error.code === "DUPLICATE_IDEMPOTENCY_KEY"
  );
}

test("same key + same payload replays the original journal (trace, order and amount format may differ)", async () => {
  const { service } = createService();
  await seedAccounts(service);

  const first = await service.postJournal(airdrop());
  const replay = await service.postJournal(
    airdrop(
      {
        traceId: "trace-retry",
        description: "retried",
        entries: [...airdrop({}, "100.000").entries].reverse()
      }
    )
  );

  assert.equal(replay.journalId, first.journalId);
  assert.equal((await service.getBalance("user-a", "USDT")).available, "100");
});

test("same key + different payload is rejected with 409 DUPLICATE_IDEMPOTENCY_KEY and changes nothing", async () => {
  const { service } = createService();
  await seedAccounts(service);
  await service.postJournal(airdrop());

  await assert.rejects(service.postJournal(airdrop({}, "250")), isDuplicateKeyConflict);
  await assert.rejects(
    service.postJournal(airdrop({ businessId: "airdrop-2" })),
    isDuplicateKeyConflict
  );
  assert.equal((await service.getBalance("user-a", "USDT")).available, "100");
});

/**
 * Simulates the Postgres race: our transaction does not see the concurrent
 * winner (it has not committed yet), so the insert hits the unique key.
 */
class RacingRepository extends InMemoryLedgerRepository {
  hideJournals = true;
  winner?: LedgerJournal;

  override async findJournalByIdempotencyKey(key: string): Promise<LedgerJournal | null> {
    if (this.hideJournals) {
      return null;
    }
    return super.findJournalByIdempotencyKey(key);
  }

  override async saveJournal(journal: LedgerJournal): Promise<void> {
    if (this.hideJournals && this.winner) {
      this.hideJournals = false;
      throw new DuplicateJournalIdempotencyKeyError(journal.idempotencyKey);
    }
    await super.saveJournal(journal);
  }
}

test("a unique-key race with an identical payload returns the winner's journal", async () => {
  const repository = new RacingRepository();
  const { service } = createService(repository);
  await seedAccounts(service);
  repository.hideJournals = false;
  const winner = await service.postJournal(airdrop());
  repository.hideJournals = true;
  repository.winner = winner;

  const result = await service.postJournal(airdrop({ traceId: "loser" }));
  assert.equal(result.journalId, winner.journalId);
});

test("a unique-key race with a different payload answers 409, never a raw error", async () => {
  const repository = new RacingRepository();
  const { service } = createService(repository);
  await seedAccounts(service);
  repository.hideJournals = false;
  const winner = await service.postJournal(airdrop());
  repository.hideJournals = true;
  repository.winner = winner;

  await assert.rejects(
    service.postJournal(
      airdrop({
        entries: [
          { accountId: "opening", assetCode: "USDT", direction: "debit", amount: "100", referenceType: "airdrop", referenceId: "a1" },
          { accountId: "user-b", assetCode: "USDT", direction: "credit", amount: "100", referenceType: "airdrop", referenceId: "a1" }
        ]
      })
    ),
    isDuplicateKeyConflict
  );
});

test("journal fingerprint ignores trace/description and entry order", () => {
  const base = airdrop();
  assert.equal(
    journalFingerprint(base),
    journalFingerprint({ ...base, entries: [...airdrop({}, "100.0").entries].reverse() })
  );
  assert.notEqual(journalFingerprint(base), journalFingerprint(airdrop({}, "100.1")));
});
