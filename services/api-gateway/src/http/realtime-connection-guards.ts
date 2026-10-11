/**
 * Hardening for the private WebSocket (M5-3):
 * - Origin allow-list: browsers always send Origin, so a page on another site
 *   cannot ride a user's session over WS (cross-site WebSocket hijacking).
 *   Non-browser clients (bots signing with API keys) send no Origin and pass.
 * - Per-connection message rate limit (fixed window).
 * - Session lifetime: see ApiGatewayRealtimeServer (expiry timer + re-introspect).
 */

export const DEFAULT_WS_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3013",
  "http://localhost:3013"
];

export function parseAllowedOrigins(value: string | undefined): string[] | "*" {
  if (value?.trim() === "*") {
    return "*";
  }
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return origins.length > 0 ? origins : DEFAULT_WS_ALLOWED_ORIGINS;
}

export function isOriginAllowed(origin: string | undefined, allowed: string[] | "*"): boolean {
  if (!origin) {
    return true;
  }
  if (allowed === "*") {
    return true;
  }
  return allowed.includes(origin.replace(/\/+$/, ""));
}

export class MessageRateLimiter {
  private windowStartedAt = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** "ok", "limited" (drop this message) or "abuse" (twice the limit: disconnect). */
  hit(now = Date.now()): "ok" | "limited" | "abuse" {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > this.limit * 2) {
      return "abuse";
    }
    return this.count > this.limit ? "limited" : "ok";
  }
}

/** Milliseconds until the principal's session expires, or undefined if it has no expiry. */
export function msUntilExpiry(expiresAt: string | undefined, now = Date.now()): number | undefined {
  if (!expiresAt) {
    return undefined;
  }
  const expiry = new Date(expiresAt).getTime();
  return Number.isFinite(expiry) ? Math.max(0, expiry - now) : undefined;
}

/** Close codes in the 4000-4999 private range so clients can tell why. */
export const WS_CLOSE_SESSION_EXPIRED = 4001;
export const WS_CLOSE_SESSION_REVOKED = 4003;
export const WS_CLOSE_RATE_LIMITED = 4008;
