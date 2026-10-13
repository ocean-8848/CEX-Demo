import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildMerkleLevels,
  buildMerkleProof,
  buildProofOfReservesTree,
  canonicalBalances,
  computeRootFromProof,
  leafMessage,
  merkleRoot,
  normalizeDecimalString,
  userHashMessage,
  verifyMerkleProof
} from "../domain/proof-of-reserves.js";

const sha256 = (message: string) => createHash("sha256").update(message, "utf8").digest("hex");

/**
 * Shared test vector: apps/trader-web/src/__tests__/por-verify.test.ts pins
 * the browser verifier to the same root. Change both together.
 */
const POR_TEST_VECTOR = {
  users: [
    { userId: "user-a", nonce: "n1", balances: { USDT: "100.50", ETH: "1" } },
    { userId: "user-b", nonce: "n2", balances: { BTC: "0.1" } },
    { userId: "user-c", nonce: "n3", balances: { USDT: "7" } }
  ],
  merkleRoot: "a285fffe5cd6f90a40d43e9b01f971338b0acbab75c18fc7c118b547b7bd5dda",
  userA: {
    userHash: "56ba88004ff2f38f8ede34ed2e1dd07435be6304f9cc748ae0f22daa11d5afb7",
    leafHash: "421aed4abfca99432240dd25d48b103fa86ef5189b3f0370557eeac6a42226ac",
    proof: [
      { position: "left", hash: "266533cf827bfe2cdc74194173b713be3c9f943cab593be5305ba445f47632b8" },
      { position: "right", hash: "668b0830bdcfe8f4f9603e9b8b6cad62dfcd5ff7b5a6b753c81b5c89ac5eb49f" }
    ]
  }
} as const;

test("normalizeDecimalString strips padding zeros", () => {
  assert.equal(normalizeDecimalString("100.500"), "100.5");
  assert.equal(normalizeDecimalString("2.000000000000000000"), "2");
  assert.equal(normalizeDecimalString("007.10"), "7.1");
  assert.equal(normalizeDecimalString("0.0"), "0");
  assert.throws(() => normalizeDecimalString("1e5"));
});

test("canonicalBalances sorts assets, normalizes amounts and drops zeros", () => {
  assert.equal(canonicalBalances({ USDT: "25000.000", ETH: "1.50", BTC: "0" }), "ETH=1.5,USDT=25000");
  assert.equal(canonicalBalances({}), "");
});

test("the tree matches the shared test vector", () => {
  const tree = buildProofOfReservesTree(
    POR_TEST_VECTOR.users.map((user) => ({ ...user, balances: { ...user.balances } })),
    sha256
  );
  assert.equal(tree.merkleRoot, POR_TEST_VECTOR.merkleRoot);
  assert.equal(tree.treeDepth, 2);
  const userA = tree.leaves.find((leaf) => leaf.userId === "user-a");
  assert.ok(userA);
  assert.equal(userA.userHash, sha256(userHashMessage("user-a", "n1")));
  assert.equal(userA.userHash, POR_TEST_VECTOR.userA.userHash);
  assert.equal(userA.leafHash, sha256(leafMessage(userA.userHash, { ETH: "1", USDT: "100.5" })));
  assert.equal(userA.leafHash, POR_TEST_VECTOR.userA.leafHash);
  assert.deepEqual(userA.proof, POR_TEST_VECTOR.userA.proof);
  assert.deepEqual(userA.canonical, { ETH: "1", USDT: "100.5" });
});

test("every leaf of trees with 1..9 leaves verifies against the root", () => {
  for (let size = 1; size <= 9; size += 1) {
    const leaves = Array.from({ length: size }, (_, index) => sha256(`leaf-${index}`));
    const levels = buildMerkleLevels(leaves, sha256);
    const root = merkleRoot(levels);
    assert.equal(levels.length - 1, Math.ceil(Math.log2(size)), `depth for ${size} leaves`);
    leaves.forEach((leaf, index) => {
      const proof = buildMerkleProof(levels, index);
      assert.equal(proof.length, levels.length - 1);
      assert.ok(verifyMerkleProof({ leafHash: leaf, proof, merkleRoot: root, hash: sha256 }), `leaf ${index}/${size}`);
    });
  }
});

test("a single leaf is its own root and an empty tree has a fixed root", () => {
  const levels = buildMerkleLevels(["abc"], sha256);
  assert.equal(merkleRoot(levels), "abc");
  assert.deepEqual(buildMerkleProof(levels, 0), []);
  assert.equal(merkleRoot(buildMerkleLevels([], sha256)), sha256("por-empty:v1"));
});

test("tampering with a balance, the proof or the order breaks verification", () => {
  const tree = buildProofOfReservesTree(
    POR_TEST_VECTOR.users.map((user) => ({ ...user, balances: { ...user.balances } })),
    sha256
  );
  const leaf = tree.leaves[1]!;
  const forgedLeaf = sha256(leafMessage(leaf.userHash, { ...leaf.canonical, USDT: "1000000" }));
  assert.equal(verifyMerkleProof({ leafHash: forgedLeaf, proof: leaf.proof, merkleRoot: tree.merkleRoot, hash: sha256 }), false);

  const flipped = leaf.proof.map((step, index) =>
    index === 0 ? { ...step, position: step.position === "left" ? ("right" as const) : ("left" as const) } : step
  );
  assert.notEqual(computeRootFromProof(leaf.leafHash, flipped, sha256), tree.merkleRoot);

  const forgedSibling = leaf.proof.map((step, index) => (index === 1 ? { ...step, hash: sha256("evil") } : step));
  assert.equal(
    verifyMerkleProof({ leafHash: leaf.leafHash, proof: forgedSibling, merkleRoot: tree.merkleRoot, hash: sha256 }),
    false
  );
});

test("leaves are ordered by the salted user hash, not by user id", () => {
  const tree = buildProofOfReservesTree(
    POR_TEST_VECTOR.users.map((user) => ({ ...user, balances: { ...user.balances } })),
    sha256
  );
  const hashes = tree.leaves.map((leaf) => leaf.userHash);
  assert.deepEqual(hashes, [...hashes].sort());
  assert.deepEqual(
    tree.leaves.map((leaf) => leaf.leafIndex),
    [0, 1, 2]
  );
});
