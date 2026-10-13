import assert from "node:assert/strict";
import test from "node:test";

import { ControlSwitchService } from "../application/control-switch-service.js";
import { MarketStatusService } from "../application/market-status-service.js";
import { RiskApplicationService } from "../application/risk-application-service.js";
import { RiskServiceError } from "../domain/errors.js";
import { InMemoryControlSwitchRepository } from "../infrastructure/in-memory-control-switch-repository.js";

function newSwitches() {
  const repository = new InMemoryControlSwitchRepository();
  return { repository, service: new ControlSwitchService({ repository, cacheMs: 0 }) };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof RiskServiceError && error.code === code);
}

test("switches start off and need a reason to turn on", async () => {
  const { service } = newSwitches();
  const state = await service.getState();
  assert.equal(state.withdrawalsPaused, null);
  assert.equal(state.apiWriteFrozen, null);
  assert.deepEqual(state.assetWithdrawalPauses, []);
  await rejects(service.setSwitch({ scope: "withdrawals_global", enabled: true }), "CONTROL_SWITCH_REASON_REQUIRED");
  await rejects(service.setSwitch({ scope: "bogus" as never, enabled: true, reason: "x" }), "INVALID_CONTROL_SWITCH");
});

test("asset pause validates the asset against config/markets.json", async () => {
  const { service } = newSwitches();
  await rejects(service.setSwitch({ scope: "withdrawals_asset", assetCode: "DOGE", enabled: true, reason: "x" }), "UNSUPPORTED_ASSET");
  const result = await service.setSwitch({ scope: "withdrawals_asset", assetCode: "eth", enabled: true, reason: "hot wallet drift", operator: "ops@x" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.assetWithdrawalPauses.map((entry) => entry.assetCode), ["ETH"]);
  assert.equal(result.state.assetWithdrawalPauses[0]?.updatedBy, "ops@x");
});

test("automatic requests never override or resume a switch", async () => {
  const { service, repository } = newSwitches();
  await service.setSwitch({ scope: "withdrawals_asset", assetCode: "USDT", enabled: true, reason: "manual check", operator: "ops" });
  const automatic = await service.setSwitch({
    scope: "withdrawals_asset",
    assetCode: "USDT",
    enabled: true,
    reason: "reconciliation mismatch",
    source: "automatic"
  });
  assert.equal(automatic.changed, false, "the manual pause is kept");
  assert.equal(automatic.entry?.reason, "manual check");
  await rejects(
    service.setSwitch({ scope: "withdrawals_asset", assetCode: "USDT", enabled: false, source: "automatic" }),
    "CONTROL_SWITCH_MANUAL_RESUME_REQUIRED"
  );

  const resumed = await service.setSwitch({ scope: "withdrawals_asset", assetCode: "USDT", enabled: false, reason: "checked", operator: "ops" });
  assert.equal(resumed.changed, true);
  assert.deepEqual(resumed.state.assetWithdrawalPauses, []);

  const noop = await service.setSwitch({ scope: "withdrawals_asset", assetCode: "USDT", enabled: false, operator: "ops" });
  assert.equal(noop.changed, false, "turning off an inactive switch is a no-op");

  const events = await repository.listEvents(10);
  assert.deepEqual(events.map((event) => event.action), ["disabled", "enabled"], "only real changes are audited");
});

test("API write freeze rejects new orders in risk validation", async () => {
  const { service: switches } = newSwitches();
  const risk = new RiskApplicationService(
    { async getBalance(accountId: string, assetCode: string) { return { accountId, assetCode, available: "1000000", locked: "0" }; } },
    {
      marketStatus: new MarketStatusService({ cacheMs: 0 }),
      controlSwitches: switches,
      referencePriceProvider: { async getReferencePrice() { return null; } }
    }
  );
  const order = {
    userId: "u",
    accountId: "a",
    market: "ETH-USDT",
    side: "buy" as const,
    type: "limit" as const,
    timeInForce: "gtc" as const,
    price: "3000",
    quantity: "0.01"
  };
  assert.equal((await risk.validateSpotOrder(order)).valid, true);
  await switches.setSwitch({ scope: "api_write", enabled: true, reason: "incident drill", operator: "ops" });
  await rejects(risk.validateSpotOrder(order), "API_WRITE_FROZEN");
  // A withdrawal pause does not touch trading.
  await switches.setSwitch({ scope: "api_write", enabled: false, operator: "ops" });
  await switches.setSwitch({ scope: "withdrawals_global", enabled: true, reason: "drill", operator: "ops" });
  assert.equal((await risk.validateSpotOrder(order)).valid, true);
});
