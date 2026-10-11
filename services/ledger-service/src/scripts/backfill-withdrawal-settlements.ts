import { randomUUID } from "node:crypto";

import type { AssetCode } from "@web3-cex/domain";

import type { BalanceLock, BalanceSnapshot, LedgerJournal } from "../domain/types.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

interface HistoricalWithdrawalSettlementRow {
  withdrawal_id: string;
  ledger_account_id: string;
  asset_code: AssetCode;
  freeze_reference_id: string | null;
  confirmed_at: Date | null;
  consumed_at: Date | null;
  lock_id: string;
  amount: string;
}

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const repository = new PostgresLedgerRepository(pool, pool);
  const settlementAccountId =
    process.env.LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID ??
    process.env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
    "00000000-0000-0000-0000-000000000098";

  try {
    await repository.createAccount({
      accountId: settlementAccountId,
      accountType: "funding"
    });

    const candidates = await pool.query<HistoricalWithdrawalSettlementRow>(
      `select w.withdrawal_id,
              w.ledger_account_id,
              w.asset_code,
              w.freeze_reference_id,
              w.confirmed_at,
              bl.consumed_at,
              bl.lock_id,
              bl.amount::text as amount
       from withdrawals w
       join balance_locks bl
        on bl.account_id = w.ledger_account_id
       and bl.asset_code = w.asset_code
       and bl.reference_type = 'withdrawal'
       and bl.reference_id = coalesce(w.freeze_reference_id, w.withdrawal_id::text)
       where w.status = 'confirmed'
         and bl.status = 'consumed'
         and not exists (
           select 1
           from ledger_journals lj
           where lj.idempotency_key = concat(
             'withdrawal:settlement:',
             coalesce(w.freeze_reference_id, w.withdrawal_id::text)
           )
         )
       order by coalesce(w.confirmed_at, bl.consumed_at, now()) asc`
    );

    let processed = 0;

    for (const row of candidates.rows) {
      const referenceId = row.freeze_reference_id ?? row.withdrawal_id;
      const createdAt = (row.confirmed_at ?? row.consumed_at ?? new Date()).toISOString();
      const journal: LedgerJournal = {
        journalId: randomUUID(),
        businessType: "withdrawal_settled",
        businessId: row.withdrawal_id,
        idempotencyKey: `withdrawal:settlement:${referenceId}`,
        traceId: `withdrawal:${row.withdrawal_id}`,
        description: `Backfilled withdrawal settlement for ${row.withdrawal_id}`,
        entries: [
          {
            accountId: row.ledger_account_id,
            assetCode: row.asset_code,
            direction: "debit",
            amount: row.amount,
            referenceType: "withdrawal",
            referenceId
          },
          {
            accountId: settlementAccountId,
            assetCode: row.asset_code,
            direction: "credit",
            amount: row.amount,
            referenceType: "withdrawal",
            referenceId
          }
        ],
        createdAt
      };

      await repository.saveJournal(journal);

      const existingSettlementBalance =
        (await repository.findBalance(settlementAccountId, row.asset_code)) ??
        ({
          accountId: settlementAccountId,
          assetCode: row.asset_code,
          available: "0",
          locked: "0",
          version: 0,
          updatedAt: createdAt
        } satisfies BalanceSnapshot);
      const nextSettlementBalance: BalanceSnapshot = {
        ...existingSettlementBalance,
        available: addDecimalAmounts(existingSettlementBalance.available, row.amount),
        version: existingSettlementBalance.version + 1,
        updatedAt: createdAt
      };

      const existingLock = await repository.findBalanceLock(
        row.ledger_account_id,
        row.asset_code,
        "withdrawal",
        referenceId
      );

      if (!existingLock) {
        throw new Error(`Missing balance lock for withdrawal ${row.withdrawal_id}`);
      }

      const settledLock: BalanceLock = {
        ...existingLock,
        status: "settled",
        releasedAt: createdAt,
        consumedAt: undefined
      };

      await repository.saveBalance(nextSettlementBalance);
      await repository.saveBalanceLock(settledLock);
      processed += 1;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          settlementAccountId,
          processed
        },
        null,
        2
      )}\n`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const SCALE = 18n;
const BASE = 10n ** SCALE;

function addDecimalAmounts(left: string, right: string): string {
  return fromSignedAtomicUnits(toSignedAtomicUnits(left) + toSignedAtomicUnits(right));
}

function toSignedAtomicUnits(amount: string): bigint {
  const normalized = amount.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }

  const [whole = "0", fraction = ""] = unsigned.split(".");
  const value = BigInt(whole) * BASE + BigInt(fraction.padEnd(Number(SCALE), "0"));
  return negative ? -value : value;
}

function fromSignedAtomicUnits(value: bigint): string {
  if (value === 0n) {
    return "0";
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / BASE;
  const fraction = absolute % BASE;
  const rendered =
    fraction === 0n
      ? whole.toString()
      : `${whole.toString()}.${fraction
          .toString()
          .padStart(Number(SCALE), "0")
          .replace(/0+$/, "")}`;

  return negative ? `-${rendered}` : rendered;
}
