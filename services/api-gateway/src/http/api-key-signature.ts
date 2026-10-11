import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical request signed by API key clients:
 *
 *   METHOD \n URL(path+query) \n TIMESTAMP(ms) \n NONCE \n SHA256(body)
 *
 * The gateway rebuilds this string from the raw request and forwards it to
 * identity, which owns the secret and recomputes the HMAC.
 */
export function buildApiKeyCanonicalRequest(input: {
  method: string;
  url: string;
  timestamp: string;
  nonce: string;
  rawBody?: Buffer | string;
}): string {
  return [
    input.method.toUpperCase(),
    input.url,
    input.timestamp,
    input.nonce,
    hashRawBody(input.rawBody)
  ].join("\n");
}

/** Client-side helper (scripts, docs, tests). The gateway never sees the secret. */
export function createApiKeySignature(input: {
  secret: string;
  method: string;
  url: string;
  timestamp: string;
  nonce: string;
  rawBody?: Buffer | string;
}): string {
  return createHmac("sha256", input.secret)
    .update(buildApiKeyCanonicalRequest(input))
    .digest("hex");
}

export function verifyApiKeySignature(input: {
  secret: string;
  method: string;
  url: string;
  timestamp: string;
  nonce: string;
  rawBody?: Buffer | string;
  signature: string;
}): boolean {
  const expected = createApiKeySignature(input);
  const received = input.signature.trim().toLowerCase();

  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function hashRawBody(rawBody?: Buffer | string): string {
  const bodyBuffer =
    rawBody === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody);

  return createHash("sha256").update(bodyBuffer).digest("hex");
}
