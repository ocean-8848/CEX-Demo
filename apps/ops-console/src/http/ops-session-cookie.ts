import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser sessions: the BFF keeps the ops session token in an
 * HttpOnly cookie, so page scripts (and any XSS) can never read it. Writes
 * also need a CSRF token (double submit: a readable cookie echoed in the
 * `x-csrf-token` header), on top of SameSite=Strict.
 *
 * Scripts and tests can still log in without the cookie-mode header and use
 * `Authorization: Bearer <token>` as before.
 */

export const OPS_SESSION_COOKIE = "ops_session";
export const OPS_CSRF_COOKIE = "ops_csrf";
export const OPS_CSRF_HEADER = "x-csrf-token";
export const OPS_SESSION_MODE_HEADER = "x-ops-session-mode";

type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeader(headers: HeaderBag, key: string): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function readBearer(headers: HeaderBag): string | undefined {
  const header = firstHeader(headers, "authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

export interface ResolvedOpsCredential {
  token: string;
  source: "bearer" | "cookie";
}

export function resolveOpsCredential(headers: HeaderBag): ResolvedOpsCredential | undefined {
  const bearer = readBearer(headers);
  if (bearer) {
    return { token: bearer, source: "bearer" };
  }
  const cookie = parseCookies(firstHeader(headers, "cookie"))[OPS_SESSION_COOKIE];
  return cookie ? { token: cookie, source: "cookie" } : undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie-authenticated writes must echo the CSRF cookie in a header. */
export function csrfSatisfied(method: string, headers: HeaderBag): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return true;
  }
  const expected = parseCookies(firstHeader(headers, "cookie"))[OPS_CSRF_COOKIE];
  const received = firstHeader(headers, OPS_CSRF_HEADER);
  if (!expected || !received) {
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function wantsCookieSession(headers: HeaderBag): boolean {
  return firstHeader(headers, OPS_SESSION_MODE_HEADER) === "cookie";
}

export function buildSessionCookies(token: string, expiresAt: string | undefined, secure: boolean): string[] {
  const maxAge = expiresAt
    ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : 12 * 3600;
  const suffix = `; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure ? "; Secure" : ""}`;
  const csrf = randomBytes(18).toString("base64url");
  return [
    `${OPS_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly${suffix}`,
    // Readable on purpose: the client copies it into the x-csrf-token header.
    `${OPS_CSRF_COOKIE}=${csrf}${suffix}`
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const suffix = `; Path=/; Max-Age=0; SameSite=Strict${secure ? "; Secure" : ""}`;
  return [`${OPS_SESSION_COOKIE}=; HttpOnly${suffix}`, `${OPS_CSRF_COOKIE}=${suffix}`];
}
