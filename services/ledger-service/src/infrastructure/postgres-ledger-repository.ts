import type { AssetCode } from "@web3-cex/domain";
import type { Pool, PoolClient } from "pg";

import { DuplicateJournalIdempotencyKeyError, LedgerError } from "../domain/errors.js";
import { addAmounts } from "../domain/money.js";
import type { LedgerRepository } from "../domain/repository.js";
import type {
  CreateAccountCommand,
  BalanceLock,
  LedgerBalanceListItem,
  ListBalancesQuery,
  PagedResult,
  BalanceSnapshot,
  LedgerEntryRecord,
  LedgerAccount,
  LedgerEvent,
  LedgerJournal,
  LedgerJournalSummary,
  JournalLine,
  OutboxEventRecord,
  StatementEntrySource,
  StatementLockEventSource
} from "../domain/types.js";
import { withPgTransaction } from "./postgres.js";

interface AccountRow {
  account_id: string;
  user_id: string | null;
  account_type: string;
  status: "active" | "suspended" | "closed";
  created_at: Date;
  updated_at: Date;
}

interface BalanceRow {
  account_id: string;
  asset_code: AssetCode;
  available: string;
  locked: string;
  version: number;
  updated_at: Date;
}

interface BalanceListRow extends BalanceRow {
  user_id: string | null;
  account_type: string;
  account_status: "active" | "suspended" | "closed";
}

interface CountRow {
  total: string;
}

interface JournalRow {
  journal_id: string;
  business_type: string;
  business_id: string;
  idempotency_key: string;
  trace_id: string;
  description: string | null;
  created_at: Date;
}

interface JournalEntryRow {
  entry_id?: string;
  journal_id?: string;
  account_id: string;
  asset_code: AssetCode;
  direction: "debit" | "credit";
  amount: string;
  business_type?: string;
  business_id?: string;
  trace_id?: string;
  description?: string | null;
  reference_type: string;
  reference_id: string;
  created_at?: Date;
}

interface JournalSummaryRow {
  journal_id: string;
  business_type: string;
  business_id: string;
  idempotency_key: string;
  trace_id: string;
  description: string | null;
  entry_count: number;
  asset_codes: AssetCode[];
  created_at: Date;
}

interface LockRow {
  lock_id: string;
  account_id: string;
  asset_code: AssetCode;
  reference_type: string;
  reference_id: string;
  amount: string;
  remaining_amount: string;
  status: "locked" | "released" | "consumed" | "settled";
  created_at: Date;
  released_at: Date | null;
  consumed_at: Date | null;
}

