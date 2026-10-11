import assert from "node:assert/strict";
import test from "node:test";

import { ApiGatewayApplicationService } from "../application/api-gateway-application-service.js";
import {
  buildTradeJournalView,
  buildTradeMaskingContext,
  checkJournalBalance
} from "../domain/journal-view.js";
import type {
  GatewayLedgerAccount,
  GatewayLedgerJournal,
  GatewayPrincipal,
  GatewayTradeRecord,
  IdentityGatewayClient,
  LedgerGatewayClient,
  OrderGatewayClient,
  WalletGatewayClient
} from "../domain/types.js";
import { InMemoryRateLimiter } from "../infrastructure/in-memory-rate-limiter.js";

const TRADE: GatewayTradeRecord = {
  tradeId: "trade-1",
  market: "ETH-USDT",
  price: "2000",
  quantity: "0.5",
  makerOrderId: "order-seller",
  takerOrderId: "order-buyer",
  buyerOrderId: "order-buyer",
  sellerOrderId: "order-seller",
  buyerUserId: "user-buyer",
  sellerUserId: "user-seller",
  buyerAccountId: "acct-buyer",
  sellerAccountId: "acct-seller",
  settlementId: "settlement-1",
  executedAt: "2026-10-10T00:00:00.000Z"
};

const ACCOUNTS: Record<string, GatewayLedgerAccount> = {
  "acct-buyer": account("acct-buyer", "spot", "user-buyer"),
  "acct-seller": account("acct-seller", "spot", "user-seller"),
  "settle-eth": account("settle-eth", "spot"),
  "settle-usdt": account("settle-usdt", "spot"),
  "fee-eth": account("fee-eth", "fee"),
  "fee-usdt": account("fee-usdt", "fee")
};

/** Same shape settlement-service posts: 2 lock consumptions + base / quote legs. */
function tradeJournals(): GatewayLedgerJournal[] {
  const at = "2026-10-10T00:00:01.000Z";
  return [
    {
      journalId: "j-quote",
      businessType: "spot_trade_settlement_quote",
      businessId: "trade-1",
      idempotencyKey: "spot_trade:quote:trade-1",
      traceId: "trace-secret",
      entries: [
        line("settle-usdt", "USDT", "debit", "1000", "spot_trade"),
        line("acct-seller", "USDT", "credit", "999.2", "spot_trade"),
        line("fee-usdt", "USDT", "credit", "0.8", "spot_trade_fee")
      ],
      createdAt: at
    },
    {
      journalId: "j-lock-seller",
      businessType: "withdrawal_settled",
      businessId: "trade-1",
      idempotencyKey: "spot_order:order-seller:ETH:settlement:trade-1",
      traceId: "trace-secret",
      entries: [
        line("acct-seller", "ETH", "debit", "0.5", "spot_order", "order-seller"),
        line("settle-eth", "ETH", "credit", "0.5", "spot_order", "order-seller")
      ],
      createdAt: at
    },
    {
      journalId: "j-lock-buyer",
      businessType: "withdrawal_settled",
      businessId: "trade-1",
      idempotencyKey: "spot_order:order-buyer:USDT:settlement:trade-1",
      traceId: "trace-secret",
      entries: [
        line("acct-buyer", "USDT", "debit", "1000", "spot_order", "order-buyer"),
        line("settle-usdt", "USDT", "credit", "1000", "spot_order", "order-buyer")
      ],
      createdAt: at
    },
    {
      journalId: "j-base",
      businessType: "spot_trade_settlement_base",
      businessId: "trade-1",
      idempotencyKey: "spot_trade:base:trade-1",
      traceId: "trace-secret",
      entries: [
        line("settle-eth", "ETH", "debit", "0.5", "spot_trade"),
        line("acct-buyer", "ETH", "credit", "0.4995", "spot_trade"),
        line("fee-eth", "ETH", "credit", "0.0005", "spot_trade_fee")
      ],
      createdAt: at
    },
    {
      // Unrelated journal that happens to share the business id: ignored.
      journalId: "j-noise",
      businessType: "withdrawal_settled",
      businessId: "trade-1",
      idempotencyKey: "withdrawal:x",
      traceId: "t",
      entries: [
        line("acct-seller", "USDT", "debit", "1", "withdrawal", "w-1"),
        line("settle-usdt", "USDT", "credit", "1", "withdrawal", "w-1")
      ],
      createdAt: at
    }
  ];
}

test("checkJournalBalance totals debit and credit per asset", () => {
  const checks = checkJournalBalance([
    { assetCode: "USDT", direction: "debit", amount: "1000" },
    { assetCode: "USDT", direction: "credit", amount: "999.2" },
    { assetCode: "USDT", direction: "credit", amount: "0.8" },
    { assetCode: "ETH", direction: "debit", amount: "0.5" },
    { assetCode: "ETH", direction: "credit", amount: "0.4" }
  ]);
  assert.deepEqual(checks, [
    { assetCode: "ETH", debitTotal: "0.5", creditTotal: "0.4", balanced: false },
    { assetCode: "USDT", debitTotal: "1000", creditTotal: "1000", balanced: true }
  ]);
});

