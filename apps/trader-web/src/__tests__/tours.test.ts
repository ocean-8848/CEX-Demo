import assert from "node:assert/strict";
import test from "node:test";

import { TOURS, baselineOf, currentStepIndex, type TourSnapshot } from "../client/lib/tours.js";

const empty: TourSnapshot = { loggedIn: false, page: "home", orders: [], trades: [], deposits: [], withdrawals: [] };
const tour = (id: string) => TOURS.find((item) => item.id === id)!;
const START = new Date("2026-10-10T12:00:00.000Z");
const before = "2026-10-10T11:00:00.000Z";
const after = "2026-10-10T12:01:00.000Z";
const baseline = baselineOf(START);

test("there are four guided scenarios with at least four steps each", () => {
  assert.deepEqual(TOURS.map((item) => item.id), ["first-trade", "deposit", "withdrawal", "settlement-incident"]);
  for (const definition of TOURS) {
    assert.ok(definition.steps.length >= 4, definition.id);
  }
});

test("first trade advances on login, page, a new order, a new fill and settlement", () => {
  const definition = tour("first-trade");
  // History that loads after login (the tour may be started logged out) must not count.
  const old = {
    ...empty,
    loggedIn: true,
    trades: [{ tradeId: "old", settlementId: "s0", executedAt: before }],
    orders: [{ orderId: "o0", createdAt: before }]
  };
  const at = (snapshot: TourSnapshot) => currentStepIndex(definition, { snapshot, baseline }, [], 0);

  assert.equal(at(empty), 0);
  assert.equal(at(old), 1, "existing activity does not count");
  assert.equal(at({ ...old, page: "trade" }), 2);
  const ordered = { ...old, page: "trade", orders: [...old.orders, { orderId: "o1", createdAt: after }] };
  assert.equal(at(ordered), 3);
  const filled = { ...ordered, trades: [...old.trades, { tradeId: "t1", executedAt: after }] };
  assert.equal(at(filled), 4);
  assert.equal(at({ ...filled, trades: [...old.trades, { tradeId: "t1", executedAt: after, settlementId: "s1" }] }), 5);
});

test("reached steps do not rewind and manual steps need confirmation", () => {
  const definition = tour("settlement-incident");
  const snapshot = { ...empty, loggedIn: true, page: "trade" };
  assert.equal(currentStepIndex(definition, { snapshot, baseline }, [], 0), 1);
  assert.equal(currentStepIndex(definition, { snapshot, baseline }, ["pause"], 0), 2);
  assert.equal(currentStepIndex(tour("first-trade"), { snapshot: { ...snapshot, page: "home" }, baseline }, [], 2), 2);
});

test("withdrawal scenario waits for an operator approval of a new withdrawal", () => {
  const definition = tour("withdrawal");
  const old = [{ withdrawalId: "w0", status: "confirmed", requestedAt: before }];
  const at = (withdrawals: TourSnapshot["withdrawals"]) =>
    currentStepIndex(definition, { snapshot: { ...empty, loggedIn: true, page: "assets", withdrawals }, baseline }, [], 0);
  assert.equal(at(old), 2, "an old confirmed withdrawal does not finish the tour");
  assert.equal(at([...old, { withdrawalId: "w1", status: "requested", requestedAt: after }]), 3);
  assert.equal(at([...old, { withdrawalId: "w1", status: "broadcasted", requestedAt: after }]), 4);
  assert.equal(at([...old, { withdrawalId: "w1", status: "confirmed", requestedAt: after }]), 5);
});
