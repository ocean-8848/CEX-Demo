import { randomUUID } from "node:crypto";

import type { AssetCode } from "@web3-cex/domain";

import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
import { createLedgerPool } from "../infrastructure/postgres.js";
import type { BalanceSnapshot, LedgerJournal } from "../domain/types.js";

async function main(): Promise<void> {
  const pool = createLedgerPool();
  const repository = new PostgresLedgerRepository(pool, pool);
  const reporter = new LedgerOpsReporter(pool);
  const openingBalanceAccountId =
    process.env.LEDGER_OPENING_BALANCE_ACCOUNT_ID ??
    "00000000-0000-0000-0000-000000000090";
  const now = new Date().toISOString();

  try {
    await repository.createAccount({
      accountId: openingBalanceAccountId,
      accountType: "opening_balance"
    });

    const report = await reporter.reconcileBalances({
      includeMatched: false,
      generatedAt: now
    });

    let processed = 0;

    for (const item of report.items) {
      if (item.accountId === openingBalanceAccountId) {
        continue;
      }

      const delta = subtractSignedAmounts(item.snapshotTotal, item.expectedTotal);
      if (delta === "0") {
        continue;
      }

      const idempotencyKey = `opening-balance:backfill:${item.accountId}:${item.assetCode}`;
      const existing = await repository.findJournalByIdempotencyKey(idempotencyKey);
      if (existing) {
        continue;
      }

      const amount = absoluteDecimalAmount(delta);
      const targetDirection = delta.startsWith("-") ? "debit" : "credit";
      const openingDirection = targetDirection === "credit" ? "debit" : "credit";

      const journal: LedgerJournal = {
        journalId: randomUUID(),
        businessType: "opening_balance_backfill",
        businessId: `${item.accountId}:${item.assetCode}`,
        idempotencyKey,
        traceId: `opening-balance:${item.accountId}:${item.assetCode}`,
        description: `Backfilled opening balance for ${item.accountId} ${item.assetCode}`,
        entries: [
          {
            accountId: openingBalanceAccountId,
            assetCode: item.assetCode,
            direction: openingDirection,
            amount,
            referenceType: "opening_balance",
            referenceId: item.accountId
          },
          {
            accountId: item.accountId,
            assetCode: item.assetCode,
            direction: targetDirection,
            amount,
            referenceType: "opening_balance",
            referenceId: item.accountId
          }
        ],
        createdAt: now
      };

      await repository.saveJournal(journal);
      processed += 1;
    }

    const openingNetRows = await pool.query<{
      asset_code: AssetCode;
      net_amount: string;
    }>(
      `select asset_code,
              coalesce(
                sum(case when direction = 'credit' then amount else -amount end),
                0
              )::text as net_amount
       from ledger_entries
       where account_id = $1
       group by asset_code`,
      [openingBalanceAccountId]
    );

    for (const row of openingNetRows.rows) {
      const existing =
        (await repository.findBalance(openingBalanceAccountId, row.asset_code)) ??
        ({
          accountId: openingBalanceAccountId,
          assetCode: row.asset_code,
          available: "0",
          locked: "0",
          version: 0,
          updatedAt: now
        } satisfies BalanceSnapshot);

      await repository.saveBalance({
        ...existing,
        available: row.net_amount,
        locked: "0",
        version: existing.version + 1,
        updatedAt: now
      });
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          openingBalanceAccountId,
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

function subtractSignedAmounts(left: string, right: string): string {
  return fromSignedAtomicUnits(toSignedAtomicUnits(left) - toSignedAtomicUnits(right));
}

function absoluteDecimalAmount(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
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
