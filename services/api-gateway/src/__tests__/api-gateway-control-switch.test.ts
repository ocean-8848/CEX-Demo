import assert from "node:assert/strict";
import test from "node:test";

import { buildControlSwitchState, type ControlSwitchEntry } from "@web3-cex/domain";

import { evaluateControlledWrite } from "../http/api-gateway-control-switch.guard.js";

const entry = (partial: Partial<ControlSwitchEntry> & Pick<ControlSwitchEntry, "scope">): ControlSwitchEntry => ({
  reason: "drill",
  source: "manual",
  updatedBy: "ops",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...partial
});

test("orders are only blocked by the API write freeze", () => {
  const paused = buildControlSwitchState([entry({ scope: "withdrawals_global" })]);
  assert.equal(evaluateControlledWrite(paused, "spot_order", undefined), null);
  const frozen = buildControlSwitchState([entry({ scope: "api_write" })]);
  assert.equal(evaluateControlledWrite(frozen, "spot_order", undefined)?.code, "API_WRITE_FROZEN");
});

test("withdrawals: global pause, then asset pause, then API write freeze", () => {
  const assetOnly = buildControlSwitchState([entry({ scope: "withdrawals_asset", assetCode: "USDT" })]);
  assert.equal(evaluateControlledWrite(assetOnly, "withdrawal", "USDT")?.code, "ASSET_WITHDRAWALS_PAUSED");
  assert.equal(evaluateControlledWrite(assetOnly, "withdrawal", "ETH"), null);

  const all = buildControlSwitchState([
    entry({ scope: "withdrawals_asset", assetCode: "USDT" }),
    entry({ scope: "withdrawals_global" }),
    entry({ scope: "api_write" })
  ]);
  assert.equal(evaluateControlledWrite(all, "withdrawal", "USDT")?.code, "WITHDRAWALS_PAUSED");
  assert.equal(evaluateControlledWrite(all, "withdrawal", undefined)?.code, "WITHDRAWALS_PAUSED");

  const frozen = buildControlSwitchState([entry({ scope: "api_write" })]);
  assert.equal(evaluateControlledWrite(frozen, "withdrawal", "ETH")?.code, "API_WRITE_FROZEN");
});