interface OutboxEventRow {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
  publish_attempts: number;
  last_error: string | null;
  last_attempted_at: Date | null;
  next_attempt_at: Date | null;
  dead_lettered_at: Date | null;
}

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(operation: (repository: LedgerRepository) => Promise<T>): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }

    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresLedgerRepository(client))
    );
  }

  async createAccount(command: CreateAccountCommand): Promise<LedgerAccount> {
    const inserted = await this.db.query<AccountRow>(
      `insert into accounts (account_id, user_id, account_type, status)
       values ($1, $2, $3, $4)
       on conflict (account_id) do update
       set user_id = coalesce(accounts.user_id, excluded.user_id),
           account_type = accounts.account_type,
           status = accounts.status,
           updated_at = accounts.updated_at
       returning account_id, user_id, account_type, status, created_at, updated_at`,
      [command.accountId, command.userId ?? null, command.accountType, command.status ?? "active"]
    );

    return mapAccount(inserted.rows[0]);
  }

  async findAccountById(accountId: string): Promise<LedgerAccount | null> {
    const result = await this.db.query<AccountRow>(
      `select account_id, user_id, account_type, status, created_at, updated_at
       from accounts
       where account_id = $1`,
      [accountId]
    );

    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async ensureAccount(accountId: string): Promise<void> {
    const result = await this.db.query<{ exists: boolean }>(
      "select exists(select 1 from accounts where account_id = $1) as exists",
      [accountId]
    );

    if (!result.rows[0]?.exists) {
      throw new LedgerError("ACCOUNT_NOT_FOUND", `Account ${accountId} does not exist`);
    }
  }

  async lockBalances(
    keys: Array<{ accountId: string; assetCode: AssetCode }>,
    options: { createMissing?: boolean } = {}
  ): Promise<void> {
    // Only meaningful on a transaction-bound repository (no transactionOwner).
    if (this.transactionOwner) {
      return;
    }
    const unique = [...new Map(keys.map((key) => [`${key.accountId}|${key.assetCode}`, key])).values()].sort(
      (left, right) =>
        left.accountId === right.accountId
          ? left.assetCode.localeCompare(right.assetCode)
          : left.accountId.localeCompare(right.accountId)
    );
    for (const key of unique) {
      if (options.createMissing) {
        await this.db.query(
          `insert into balances (account_id, asset_code, available, locked, version)
           values ($1, $2, 0, 0, 0)
           on conflict (account_id, asset_code) do nothing`,
          [key.accountId, key.assetCode]
        );
      }
      await this.db.query(
        `select 1 from balances where account_id = $1 and asset_code = $2 for update`,
        [key.accountId, key.assetCode]
      );
    }
  }

  async findBalance(accountId: string, assetCode: AssetCode): Promise<BalanceSnapshot | null> {
    const result = await this.db.query<BalanceRow>(
      `select account_id, asset_code, available::text as available, locked::text as locked, version, updated_at
       from balances
       where account_id = $1 and asset_code = $2`,
      [accountId, assetCode]
    );

    return result.rows[0] ? mapBalance(result.rows[0]) : null;
  }

  async saveBalance(balance: BalanceSnapshot): Promise<void> {
    await this.db.query(
      `insert into balances (account_id, asset_code, available, locked, version, updated_at)
       values ($1, $2, $3::numeric, $4::numeric, $5, $6)
       on conflict (account_id, asset_code) do update
       set available = excluded.available,
           locked = excluded.locked,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      [
        balance.accountId,
        balance.assetCode,
        balance.available,
        balance.locked,
        balance.version,
        balance.updatedAt
      ]
    );
  }

  async saveJournal(journal: LedgerJournal): Promise<void> {
    try {
      await this.db.query(
        `insert into ledger_journals
         (journal_id, business_type, business_id, idempotency_key, trace_id, description, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          journal.journalId,
          journal.businessType,
          journal.businessId,
          journal.idempotencyKey,
          journal.traceId,
          journal.description ?? null,
          journal.createdAt
        ]
      );
    } catch (error) {
      if (isIdempotencyKeyUniqueViolation(error)) {
        throw new DuplicateJournalIdempotencyKeyError(journal.idempotencyKey);
      }
      throw error;
    }

    for (const entry of journal.entries) {
      await this.insertJournalEntry(journal.journalId, entry);
    }
  }

  async findJournalById(journalId: string): Promise<LedgerJournal | null> {
    const journalResult = await this.db.query<JournalRow>(
      `select journal_id, business_type, business_id, idempotency_key, trace_id, description, created_at
       from ledger_journals
       where journal_id = $1`,
      [journalId]
    );

    return this.mapJournal(journalResult.rows[0]);
  }

  async findJournalByIdempotencyKey(idempotencyKey: string): Promise<LedgerJournal | null> {
    const journalResult = await this.db.query<JournalRow>(
      `select journal_id, business_type, business_id, idempotency_key, trace_id, description, created_at
       from ledger_journals
       where idempotency_key = $1`,
      [idempotencyKey]
    );

    return this.mapJournal(journalResult.rows[0]);
  }

  async listJournals(query: {
    businessType?: string;
    businessId?: string;
    idempotencyKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<LedgerJournalSummary[]> {
    const result = await this.db.query<JournalSummaryRow>(
      `select lj.journal_id, lj.business_type, lj.business_id, lj.idempotency_key, lj.trace_id,
              lj.description, count(le.entry_id)::int as entry_count,
              array_agg(distinct le.asset_code) as asset_codes, lj.created_at
       from ledger_journals lj
       join ledger_entries le on le.journal_id = lj.journal_id
       where ($1::text is null or lj.business_type = $1)
         and ($2::text is null or lj.business_id = $2)
         and ($3::text is null or lj.idempotency_key = $3)
       group by lj.journal_id, lj.business_type, lj.business_id, lj.idempotency_key, lj.trace_id, lj.description, lj.created_at
       order by lj.created_at desc
       limit $4 offset $5`,
      [
        query.businessType ?? null,
        query.businessId ?? null,
        query.idempotencyKey ?? null,
        query.limit ?? 50,
        query.offset ?? 0
      ]
    );

    return result.rows.map((row) => ({
      journalId: row.journal_id,
      businessType: row.business_type,
      businessId: row.business_id,
      idempotencyKey: row.idempotency_key,
      traceId: row.trace_id,
      description: row.description ?? undefined,
      entryCount: Number(row.entry_count),
      assetCodes: row.asset_codes,
      createdAt: row.created_at.toISOString()
    }));
  }

  async listBalances(query: ListBalancesQuery): Promise<PagedResult<LedgerBalanceListItem>> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.userId) {
      values.push(query.userId);
      conditions.push(`a.user_id = $${values.length}`);
    }

    if (query.accountId) {
      values.push(query.accountId);
      conditions.push(`a.account_id = $${values.length}`);
    }

    if (query.assetCode) {
      values.push(query.assetCode);
      conditions.push(`b.asset_code = $${values.length}`);
    }

    if (query.accountType) {
      values.push(query.accountType);
      conditions.push(`a.account_type = $${values.length}`);
    }

    if (query.accountStatus) {
      values.push(query.accountStatus);
      conditions.push(`a.status = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const result = await this.db.query<BalanceListRow>(
      `select b.account_id, b.asset_code, b.available::text as available,
              b.locked::text as locked, b.version, b.updated_at,
              a.user_id, a.account_type, a.status as account_status
       from balances b
       join accounts a on a.account_id = b.account_id
       ${whereClause}
       order by b.updated_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<CountRow>(
      `select count(*)::text as total
       from balances b
       join accounts a on a.account_id = b.account_id
       ${whereClause}`,
      values
    );

    return {
      items: result.rows.map((row) => ({
        ...mapBalance(row),
        userId: row.user_id ?? undefined,
        accountType: row.account_type as LedgerAccount["accountType"],
        accountStatus: row.account_status,
        total: addAmounts(row.available, row.locked)
      })),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async listEntries(query: {
    accountId: string;
    assetCode?: AssetCode;
    journalId?: string;
    businessType?: string;
    businessId?: string;
    referenceType?: string;
    referenceId?: string;
    limit?: number;
    offset?: number;
  }): Promise<LedgerEntryRecord[]> {
    const result = await this.db.query<JournalEntryRow>(
      `select le.entry_id, le.journal_id, le.account_id, le.asset_code, le.direction,
              le.amount::text as amount, lj.business_type, lj.business_id, lj.trace_id,
              lj.description, le.reference_type, le.reference_id, le.created_at
       from ledger_entries le
       join ledger_journals lj on lj.journal_id = le.journal_id
       where le.account_id = $1
         and ($2::text is null or le.asset_code = $2)
         and ($3::uuid is null or le.journal_id = $3)
         and ($4::text is null or lj.business_type = $4)
         and ($5::text is null or lj.business_id = $5)
         and ($6::text is null or le.reference_type = $6)
         and ($7::text is null or le.reference_id = $7)
       order by le.created_at desc
       limit $8 offset $9`,
      [
        query.accountId,
        query.assetCode ?? null,
        query.journalId ?? null,
        query.businessType ?? null,
        query.businessId ?? null,
        query.referenceType ?? null,
        query.referenceId ?? null,
        query.limit ?? 50,
        query.offset ?? 0
      ]
    );

    return result.rows.map(mapLedgerEntryRecord);
  }

  async listStatementSources(
    accountId: string,
    assetCode?: AssetCode
  ): Promise<{ entries: StatementEntrySource[]; lockEvents: StatementLockEventSource[] }> {
    // Fee lines are booked to platform fee accounts in the same trade journal;
    // they belong to whoever is credited (net) by that journal.
    const entryRows = await this.db.query<
      JournalEntryRow & { fee_amount: string | null; fee_asset_code: AssetCode | null }
    >(
      `select le.entry_id, le.journal_id, le.account_id, le.asset_code, le.direction,
              le.amount::text as amount, lj.business_type, lj.business_id, lj.trace_id,
              lj.description, le.reference_type, le.reference_id, le.created_at,
              fee.amount::text as fee_amount, fee.asset_code as fee_asset_code
       from ledger_entries le
       join ledger_journals lj on lj.journal_id = le.journal_id
       left join lateral (
         select sum(fe.amount) as amount, min(fe.asset_code) as asset_code
         from ledger_entries fe
         where fe.journal_id = le.journal_id
           and fe.reference_type = 'spot_trade_fee'
           and le.direction = 'credit'
           and le.reference_type = 'spot_trade'
         having count(*) > 0
       ) fee on true
       where le.account_id = $1
         and ($2::text is null or le.asset_code = $2)
       order by le.created_at asc, le.entry_id asc`,
      [accountId, assetCode ?? null]
    );

    type BalanceEventPayload = {
      amount?: string;
      assetCode?: string;
      referenceType?: string;
      referenceId?: string;
      settled?: boolean;
    };
    const lockRows = await this.db.query<{
      event_id: string;
      aggregate_id: string;
      event_type: StatementLockEventSource["eventType"];
      payload: { payload?: BalanceEventPayload } & BalanceEventPayload;
      created_at: Date;
    }>(
      `select event_id, aggregate_id, event_type, payload, created_at
       from outbox_events
       where aggregate_type = 'balance'
         and event_type in ('balance.locked', 'balance.released', 'balance.consumed')
         and (case when $2::text is null
                   then aggregate_id like $1 || ':%'
                   else aggregate_id = $1 || ':' || $2 end)
       order by created_at asc, event_id asc`,
      [accountId, assetCode ?? null]
    );

    return {
      entries: entryRows.rows.map((row) => ({
        ...mapLedgerEntryRecord(row),
        feeAmount: row.fee_amount ?? undefined,
        feeAssetCode: row.fee_asset_code ?? undefined
      })),
      lockEvents: lockRows.rows.map((row) => {
        // The outbox stores `{ payload, trace_id, occurred_at }` envelopes.
        const payload = row.payload.payload ?? row.payload;
        return {
          eventId: row.event_id,
          eventType: row.event_type,
          assetCode: String(
            payload.assetCode ?? row.aggregate_id.slice(accountId.length + 1)
          ) as AssetCode,
          amount: String(payload.amount ?? "0"),
          referenceType: String(payload.referenceType ?? ""),
          referenceId: String(payload.referenceId ?? ""),
          settled: payload.settled === true,
          createdAt: row.created_at.toISOString()
        };
      })
    };
  }

  async saveBalanceLock(lock: BalanceLock): Promise<void> {
    await this.db.query(
      `insert into balance_locks
       (lock_id, account_id, asset_code, reference_type, reference_id, amount, remaining_amount, status, created_at, released_at, consumed_at)
       values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, $11)
       on conflict (reference_type, reference_id, account_id, asset_code) do update
       set remaining_amount = excluded.remaining_amount,
           status = excluded.status,
           released_at = excluded.released_at,
           consumed_at = excluded.consumed_at`,
      [
        lock.lockId,
        lock.accountId,
        lock.assetCode,
        lock.referenceType,
        lock.referenceId,
        lock.amount,
        lock.remainingAmount,
        lock.status,
        lock.createdAt,
        lock.releasedAt ?? null,
        lock.consumedAt ?? null
      ]
    );
  }

  async findBalanceLock(
    accountId: string,
    assetCode: AssetCode,
    referenceType: string,
    referenceId: string
  ): Promise<BalanceLock | null> {
    const result = await this.db.query<LockRow>(
      `select lock_id, account_id, asset_code, reference_type, reference_id,
              amount::text as amount, remaining_amount::text as remaining_amount,
              status, created_at, released_at, consumed_at
       from balance_locks
       where account_id = $1 and asset_code = $2 and reference_type = $3 and reference_id = $4${
         this.transactionOwner ? "" : "\n       for update"
       }`,
      [accountId, assetCode, referenceType, referenceId]
    );

    return result.rows[0] ? mapBalanceLock(result.rows[0]) : null;
  }

  async saveEvent(event: LedgerEvent): Promise<void> {
    await this.db.query(
      `insert into outbox_events
       (event_id, aggregate_type, aggregate_id, event_type, payload, created_at, publish_attempts)
       values ($1, $2, $3, $4, $5::jsonb, $6, 0)`,
      [
        event.eventId,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify({
          trace_id: event.traceId,
          occurred_at: event.occurredAt,
          payload: event.payload
        }),
        event.occurredAt
      ]
    );
  }

  async listPendingOutboxEvents(limit: number, now: string): Promise<OutboxEventRecord[]> {
    const result = await this.db.query<OutboxEventRow>(
      `select event_id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at,
              publish_attempts, last_error, last_attempted_at, next_attempt_at, dead_lettered_at
       from outbox_events
       where published_at is null
         and dead_lettered_at is null
         and (next_attempt_at is null or next_attempt_at <= $2)
       order by coalesce(next_attempt_at, created_at) asc, created_at asc
       limit $1`,
      [limit, now]
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at?.toISOString(),
      publishAttempts: Number(row.publish_attempts),
      lastError: row.last_error ?? undefined,
      lastAttemptedAt: row.last_attempted_at?.toISOString(),
      nextAttemptAt: row.next_attempt_at?.toISOString(),
      deadLetteredAt: row.dead_lettered_at?.toISOString()
    }));
  }

  async listDeadLetteredOutboxEvents(limit: number): Promise<OutboxEventRecord[]> {
    const result = await this.db.query<OutboxEventRow>(
      `select event_id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at,
              publish_attempts, last_error, last_attempted_at, next_attempt_at, dead_lettered_at
       from outbox_events
       where published_at is null
         and dead_lettered_at is not null
       order by dead_lettered_at asc, created_at asc
       limit $1`,
      [limit]
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at?.toISOString(),
      publishAttempts: Number(row.publish_attempts),
      lastError: row.last_error ?? undefined,
      lastAttemptedAt: row.last_attempted_at?.toISOString(),
      nextAttemptAt: row.next_attempt_at?.toISOString(),
      deadLetteredAt: row.dead_lettered_at?.toISOString()
    }));
  }

  async requeueOutboxEvents(eventIds: string[], _requeuedAt: string): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }

    await this.db.query(
      `update outbox_events
       set publish_attempts = 0,
           last_error = null,
           last_attempted_at = null,
           next_attempt_at = null,
           dead_lettered_at = null
       where event_id = any($1::uuid[])
         and published_at is null`,
      [eventIds]
    );
  }

  async markOutboxEventsPublished(eventIds: string[], publishedAt: string): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }

    await this.db.query(
      `update outbox_events
       set published_at = $2,
           last_error = null,
           next_attempt_at = null
       where event_id = any($1::uuid[])`,
      [eventIds, publishedAt]
    );
  }

  async recordOutboxEventFailure(params: {
    eventId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    deadLetteredAt?: string;
  }): Promise<void> {
    await this.db.query(
      `update outbox_events
       set publish_attempts = publish_attempts + 1,
           last_error = $2,
           last_attempted_at = $3,
           next_attempt_at = $4,
           dead_lettered_at = $5
       where event_id = $1`,
      [
        params.eventId,
        params.errorMessage,
        params.attemptedAt,
        params.nextAttemptAt ?? null,
        params.deadLetteredAt ?? null
      ]
    );
  }

  private async insertJournalEntry(journalId: string, entry: JournalLine): Promise<void> {
    await this.db.query(
      `insert into ledger_entries
       (journal_id, account_id, asset_code, direction, amount, reference_type, reference_id)
       values ($1, $2, $3, $4, $5::numeric, $6, $7)`,
      [
        journalId,
        entry.accountId,
        entry.assetCode,
        entry.direction,
        entry.amount,
        entry.referenceType,
        entry.referenceId
      ]
    );
  }

  private async mapJournal(row: JournalRow | undefined): Promise<LedgerJournal | null> {
    if (!row) {
      return null;
    }

    const entriesResult = await this.db.query<JournalEntryRow>(
      `select entry_id, journal_id, account_id, asset_code, direction, amount::text as amount,
              reference_type, reference_id, created_at
       from ledger_entries
       where journal_id = $1
       order by created_at asc`,
      [row.journal_id]
    );

    return {
      journalId: row.journal_id,
      businessType: row.business_type,
      businessId: row.business_id,
      idempotencyKey: row.idempotency_key,
      traceId: row.trace_id,
      description: row.description ?? undefined,
      createdAt: row.created_at.toISOString(),
      entries: entriesResult.rows.map(mapJournalEntry)
    };
  }
}

