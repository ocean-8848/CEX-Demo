import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBalances,
  formatReserveRatio,
  normalizeDecimalString,
  verifyProofOfReserves,
  webCryptoSha256Hex,
  type PorVerifyInput
} from "../client/lib/por-verify.js";

// Shared with services/wallet-service/src/__tests__/proof-of-reserves.test.ts:
// the server-side builder produced exactly this root for these three users.
const MERKLE_ROOT = "a285fffe5cd6f90a40d43e9b01f971338b0acbab75c18fc7c118b547b7bd5dda";
const USER_A: PorVerifyInput = {
  userId: "user-a",
  nonce: "n1",
  balances: { USDT: "100.50", ETH: "1" },
  userHash: "56ba88004ff2f38f8ede34ed2e1dd07435be6304f9cc748ae0f22daa11d5afb7",
  leafHash: "421aed4abfca99432240dd25d48b103fa86ef5189b3f0370557eeac6a42226ac",
  proof: [
    { position: "left", hash: "266533cf827bfe2cdc74194173b713be3c9f943cab593be5305ba445f47632b8" },
    { position: "right", hash: "668b0830bdcfe8f4f9603e9b8b6cad62dfcd5ff7b5a6b753c81b5c89ac5eb49f" }
  ],
  merkleRoot: MERKLE_ROOT
};

test("Web Crypto SHA-256 matches the standard test vector", async () => {
  assert.equal(await webCryptoSha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("canonical balances match the server format", () => {
  assert.equal(normalizeDecimalString("25000.000000000000000000"), "25000");
  assert.equal(canonicalBalances({ USDT: "100.50", ETH: "1", BTC: "0.0" }), "ETH=1,USDT=100.5");
});

test("the browser verifier reproduces the server-built root step by step", async () => {
  const result = await verifyProofOfReserves(USER_A);
  assert.equal(result.valid, true);
  assert.equal(result.computedRoot, MERKLE_ROOT);
  assert.deepEqual(
    result.steps.map((step) => step.kind),
    ["user", "leaf", "node", "node", "root"]
  );
  assert.equal(result.steps[0]?.message, "por-user:v1|user-a|n1");
  assert.equal(result.steps[1]?.message, `por-leaf:v1|${USER_A.userHash}|ETH=1,USDT=100.5`);
  assert.ok(result.steps[2]?.message.startsWith(`por-node:v1|${USER_A.proof[0]!.hash}|`), "left sibling goes first");
  assert.ok(result.steps.every((step) => step.ok));
});

test("a changed balance, sibling or root fails verification at the right step", async () => {
  const forgedBalance = await verifyProofOfReserves({ ...USER_A, balances: { USDT: "1000000", ETH: "1" } });
  assert.equal(forgedBalance.valid, false);
  assert.equal(forgedBalance.steps.find((step) => !step.ok)?.kind, "leaf");

  const forgedSibling = await verifyProofOfReserves({
    ...USER_A,
    proof: [USER_A.proof[0]!, { position: "right", hash: "00".repeat(32) }]
  });
  assert.equal(forgedSibling.valid, false);
  assert.equal(forgedSibling.steps.find((step) => !step.ok)?.kind, "root");

  const otherUser = await verifyProofOfReserves({ ...USER_A, userId: "user-b" });
  assert.equal(otherUser.steps[0]?.ok, false, "someone else's id does not produce my user hash");
});

test("the hash function is injectable (pure code path)", async () => {
  const seen: string[] = [];
  const fake = async (message: string) => {
    seen.push(message);
    return "x";
  };
  const result = await verifyProofOfReserves({ ...USER_A, userHash: "x", leafHash: "x", merkleRoot: "x" }, fake);
  assert.equal(result.valid, true);
  assert.equal(seen.length, 4, "user hash + leaf + two levels");
});

test("formatReserveRatio renders percentages", () => {
  assert.equal(formatReserveRatio("1.2345"), "123.45%");
  assert.equal(formatReserveRatio(undefined), "--");
});
