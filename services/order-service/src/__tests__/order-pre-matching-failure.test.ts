import assert from "node:assert/strict";
import test from "node:test";

import {
  ORDER_FREEZE_FAILED,
  OrderApplicationService
} from "../application/order-application-service.js";
import type { LedgerOrderClient, MatchingEngineClient } from "../domain/clients.js";
import { OrderServiceError } from "../domain/errors.js";
import { InMemoryOrderRepository } from "../infrastructure/in-memory-order-repository.js";

function createHarness(input: {
  freezeBalance: LedgerOrderClient["freezeBalance"];
  releaseBalance?: LedgerOrderClient["releaseBalance"];
  submitOrder?: MatchingEngineClient["submitOrder"];
}) {
  const repository = new InMemoryOrderRepository();
  const events: Array<{ type: string; status: string }> = [];
  const releases: string[] = [];
  const submitted: string[] = [];
  const service = new OrderApplicationService(
    repository,
    {
      async validateSpotOrder() {
        return {
          market: "ETH-USDT",
          baseAsset: "ETH",
          quoteAsset: "USDT",
          lockAssetCode: "USDT",
          lockAmount: "300",
          feeRate: "0.001",
          timeInForce: "gtc"
        };
      }
    },
    {
      freezeBalance: input.freezeBalance,
      async releaseBalance(command) {
        releases.push(command.referenceId);
        return input.releaseBalance ? input.releaseBalance(command) : {};
      }
    },
    {
      async settleTrade() {
        return { settlementId: "settlement-1" };
      }
    },
    {
      async submitOrder(command) {
        submitted.push(command.orderId);
        if (input.submitOrder) {
          return input.submitOrder(command);
        }
        return { outcome: "resting", orderId: command.orderId, trades: [] };
      },
      async seedOrder(command) {
        return { outcome: "seeded", orderId: command.orderId };
      },
      async cancelOrder(command) {
        return { outcome: "cancelled", orderId: command.orderId };
      },
      async resetBook(command) {
        return { outcome: "reset", market: command.market };
      },
      async getBookSnapshot(command) {
        return { market: command.market, bids: [], asks: [] };
      }
    },
    {
      now: () => new Date("2026-03-08T11:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `id-${++counter}`;
      })(),
      eventPublisher: {
        async publish(batch) {
          for (const event of batch) {
            const order = (event.payload as { order?: { status?: string } }).order;
            events.push({ type: event.eventType, status: order?.status ?? "" });
          }
        }
      }
    }
  );

  return { service, repository, events, releases, submitted };
}

const command = {
  userId: "user-1",
  accountId: "acct-1",
  market: "ETH-USDT" as const,
  side: "buy" as const,
  type: "limit" as const,
  timeInForce: "gtc" as const,
  price: "3000",
  quantity: "0.1",
  idempotencyKey: "order:freeze-fail"
};

test("freeze failure rejects the persisted order instead of leaving it pending_risk", async () => {
  const harness = createHarness({
    async freezeBalance() {
      throw new OrderServiceError(
        "LEDGER_UPSTREAM_FAILED",
        400,
        'Ledger service rejected request: {"code":"INSUFFICIENT_AVAILABLE_BALANCE"}'
      );
    },
    async releaseBalance() {
      throw new OrderServiceError("LEDGER_UPSTREAM_FAILED", 404, "BALANCE_LOCK_NOT_FOUND");
    }
  });

  await assert.rejects(harness.service.createOrder(command), (error: unknown) => {
    assert.ok(error instanceof OrderServiceError);
    assert.equal(error.code, ORDER_FREEZE_FAILED);
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /id-1 rejected: balance freeze failed/);
    assert.match(error.message, /INSUFFICIENT_AVAILABLE_BALANCE/);
    return true;
  });

  const stored = await harness.repository.findOrderById("id-1");
  assert.equal(stored?.status, "rejected");
  assert.equal(stored?.restingQuantity, "0");
  assert.match(stored?.rejectedReason ?? "", /^ORDER_FREEZE_FAILED: /);
  assert.doesNotMatch(stored?.rejectedReason ?? "", /lock release failed/);
  assert.deepEqual(harness.releases, ["id-1"], "a partial freeze is released best-effort");
  assert.deepEqual(harness.submitted, [], "the order never reaches the matching engine");
  assert.deepEqual(harness.events, [{ type: "order.rejected", status: "rejected" }]);

  // Retrying with the same idempotency key returns the terminal order.
  const retried = await harness.service.createOrder(command);
  assert.equal(retried.status, "rejected");
});

test("freeze transport failure maps to 502 and still rejects the order", async () => {
  const harness = createHarness({
    async freezeBalance() {
      throw new TypeError("fetch failed");
    }
  });

  await assert.rejects(harness.service.createOrder(command), (error: unknown) => {
    assert.ok(error instanceof OrderServiceError);
    assert.equal(error.code, ORDER_FREEZE_FAILED);
    assert.equal(error.statusCode, 502);
    return true;
  });

  const stored = await harness.repository.findOrderById("id-1");
  assert.equal(stored?.status, "rejected");
  assert.equal(stored?.rejectedReason, "ORDER_FREEZE_FAILED: fetch failed");
  assert.deepEqual(harness.releases, ["id-1"]);
});

test("engine failure with a failing release still ends in rejected and notes the leftover lock", async () => {
  const harness = createHarness({
    async freezeBalance() {
      return {};
    },
    async releaseBalance() {
      throw new Error("ledger unavailable");
    },
    async submitOrder() {
      throw new Error("matching engine timeout");
    }
  });

  await assert.rejects(harness.service.createOrder(command), /matching engine timeout/);

  const stored = await harness.repository.findOrderById("id-1");
  assert.equal(stored?.status, "rejected");
  assert.equal(
    stored?.rejectedReason,
    "matching engine timeout (lock release failed: ledger unavailable)"
  );
  assert.deepEqual(harness.events, [{ type: "order.rejected", status: "rejected" }]);
});