test("trade journal view is balanced per asset and masks the counterparty", () => {
  const directory = new Map(
    ["settle-eth", "settle-usdt", "fee-eth", "fee-usdt"].map((id) => [
      id,
      { userId: ACCOUNTS[id]!.userId, accountType: ACCOUNTS[id]!.accountType }
    ])
  );
  const view = buildTradeJournalView({
    trade: TRADE,
    viewerUserId: "user-buyer",
    journals: tradeJournals(),
    context: buildTradeMaskingContext(TRADE, "user-buyer", directory)
  });

  assert.equal(view.viewerSide, "buy");
  assert.equal(view.viewerLiquidity, "taker");
  assert.equal(view.settled, true);
  assert.equal(view.balanced, true);
  assert.deepEqual(
    view.journals.map((journal) => journal.journalId),
    ["j-lock-seller", "j-lock-buyer", "j-base", "j-quote"]
  );
  assert.ok(view.journals.every((journal) => journal.balanced));
  assert.deepEqual(view.totals, [
    { assetCode: "ETH", debitTotal: "1", creditTotal: "1", balanced: true },
    { assetCode: "USDT", debitTotal: "2000", creditTotal: "2000", balanced: true }
  ]);
  assert.deepEqual(view.viewerChanges, [
    { assetCode: "ETH", netChange: "0.4995" },
    { assetCode: "USDT", netChange: "-1000" }
  ]);

  const labels = view.journals.flatMap((journal) =>
    journal.entries.map((entry) => `${entry.accountRole}:${entry.accountLabel}`)
  );
  assert.ok(labels.includes("self:我的现货账户"));
  assert.ok(labels.includes("counterparty:对手方"));
  assert.ok(labels.includes("platform_fee:平台手续费账户（ETH）"));
  assert.ok(labels.includes("platform_settlement:平台结算中转账户（USDT）"));

  // No raw ids, user ids, order ids or trace ids leak into the view.
  const serialized = JSON.stringify(view);
  for (const secret of [
    "acct-buyer",
    "acct-seller",
    "user-seller",
    "user-buyer",
    "order-seller",
    "order-buyer",
    "settle-eth",
    "fee-usdt",
    "trace-secret"
  ]) {
    assert.ok(!serialized.includes(secret), `view leaks ${secret}`);
  }
});

test("seller sees the buyer as counterparty and unknown accounts stay masked", () => {
  const view = buildTradeJournalView({
    trade: TRADE,
    viewerUserId: "user-seller",
    journals: tradeJournals(),
    context: buildTradeMaskingContext(TRADE, "user-seller")
  });
  assert.equal(view.viewerSide, "sell");
  assert.equal(view.viewerLiquidity, "maker");
  const lockBuyer = view.journals.find((journal) => journal.journalId === "j-lock-buyer")!;
  assert.equal(lockBuyer.entries[0]?.accountLabel, "对手方");
  assert.match(lockBuyer.stageLabel, /对手方/);
  // Without a directory, platform accounts are labelled generically.
  assert.equal(lockBuyer.entries[1]?.accountRole, "unknown");
  assert.deepEqual(view.viewerChanges, [
    { assetCode: "ETH", netChange: "-0.5" },
    { assetCode: "USDT", netChange: "999.2" }
  ]);
});

test("an unsettled trade reports no journals and is not marked balanced", () => {
  const view = buildTradeJournalView({
    trade: TRADE,
    viewerUserId: "user-buyer",
    journals: [],
    context: buildTradeMaskingContext(TRADE, "user-buyer")
  });
  assert.equal(view.settled, false);
  assert.equal(view.balanced, false);
  assert.deepEqual(view.journals, []);
});

test("gateway getTradeJournals enforces trade ownership and resolves platform accounts", async () => {
  const lookups: string[] = [];
  const ledgerClient = {
    async getAccount(accountId: string) {
      lookups.push(accountId);
      const found = ACCOUNTS[accountId];
      if (!found) {
        throw new Error("not found");
      }
      return found;
    },
    async listJournalsWithEntries(query: { businessId?: string }) {
      assert.equal(query.businessId, "trade-1");
      return tradeJournals();
    }
  } as unknown as LedgerGatewayClient;
  const orderClient = {
    async getTrade(tradeId: string) {
      assert.equal(tradeId, "trade-1");
      return TRADE;
    }
  } as unknown as OrderGatewayClient;
  const service = new ApiGatewayApplicationService(
    {} as IdentityGatewayClient,
    {} as WalletGatewayClient,
    ledgerClient,
    orderClient,
    new InMemoryRateLimiter()
  );

  const view = await service.getTradeJournals(principal("user-buyer"), "trade-1");
  assert.equal(view.balanced, true);
  // Only platform accounts are looked up; both customer accounts come from the trade.
  assert.deepEqual(lookups.sort(), ["fee-eth", "fee-usdt", "settle-eth", "settle-usdt"]);
  assert.ok(
    view.journals
      .flatMap((journal) => journal.entries)
      .every((entry) => entry.accountRole !== "unknown")
  );

  await assert.rejects(
    () => service.getTradeJournals(principal("user-other"), "trade-1"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 403
  );
});

function principal(userId: string): GatewayPrincipal {
  return {
    authType: "session",
    userId,
    email: `${userId}@example.com`,
    status: "active",
    userType: "customer",
    roles: [],
    permissions: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    active: true
  } as GatewayPrincipal;
}

function account(
  accountId: string,
  accountType: GatewayLedgerAccount["accountType"],
  userId?: string
): GatewayLedgerAccount {
  return {
    accountId,
    userId,
    accountType,
    status: "active",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z"
  };
}

function line(
  accountId: string,
  assetCode: string,
  direction: "debit" | "credit",
  amount: string,
  referenceType: string,
  referenceId = "trade-1"
) {
  return { accountId, assetCode, direction, amount, referenceType, referenceId };
}