/** unique_violation (23505) on ledger_journals.idempotency_key. */
function isIdempotencyKeyUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { code, constraint, detail } = error as {
    code?: string;
    constraint?: string;
    detail?: string;
  };
  return (
    code === "23505" &&
    (constraint?.includes("idempotency_key") === true || detail?.includes("idempotency_key") === true)
  );
}

function mapAccount(row: AccountRow | undefined): LedgerAccount {
  if (!row) {
    throw new Error("Account row is required");
  }

  return {
    accountId: row.account_id,
    userId: row.user_id ?? undefined,
    accountType: row.account_type as LedgerAccount["accountType"],
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapBalance(row: BalanceRow): BalanceSnapshot {
  return {
    accountId: row.account_id,
    assetCode: row.asset_code,
    available: row.available,
    locked: row.locked,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapJournalEntry(row: JournalEntryRow): JournalLine {
  return {
    accountId: row.account_id,
    assetCode: row.asset_code,
    direction: row.direction,
    amount: row.amount,
    referenceType: row.reference_type,
    referenceId: row.reference_id
  };
}

function mapLedgerEntryRecord(row: JournalEntryRow): LedgerEntryRecord {
  return {
    entryId: row.entry_id ?? "",
    journalId: row.journal_id ?? "",
    accountId: row.account_id,
    assetCode: row.asset_code,
    direction: row.direction,
    amount: row.amount,
    businessType: row.business_type ?? "",
    businessId: row.business_id ?? "",
    traceId: row.trace_id ?? "",
    description: row.description ?? undefined,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    createdAt: row.created_at?.toISOString() ?? new Date(0).toISOString()
  };
}

function mapBalanceLock(row: LockRow): BalanceLock {
  return {
    lockId: row.lock_id,
    accountId: row.account_id,
    assetCode: row.asset_code,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    amount: row.amount,
    remainingAmount: row.remaining_amount,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    releasedAt: row.released_at?.toISOString(),
    consumedAt: row.consumed_at?.toISOString()
  };
}
