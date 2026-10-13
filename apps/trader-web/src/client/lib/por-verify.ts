// Proof-of-reserves inclusion check that runs entirely in the browser.
//
// Pure functions with the SHA-256 implementation injected (Web Crypto by
// default), so src/__tests__/por-verify.test.ts runs the exact same code path
// under Node. The hashing format must match the builder in
// services/wallet-service/src/domain/proof-of-reserves.ts; both are pinned to
// one shared test vector.
//
//   userHash = SHA-256("por-user:v1|" + userId + "|" + nonce)
//   leaf     = SHA-256("por-leaf:v1|" + userHash + "|" + "ETH=1.5,USDT=25000")
//   node     = SHA-256("por-node:v1|" + left + "|" + right)

export type Sha256Hex = (message: string) => Promise<string>;

export interface PorProofStep {
  /** Where the sibling sits in the pair. */
  position: "left" | "right";
  hash: string;
}

export interface PorVerifyInput {
  userId: string;
  nonce: string;
  balances: Record<string, string>;
  /** Values published by the exchange, checked against what we compute. */
  userHash: string;
  leafHash: string;
  proof: PorProofStep[];
  merkleRoot: string;
}

export interface PorVerifyStep {
  kind: "user" | "leaf" | "node" | "root";
  title: string;
  /** Exact string that was hashed (empty for the root comparison). */
  message: string;
  /** Result of this step. */
  hash: string;
  /** What the exchange published for this step, when there is something to compare. */
  expected?: string;
  ok: boolean;
}

export interface PorVerifyResult {
  valid: boolean;
  computedRoot: string;
  steps: PorVerifyStep[];
}

export async function webCryptoSha256Hex(message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("当前环境不支持 Web Crypto（需要 HTTPS 或 localhost）");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeDecimalString(value: string): string {
  const trimmed = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`无效的金额 ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const [rawWhole = "0", rawFraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

export function canonicalBalances(balances: Record<string, string>): string {
  return Object.entries(balances)
    .map(([asset, amount]) => [asset, normalizeDecimalString(amount)] as const)
    .filter(([, amount]) => amount !== "0")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([asset, amount]) => `${asset}=${amount}`)
    .join(",");
}

export const userHashMessage = (userId: string, nonce: string) => `por-user:v1|${userId}|${nonce}`;
export const leafMessage = (userHash: string, balances: Record<string, string>) =>
  `por-leaf:v1|${userHash}|${canonicalBalances(balances)}`;
export const nodeMessage = (left: string, right: string) => `por-node:v1|${left}|${right}`;

/**
 * Recomputes the user hash, the leaf and every level up to the root, and
 * compares each value with what the exchange published.
 */
export async function verifyProofOfReserves(
  input: PorVerifyInput,
  sha256: Sha256Hex = webCryptoSha256Hex
): Promise<PorVerifyResult> {
  const steps: PorVerifyStep[] = [];

  const userMessage = userHashMessage(input.userId, input.nonce);
  const userHash = await sha256(userMessage);
  steps.push({
    kind: "user",
    title: "用盐值隐藏用户 ID",
    message: userMessage,
    hash: userHash,
    expected: input.userHash,
    ok: userHash === input.userHash
  });

  const leafText = leafMessage(userHash, input.balances);
  let current = await sha256(leafText);
  steps.push({
    kind: "leaf",
    title: "计算我的叶子（盐化 ID + 各币种余额）",
    message: leafText,
    hash: current,
    expected: input.leafHash,
    ok: current === input.leafHash
  });

  for (const [index, step] of input.proof.entries()) {
    const message = step.position === "left" ? nodeMessage(step.hash, current) : nodeMessage(current, step.hash);
    current = await sha256(message);
    steps.push({
      kind: "node",
      title: `第 ${index + 1} 层：与${step.position === "left" ? "左" : "右"}侧兄弟哈希拼接`,
      message,
      hash: current,
      ok: true
    });
  }

  steps.push({
    kind: "root",
    title: "与公布的 Merkle 根比较",
    message: "",
    hash: current,
    expected: input.merkleRoot,
    ok: current === input.merkleRoot
  });

  return { valid: steps.every((step) => step.ok), computedRoot: current, steps };
}

/** "1.2345" -> "123.45%"; undefined -> "--". */
export function formatReserveRatio(ratio: string | undefined): string {
  if (!ratio || !Number.isFinite(Number(ratio))) {
    return "--";
  }
  return `${(Number(ratio) * 100).toFixed(2)}%`;
}
