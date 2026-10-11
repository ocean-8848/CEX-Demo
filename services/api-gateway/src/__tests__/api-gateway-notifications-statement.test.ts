import assert from "node:assert/strict";
import test from "node:test";

import { ApiGatewayApplicationService } from "../application/api-gateway-application-service.js";
import type {
  GatewayAccountStatementQuery,
  GatewayPrincipal,
  IdentityGatewayClient,
  LedgerGatewayClient,
  OrderGatewayClient,
  WalletGatewayClient
} from "../domain/types.js";
import { InMemoryRateLimiter } from "../infrastructure/in-memory-rate-limiter.js";

const principal: GatewayPrincipal = {
  authType: "session",
  userId: "user-1",
  status: "active",
  userType: "customer",
  roles: [],
  permissions: [],
  createdAt: "2026-03-07T00:00:00.000Z",
  active: true
};

function createService(overrides: {
  walletClient?: Partial<WalletGatewayClient>;
  ledgerClient?: Partial<LedgerGatewayClient>;
}) {
  return new ApiGatewayApplicationService(
    {} as IdentityGatewayClient,
    (overrides.walletClient ?? {}) as WalletGatewayClient,
    (overrides.ledgerClient ?? {}) as LedgerGatewayClient,
    {} as OrderGatewayClient,
    new InMemoryRateLimiter()
  );
}

test("notification read markers are always scoped to the authenticated user", async () => {
  const calls: Array<{ userId: string; notificationIds?: string[] }> = [];
  const service = createService({
    walletClient: {
      async markWalletNotificationsRead(command) {
        calls.push(command);
        return { updated: 1, readAt: "2026-03-07T00:00:00.000Z", unreadCount: 0 };
      },
      async countUnreadWalletNotifications(userId) {
        return { unreadCount: userId === "user-1" ? 3 : 0 };
      }
    }
  });

  assert.deepEqual(await service.countUnreadWalletNotifications(principal), { unreadCount: 3 });
  await service.markWalletNotificationRead(principal, " notification-1 ");
  await service.markAllWalletNotificationsRead(principal);
  assert.deepEqual(calls, [
    { userId: "user-1", notificationIds: ["notification-1"] },
    { userId: "user-1" }
  ]);
  await assert.rejects(service.markWalletNotificationRead(principal, " "), /notificationId is required/);
});

test("ledger statement reads only the caller's own spot account and validates the query", async () => {
  const statementCalls: Array<{ accountId: string; query: GatewayAccountStatementQuery }> = [];
  const service = createService({
    ledgerClient: {
      async listBalances(query) {
        assert.equal(query.userId, "user-1");
        return {
          items: [{ accountId: "spot-of-user-1", assetCode: "USDT" }],
          total: 1,
          limit: 1,
          offset: 0
        };
      },
      async getAccountStatement(accountId, query) {
        statementCalls.push({ accountId, query });
        return { accountId, items: [], total: 0, limit: query.limit ?? 50, offset: 0, balanceDerivable: {} };
      }
    }
  });

  await service.getLedgerStatement(principal, {
    assetCode: "USDT",
    category: "withdrawal",
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-04-01T00:00:00.000Z",
    limit: 5000,
    offset: -3
  });
  assert.equal(statementCalls.length, 1);
  assert.equal(statementCalls[0]?.accountId, "spot-of-user-1");
  assert.equal(statementCalls[0]?.query.limit, 200, "limit is clamped");
  assert.equal(statementCalls[0]?.query.offset, 0, "offset is clamped");
  assert.equal(statementCalls[0]?.query.category, "withdrawal");

  await assert.rejects(
    service.getLedgerStatement(principal, { category: "everything" as never }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400
  );
  await assert.rejects(
    service.getLedgerStatement(principal, { from: "yesterday" }),
    /from must be an ISO-8601 timestamp/
  );
  assert.equal(statementCalls.length, 1, "invalid queries never reach the ledger");
});
