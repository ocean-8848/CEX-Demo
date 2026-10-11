import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LOCAL_INTERNAL_SERVICE_AUTH_SECRET =
  process.env.INTERNAL_SERVICE_AUTH_SECRET ?? "web3-cex-local-internal-auth";

const DEFAULT_CALLER_NAME = process.env.INTERNAL_SERVICE_CALLER_NAME ?? "demo-scripts";
const PROTECTED_INTERNAL_PORTS = new Set(["3001", "3002", "3005", "3008", "3009", "3010"]);

export function maybeBuildInternalServiceHeaders(url, init = {}) {
  if (!isProtectedInternalServiceUrl(url)) {
    return init.headers ?? {};
  }

  const rawBody = init.body;
  const targetUrl = new URL(url);
  const path = `${targetUrl.pathname}${targetUrl.search}`;
  const timestamp = new Date().toISOString();

  return {
    ...(init.headers ?? {}),
    "x-internal-service-name": DEFAULT_CALLER_NAME,
    "x-internal-service-timestamp": timestamp,
    "x-internal-service-signature": createSignature({
      secret: LOCAL_INTERNAL_SERVICE_AUTH_SECRET,
      callerName: DEFAULT_CALLER_NAME,
      method: init.method ?? "GET",
      path,
      timestamp,
      rawBody
    })
  };
}

/**
 * Verifies an HMAC-signed internal request (same canonical format as
 * @web3-cex/domain). Returns `{ ok: true, callerName }` or `{ ok: false, reason }`.
 */
export function verifyInternalServiceRequest({
  method,
  path,
  headers,
  rawBody,
  allowedCallers,
  maxSkewMs = 30_000,
  secret = LOCAL_INTERNAL_SERVICE_AUTH_SECRET
}) {
  const callerName = readHeader(headers, "x-internal-service-name");
  const timestamp = readHeader(headers, "x-internal-service-timestamp");
  const signature = readHeader(headers, "x-internal-service-signature");
  if (!callerName || !timestamp || !signature) {
    return { ok: false, reason: "Missing internal service authentication headers" };
  }
  if (allowedCallers && !allowedCallers.includes(callerName)) {
    return { ok: false, reason: `Caller ${callerName} is not allowed` };
  }
  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > maxSkewMs) {
    return { ok: false, reason: "Internal service request timestamp is stale" };
  }
  const expected = createSignature({ secret, callerName, method, path, timestamp, rawBody });
  const received = signature.trim().toLowerCase();
  if (
    received.length !== expected.length ||
    !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return { ok: false, reason: "Internal service request signature is invalid" };
  }
  return { ok: true, callerName };
}

function readHeader(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isProtectedInternalServiceUrl(url) {
  try {
    const targetUrl = new URL(url);
    return PROTECTED_INTERNAL_PORTS.has(targetUrl.port);
  } catch {
    return false;
  }
}

function createSignature(input) {
  return createHmac("sha256", input.secret)
    .update(buildCanonicalRequest(input))
    .digest("hex");
}

// Mirrors normalizeInternalServicePath in @web3-cex/domain: a bare trailing "?"
// is dropped by some Node fetch versions, so it is never part of the signature.
function buildCanonicalRequest(input) {
  return [
    input.callerName,
    input.method.toUpperCase(),
    input.path.endsWith("?") ? input.path.slice(0, -1) : input.path,
    input.timestamp,
    hashRequestBody(input.rawBody)
  ].join("\n");
}

function hashRequestBody(rawBody) {
  const bodyBuffer =
    rawBody === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody);

  return createHash("sha256").update(bodyBuffer).digest("hex");
}
