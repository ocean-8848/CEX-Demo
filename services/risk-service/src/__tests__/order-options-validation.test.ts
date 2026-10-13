import assert from "node:assert/strict";
import test from "node:test";

import { RiskApplicationService } from "../application/risk-application-service.js";
import { RiskServiceError } from "../domain/errors.js";
import type { ValidateSpotOrderRiskCommand } from "../domain/types.js";

function service() {
  return new RiskApplicationService(
    {
      async getBalance(accountId, assetCode) {
        return { accountId, assetCode, available: "1000000", locked: "0" };
      }
    },
    { referencePrices: { "ETH-USDT": "3200" } }
  );
}

const base: ValidateSpotOrderRiskCommand = {
  userId: "user-1",
  accountId: "acct-1",
  market: "ETH-USDT",
  side: "buy",
  type: "limit",
  price: "3200",
  quantity: "1"
};

async function rejectsWith(command: Partial<ValidateSpotOrderRiskCommand>, code: string) {
  await assert.rejects(
    () => service().validateSpotOrder({ ...base, ...command }),
    (error: unknown) => error instanceof RiskServiceError && error.code === code,
    code
  );
}

test("post-only is accepted only on GTC limit orders", async () => {
  const ok = await service().validateSpotOrder({ ...base, postOnly: true });
  assert.equal(ok.timeInForce, "gtc");
  await rejectsWith({ postOnly: true, timeInForce: "ioc" }, "POST_ONLY_REQUIRES_GTC_LIMIT");
  await rejectsWith({ postOnly: true, type: "market", price: undefined }, "POST_ONLY_REQUIRES_GTC_LIMIT");
});

test("stpMode must be one of the supported modes", async () => {
  for (const stpMode of ["expire_taker", "expire_maker", "expire_both"] as const) {
    await service().validateSpotOrder({ ...base, stpMode });
  }
  await rejectsWith({ stpMode: "cancel_all" as never }, "INVALID_STP_MODE");
});

test("stop orders require an aligned trigger price inside the deviation band", async () => {
  await rejectsWith({ type: "stop_limit", price: "3300" }, "TRIGGER_PRICE_REQUIRED");
  await rejectsWith({ type: "stop_limit", price: "3300", triggerPrice: "0" }, "INVALID_TRIGGER_PRICE");
  await rejectsWith({ type: "stop_limit", price: "3300", triggerPrice: "3250.001" }, "INVALID_STEP_ALIGNMENT");
  // Reference 3200, band 20%: 4000 is 25% away.
  await rejectsWith({ type: "stop_limit", price: "4000", triggerPrice: "4000" }, "TRIGGER_PRICE_DEVIATION_TOO_HIGH");
  // Limit price is bounded against the trigger.
  await rejectsWith({ type: "stop_limit", price: "2000", triggerPrice: "3250" }, "PRICE_DEVIATION_TOO_HIGH");
  await rejectsWith({ type: "limit", triggerPrice: "3250" }, "TRIGGER_PRICE_NOT_ALLOWED");
  await rejectsWith({ type: "stop_market", price: undefined, triggerPrice: "3250", timeInForce: "gtc" }, "UNSUPPORTED_TIME_IN_FORCE");
  await rejectsWith({ type: "stop_loss" as never }, "UNSUPPORTED_ORDER_TYPE");
});

test("stop orders lock funds like the order they become", async () => {
  const stopLimit = await service().validateSpotOrder({
    ...base,
    type: "stop_limit",
    price: "3300",
    triggerPrice: "3250"
  });
  assert.equal(stopLimit.timeInForce, "gtc");
  assert.equal(stopLimit.lockAmount, "3300");
  assert.equal(stopLimit.triggerPrice, "3250");

  // stop_market buy: trigger * quantity * (1 + max deviation).
  const stopMarket = await service().validateSpotOrder({
    ...base,
    type: "stop_market",
    price: undefined,
    triggerPrice: "3250"
  });
  assert.equal(stopMarket.timeInForce, "ioc");
  assert.equal(stopMarket.lockAmount, "3900");

  const stopSell = await service().validateSpotOrder({
    ...base,
    side: "sell",
    type: "stop_market",
    price: undefined,
    triggerPrice: "3000"
  });
  assert.equal(stopSell.lockAssetCode, "ETH");
  assert.equal(stopSell.lockAmount, "1");
});
