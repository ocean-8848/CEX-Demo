import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { QueryResult } from "pg";

import { PostgresSettlementRepository } from "../infrastructure/postgres-settlement-repository.js";

test("saveSettlement binds all trade_settlements columns", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    async query(sql: string, values: unknown[] = []): Promise<QueryResult<Record<string, unknown>>> {
      queries.push({
        sql,
        values
      });
      return {
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: []
      };
    }
  };

  const repository = new PostgresSettlementRepository(
    db as unknown as ConstructorParameters<typeof PostgresSettlementRepository>[0],
    {} as unknown as Pool
  );

  await repository.saveSettlement({
    settlementId: "settlement-1",
    tradeId: "trade-1",
    market: "ETH-USDT",
    price: "3200.00",
    quantity: "0.05",
    quoteAmount: "160.00",
    feeAmount: "0.08",
    buyerFeeAmount: "0",
    buyerOrderId: "buyer-order-1",
    sellerOrderId: "seller-order-1",
    buyerUserId: "buyer-user-1",
    sellerUserId: "seller-user-1",
    buyerAccountId: "buyer-account-1",
    sellerAccountId: "seller-account-1",
    executionId: "execution-1",
    executionBatchId: "batch-1",
    executionSequence: 1,
    executionBatchSequence: 1,
    replayCursor: "ETH-USDT:1",
    protocolVersion: "v2",
    buyerSettlementJournalId: "journal-buyer-1",
    sellerSettlementJournalId: "journal-seller-1",
    status: "settled",
    attemptCount: 1,
    createdAt: "2026-03-11T12:00:00.000Z",
    updatedAt: "2026-03-11T12:00:00.000Z",
    lastAttemptAt: "2026-03-11T12:00:00.000Z",
    settledAt: "2026-03-11T12:00:00.000Z"
  });

  const insert = queries.find((entry) => entry.sql.includes("insert into trade_settlements"));
  assert.ok(insert, "trade_settlements insert query missing");
  assert.match(insert.sql, /\$33\b/);
  assert.equal(insert.values.length, 33);
});
