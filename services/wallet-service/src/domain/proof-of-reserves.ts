import type { AssetCode } from "@web3-cex/domain";

import type { ProofStep } from "./treasury-types.js";

/**
 * Proof-of-reserves Merkle tree (pure, hash function injected).
 *
 * Every string below is hashed as UTF-8 with SHA-256 and written as lowercase
 * hex. The browser verifier in apps/trader-web/src/client/lib/por-verify.ts
 * implements the same format with Web Crypto; both are pinned to the shared
 * test vector in src/__tests__/proof-of-reserves.test.ts.
 *
 *   userHash = H("por-user:v1|" + userId + "|" + nonce)
 *   leaf     = H("por-leaf:v1|" + userHash + "|" + "ETH=1.5,USDT=25000")
 *   node     = H("por-node:v1|" + left + "|" + right)
 *
 * - The per-user random nonce salts the user id, so published leaves cannot
 *   be linked to users (and a user id cannot be brute-forced from a leaf).
 * - Balances are sorted by asset and use normalized decimals (no trailing zeros).
 * - Different prefixes for leaves and nodes stop an inner node from being
 *   passed off as a leaf (second-preimage attack).
 * - A level with an odd number of nodes pairs its last node with itself.
 */
export type HashHex = (message: string) => string;

export const POR_HASH_ALGORITHM = "SHA-256";
export const POR_USER_PREFIX = "por-user:v1";
export const POR_LEAF_PREFIX = "por-leaf:v1";
export const POR_NODE_PREFIX = "por-node:v1";
export const POR_EMPTY_MESSAGE = "por-empty:v1";

/** "1.500" -> "1.5", "2.0" -> "2", "-0" -> "0". */
export function normalizeDecimalString(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const [rawWhole = "0", rawFraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

export function canonicalBalances(balances: Record<AssetCode, string>): string {
  return Object.entries(balances)
    .map(([asset, amount]) => [asset, normalizeDecimalString(amount)] as const)
    .filter(([, amount]) => amount !== "0")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([asset, amount]) => `${asset}=${amount}`)
    .join(",");
}

export function userHashMessage(userId: string, nonce: string): string {
  return `${POR_USER_PREFIX}|${userId}|${nonce}`;
}

export function leafMessage(userHash: string, balances: Record<AssetCode, string>): string {
  return `${POR_LEAF_PREFIX}|${userHash}|${canonicalBalances(balances)}`;
}

export function nodeMessage(left: string, right: string): string {
  return `${POR_NODE_PREFIX}|${left}|${right}`;
}

/** levels[0] are the leaves, the last level holds the root. */
export function buildMerkleLevels(leafHashes: string[], hash: HashHex): string[][] {
  if (leafHashes.length === 0) {
    return [[hash(POR_EMPTY_MESSAGE)]];
  }
  const levels: string[][] = [[...leafHashes]];
  let current = levels[0] ?? [];
  while (current.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index] ?? "";
      const right = current[index + 1] ?? left;
      next.push(hash(nodeMessage(left, right)));
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

export function merkleRoot(levels: string[][]): string {
  return levels[levels.length - 1]?.[0] ?? "";
}

/** Sibling hashes from the leaf at `index` up to (not including) the root. */
export function buildMerkleProof(levels: string[][], index: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let position = index;
  for (let depth = 0; depth < levels.length - 1; depth += 1) {
    const level = levels[depth] ?? [];
    const isRight = position % 2 === 1;
    const siblingIndex = isRight ? position - 1 : position + 1;
    const sibling = level[siblingIndex] ?? level[position] ?? "";
    proof.push({ position: isRight ? "left" : "right", hash: sibling });
    position = Math.floor(position / 2);
  }
  return proof;
}

export function computeRootFromProof(leafHash: string, proof: ProofStep[], hash: HashHex): string {
  return proof.reduce(
    (current, step) => (step.position === "left" ? hash(nodeMessage(step.hash, current)) : hash(nodeMessage(current, step.hash))),
    leafHash
  );
}

export function verifyMerkleProof(input: {
  leafHash: string;
  proof: ProofStep[];
  merkleRoot: string;
  hash: HashHex;
}): boolean {
  return computeRootFromProof(input.leafHash, input.proof, input.hash) === input.merkleRoot;
}

export interface PorLeafInput {
  userId: string;
  nonce: string;
  balances: Record<AssetCode, string>;
}

export interface BuiltPorLeaf extends PorLeafInput {
  userHash: string;
  leafHash: string;
  leafIndex: number;
  proof: ProofStep[];
  /** Canonical, normalized balances that were hashed. */
  canonical: Record<AssetCode, string>;
}

export interface BuiltPorTree {
  merkleRoot: string;
  treeDepth: number;
  leaves: BuiltPorLeaf[];
}

/**
 * Builds the whole tree. Leaves are ordered by userHash - random per
 * snapshot - so a leaf's position does not reveal anything about the user.
 */
export function buildProofOfReservesTree(inputs: PorLeafInput[], hash: HashHex): BuiltPorTree {
  const prepared = inputs
    .map((input) => {
      const canonical = Object.fromEntries(
        canonicalBalances(input.balances)
          .split(",")
          .filter(Boolean)
          .map((pair) => pair.split("=") as [string, string])
      ) as Record<AssetCode, string>;
      const userHash = hash(userHashMessage(input.userId, input.nonce));
      return { ...input, canonical, userHash, leafHash: hash(leafMessage(userHash, canonical)) };
    })
    .sort((left, right) => (left.userHash < right.userHash ? -1 : left.userHash > right.userHash ? 1 : 0));

  const levels = buildMerkleLevels(
    prepared.map((leaf) => leaf.leafHash),
    hash
  );
  return {
    merkleRoot: merkleRoot(levels),
    treeDepth: levels.length - 1,
    leaves: prepared.map((leaf, leafIndex) => ({ ...leaf, leafIndex, proof: buildMerkleProof(levels, leafIndex) }))
  };
}
