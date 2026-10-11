// Integration test against a real PostgreSQL (the in-memory repository cannot
// reproduce concurrency bugs such as lost balance updates).
//
// Runs only when LEDGER_TEST_DATABASE_URL is set, e.g.
//   LEDGER_TEST_DATABASE_URL=postgres://web3:web3@127.0.0.1:5432/web3_cex pnpm test
// Each run creates and drops its own schema, so it never touches demo data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AssetCode } from "@web3-cex/domain";
import pg from "pg";

import { LedgerApplicationService } from "../application/ledger-application-service.js";
import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const TRADES = Number(process.env.LEDGER_TEST_TRADES ?? "40");

test(
  "concurrent freezes, partial settlements and releases keep the ledger reconcilable",
  { skip: !DATABASE_URL ? "set LEDGER_TEST_DATABASE_URL to run" : false, timeout: 120_000 },
  async (t) => {
    const schema = `ledger_it_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`create schema ${schema}`);
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 20,
      options: `-c search_path=${schema},public`
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    });

    const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sql");
    for (const file of (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(path.join(sqlDir, file), "utf8"));
    }

    const service = new LedgerApplicationService(new PostgresLedgerRepository(pool, pool));
    const reporter = new LedgerOpsReporter(pool);
    const id = () => randomUUID();
    const opening = id();
    const buyer = id();
    const seller = id();
    const settlement = id();

    await service.createAccount({ accountId: opening, accountType: "opening_balance" });
    for (const accountId of [buyer, seller, settlement]) {
      await service.createAccount({ accountId, userId: id(), accountType: "spot" });
    }

    const seed = (accountId: string, assetCode: AssetCode, amount: string) =>
      service.postJournal({
        businessType: "seed",
        businessId: id(),
        idempotencyKey: id(),
        traceId: "seed",
        entries: [
          { accountId: opening, assetCode, direction: "debit", amount, referenceType: "seed", referenceId: accountId },
          { accountId, assetCode, direction: "credit", amount, referenceType: "seed", referenceId: accountId }
        ]
      });
    await seed(buyer, "USDT", "1000000");
    await seed(seller, "ETH", "1000");

    // One "trade": both sides freeze, part of each lock is settled through the
    // settlement account, the counter-asset is credited, the rest is released.
    // Every step of every trade races with all other trades.
    const trade = async (index: number) => {
      const price = (3000 + (index % 7)).toString();
      const quantity = (1 + (index % 5) / 10).toFixed(1);
      const filled = (Number(quantity) * 0.6).toFixed(2);
      const quote = (Number(price) * Number(quantity)).toFixed(2);
      const quoteFilled = (Number(price) * Number(filled)).toFixed(2);
      const buyRef = `buy-${index}`;
      const sellRef = `sell-${index}`;

      await Promise.all([
        service.freezeBalance({ accountId: buyer, assetCode: "USDT", amount: quote, referenceType: "spot_order", referenceId: buyRef }),
        service.freezeBalance({ accountId: seller, assetCode: "ETH", amount: quantity, referenceType: "spot_order", referenceId: sellRef })
      ]);
      await Promise.all([
        service.consumeBalance({
          accountId: buyer, assetCode: "USDT", referenceType: "spot_order", referenceId: buyRef,
          amount: quoteFilled, settlementAccountId: settlement, businessId: `trade-${index}`, traceId: `trade-${index}`
        }),
        service.consumeBalance({
          accountId: seller, assetCode: "ETH", referenceType: "spot_order", referenceId: sellRef,
          amount: filled, settlementAccountId: settlement, businessId: `trade-${index}`, traceId: `trade-${index}`
        })
      ]);
      await service.postJournal({
        businessType: "trade_settlement",
        businessId: `trade-${index}`,
        idempotencyKey: `trade-${index}:transfer`,
        traceId: `trade-${index}`,
        entries: [
          { accountId: settlement, assetCode: "ETH", direction: "debit", amount: filled, referenceType: "trade", referenceId: `${index}` },
          { accountId: buyer, assetCode: "ETH", direction: "credit", amount: filled, referenceType: "trade", referenceId: `${index}` },
          { accountId: settlement, assetCode: "USDT", direction: "debit", amount: quoteFilled, referenceType: "trade", referenceId: `${index}` },
          { accountId: seller, assetCode: "USDT", direction: "credit", amount: quoteFilled, referenceType: "trade", referenceId: `${index}` }
        ]
      });
      await Promise.all([
        service.releaseBalance({ accountId: buyer, assetCode: "USDT", referenceType: "spot_order", referenceId: buyRef }),
        service.releaseBalance({ accountId: seller, assetCode: "ETH", referenceType: "spot_order", referenceId: sellRef })
      ]);
      return { filled: Number(filled), quoteFilled: Number(quoteFilled) };
    };

    // Reconcile continuously while trades are in flight: each report reads a
    // single snapshot, so it must never see a half-applied mix of tables.
    let running = true;
    const inFlightMismatches: number[] = [];
    const reconcileLoop = (async () => {
      while (running) {
        const report = await reporter.reconcileBalances({ includeMatched: true });
        inFlightMismatches.push(report.mismatchCount);
      }
    })();
    const results = await Promise.all(Array.from({ length: TRADES }, (_, index) => trade(index)));
    running = false;
    await reconcileLoop;
    assert.ok(inFlightMismatches.length > 0);
    assert.deepEqual(
      inFlightMismatches.filter((count) => count > 0),
      [],
      `reconciliations during trading saw mismatches (${inFlightMismatches.length} runs)`
    );
    const boughtEth = results.reduce((sum, item) => sum + item.filled, 0);
    const paidUsdt = results.reduce((sum, item) => sum + item.quoteFilled, 0);

    const reconciliation = await reporter.reconcileBalances({ includeMatched: true });
    assert.equal(reconciliation.mismatchCount, 0, JSON.stringify(reconciliation.items.filter((item) => item.mismatchReasons.length > 0), null, 2));

    const buyerUsdt = await service.getBalance(buyer, "USDT");
    const buyerEth = await service.getBalance(buyer, "ETH");
    const sellerEth = await service.getBalance(seller, "ETH");
    assert.equal(Number(buyerUsdt.locked), 0);
    assert.equal(Number(sellerEth.locked), 0);
    assert.ok(Math.abs(Number(buyerUsdt.available) - (1_000_000 - paidUsdt)) < 1e-9);
    assert.ok(Math.abs(Number(buyerEth.available) - boughtEth) < 1e-9);
    assert.ok(Math.abs(Number(sellerEth.available) - (1000 - boughtEth)) < 1e-9);

    for (const [accountId, assetCode] of [[buyer, "USDT"], [seller, "ETH"], [buyer, "ETH"]] as const) {
      const replay = await reporter.replayAccount({ accountId, assetCode });
      assert.equal(replay.mismatch, false, `${assetCode} replay of ${accountId}`);
    }
  }
);
