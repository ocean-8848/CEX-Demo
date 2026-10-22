import assert from "node:assert/strict";
import test from "node:test";

import { OpsConsoleError } from "../domain/errors.js";
import { HttpSettlementOpsClient } from "../infrastructure/http-settlement-ops-client.js";

test("settlement rejections keep the upstream status and business code", async (t) => {
  process.env.INTERNAL_SERVICE_AUTH_SECRET ??= "test-secret";
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: "SETTLEMENT_EVENT_SUBSCRIBER_PAUSED",
        message: "Trade event consumer is paused by the fault lab; resume it first"
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const client = new HttpSettlementOpsClient("http://settlement.test");
  await assert.rejects(
    () => client.processTradeEventSubscriptionCycle({ market: "ETH-USDT" }),
    (error: unknown) => {
      assert.ok(error instanceof OpsConsoleError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "SETTLEMENT_EVENT_SUBSCRIBER_PAUSED");
      assert.equal(
        error.message,
        "Settlement service rejected request: Trade event consumer is paused by the fault lab; resume it first"
      );
      return true;
    }
  );
});

test("non-JSON settlement failures fall back to a generic upstream code", async (t) => {
  process.env.INTERNAL_SERVICE_AUTH_SECRET ??= "test-secret";
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;

  const client = new HttpSettlementOpsClient("http://settlement.test");
  await assert.rejects(
    () => client.processTradeEventSubscriptionCycle({}),
    (error: unknown) => {
      assert.ok(error instanceof OpsConsoleError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "SETTLEMENT_UPSTREAM_FAILED");
      return true;
    }
  );
});
