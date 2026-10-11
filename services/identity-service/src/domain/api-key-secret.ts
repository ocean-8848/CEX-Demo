import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_SCOPES = ["read", "trade", "withdraw"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = ["read", "trade"];

export function normalizeApiKeyScopes(scopes: readonly string[] | undefined): ApiKeyScope[] {
  if (!scopes || scopes.length === 0) {
    return [...DEFAULT_API_KEY_SCOPES];
  }
  const normalized = new Set<ApiKeyScope>();
  for (const scope of scopes) {
    const value = scope.trim().toLowerCase();
    if (!(API_KEY_SCOPES as readonly string[]).includes(value)) {
      throw new Error(`Unknown API key scope ${scope}`);
    }
    normalized.add(value as ApiKeyScope);
  }
  // Every key can at least read the account it acts for.
  normalized.add("read");
  return API_KEY_SCOPES.filter((scope) => normalized.has(scope));
}

/**
 * Encrypts API key secrets at rest. Unlike passwords the secret must be
 * recoverable, because identity recomputes the HMAC the client produced.
 * The demo derives the AES key from an env string; production would use a KMS.
 */
export class ApiKeySecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = createHash("sha256").update(masterKey).digest();
  }

  seal(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  open(sealed: string): string {
    const [iv, tag, ciphertext] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
    if (!iv || !tag || !ciphertext) {
      throw new Error("Malformed API key ciphertext");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export function signCanonicalRequest(secret: string, canonicalRequest: string): string {
  return createHmac("sha256", secret).update(canonicalRequest).digest("hex");
}

export function signatureMatches(secret: string, canonicalRequest: string, signature: string): boolean {
  const expected = Buffer.from(signCanonicalRequest(secret, canonicalRequest));
  const received = Buffer.from(signature.trim().toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}
