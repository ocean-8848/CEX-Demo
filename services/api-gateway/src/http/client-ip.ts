/**
 * Client address used for rate limiting, idempotency scoping, audit and
 * session records.
 *
 * X-Forwarded-For is client-controlled: anyone can send
 * `X-Forwarded-For: 1.2.3.4` and get a fresh rate-limit bucket per request.
 * It is therefore only honoured when the gateway is explicitly told it sits
 * behind a trusted reverse proxy (GATEWAY_TRUST_PROXY=true); otherwise the TCP
 * peer address of the socket is used.
 */
export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export function isGatewayTrustProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GATEWAY_TRUST_PROXY?.trim().toLowerCase();
  return value === "true" || value === "1";
}

export function resolveClientIp(
  request: ClientIpRequest,
  trustProxy: boolean = isGatewayTrustProxyEnabled()
): string {
  if (trustProxy) {
    const forwarded = parseForwardedFor(request.headers["x-forwarded-for"]);
    if (forwarded) {
      return forwarded;
    }
  }

  return normalizeAddress(request.socket?.remoteAddress ?? request.ip) ?? "0.0.0.0";
}

/** Same rule for code paths that only have the optional header value. */
export function resolveSessionIp(
  request: ClientIpRequest,
  trustProxy: boolean = isGatewayTrustProxyEnabled()
): string | undefined {
  const resolved = resolveClientIp(request, trustProxy);
  return resolved === "0.0.0.0" ? undefined : resolved;
}

function parseForwardedFor(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const [first] = (raw ?? "").split(",");
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** `::ffff:127.0.0.1` (IPv4-mapped IPv6 on a dual-stack socket) → `127.0.0.1`. */
function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
