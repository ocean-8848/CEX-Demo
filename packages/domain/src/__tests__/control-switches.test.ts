import assert from "node:assert/strict";
import test from "node:test";

import {
  CachedControlSwitchReader,
  buildControlSwitchState,
  emptyControlSwitchState,
  evaluateApiWriteGate,
  evaluateWithdrawalGate,
  normalizeControlSwitchState,
  type ControlSwitchEntry
} from "../index.js";

const at = "2026-01-01T00:00:00.000Z";

function entry(partial: Partial<ControlSwitchEntry> & Pick<ControlSwitchEntry, "scope">): ControlSwitchEntry {
  return { reason: "test", source: "manual", updatedBy: "ops", updatedAt: at, ...partial };
}

test("no switch active: every gate is open", () => {
  const state = emptyControlSwitchState(at);
  assert.equal(evaluateWithdrawalGate(state, "USDT"), null);
  assert.equal(evaluateApiWriteGate(state), null);
});

test("global withdrawal pause wins over asset pauses", () => {
  const state = buildControlSwitchState([
    entry({ scope: "withdrawals_asset", assetCode: "ETH" }),
    entry({ scope: "withdrawals_global", reason: "incident" })
  ]);
  assert.equal(evaluateWithdrawalGate(state, "ETH")?.code, "WITHDRAWALS_PAUSED");
  assert.equal(evaluateWithdrawalGate(state, "USDT")?.code, "WITHDRAWALS_PAUSED");
  assert.match(evaluateWithdrawalGate(state, "USDT")?.message ?? "", /incident/);
});

test("asset pause only blocks that asset (case-insensitive)", () => {
  const state = buildControlSwitchState([entry({ scope: "withdrawals_asset", assetCode: "ETH", source: "automatic" })]);
  const rejection = evaluateWithdrawalGate(state, "eth");
  assert.equal(rejection?.code, "ASSET_WITHDRAWALS_PAUSED");
  assert.equal(rejection?.entry.source, "automatic");
  assert.equal(evaluateWithdrawalGate(state, "USDT"), null);
  assert.equal(evaluateApiWriteGate(state), null, "a withdrawal pause does not freeze trading");
});

test("API write freeze is independent of withdrawal switches", () => {
  const state = buildControlSwitchState([entry({ scope: "api_write" })]);
  assert.equal(evaluateApiWriteGate(state)?.code, "API_WRITE_FROZEN");
  assert.equal(evaluateWithdrawalGate(state, "USDT"), null);
});

test("normalizeControlSwitchState drops malformed entries", () => {
  const state = normalizeControlSwitchState({
    withdrawalsPaused: { scope: "bogus" },
    assetWithdrawalPauses: [{ scope: "withdrawals_asset" }, { scope: "withdrawals_asset", assetCode: "BTC" }],
    apiWriteFrozen: null
  });
  assert.equal(state.withdrawalsPaused, null);
  assert.deepEqual(state.assetWithdrawalPauses.map((item) => item.assetCode), ["BTC"]);
});

test("cached reader: caches, keeps last known state on failure, fails open before first load", async () => {
  let now = 0;
  let calls = 0;
  let fail = true;
  const errors: unknown[] = [];
  const reader = new CachedControlSwitchReader(
    async () => {
      calls += 1;
      if (fail) {
        throw new Error("risk down");
      }
      return buildControlSwitchState([entry({ scope: "api_write" })]);
    },
    { cacheMs: 2000, nowMs: () => now, onError: (error) => errors.push(error) }
  );

  assert.equal((await reader.getState()).apiWriteFrozen, null, "fails open without a known state");
  assert.equal(errors.length, 1);

  fail = false;
  now += 1001;
  assert.ok((await reader.getState()).apiWriteFrozen, "loads once risk is back");
  const callsAfterLoad = calls;
  now += 500;
  await reader.getState();
  assert.equal(calls, callsAfterLoad, "served from cache");

  fail = true;
  now += 5000;
  assert.ok((await reader.getState()).apiWriteFrozen, "keeps the last known state on failure");
});
