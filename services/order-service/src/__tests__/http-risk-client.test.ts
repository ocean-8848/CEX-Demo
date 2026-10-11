import assert from "node:assert/strict";
import test from "node:test";

import { OrderServiceError } from "../domain/errors.js";
import { HttpRiskClient } from "../infrastructure/http-risk-client.js";

const command = {
  userId: "user-1",
  accountId: "acct-1",
  market: "SOL-USDT",
  side: "buy" as const,
  type: "limit" as const,
  timeInForce: "gtc" as const,
  price: "150",
  quantity: "1"
};

async function withFetch(response: Response, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
  process.env.INTERNAL_SERVICE_AUTH_SECRET = "test-secret";
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) {
      delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
    } else {
      process.env.INTERNAL_SERVICE_AUTH_SECRET = originalSecret;
    }
  }
}

test("risk business rejections keep their code (MARKET_HALTED) and status", async () => {
  const body = JSON.stringify({ code: "MARKET_HALTED", message: "Market SOL-USDT is halted: maintenance" });
  await withFetch(new Response(body, { status: 409 }), async () => {
    await assert.rejects(new HttpRiskClient("http://risk").validateSpotOrder(command), (error: unknown) => {
      assert.ok(error instanceof OrderServiceError);
      assert.equal(error.code, "MARKET_HALTED");
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /is halted: maintenance/);
      return true;
    });
  });
});

test("risk transport failures stay RISK_UPSTREAM_FAILED", async () => {
  await withFetch(new Response("boom", { status: 502 }), async () => {
    await assert.rejects(
      new HttpRiskClient("http://risk").validateSpotOrder(command),
      (error: unknown) => error instanceof OrderServiceError && error.code === "RISK_UPSTREAM_FAILED"
    );
  });
});
