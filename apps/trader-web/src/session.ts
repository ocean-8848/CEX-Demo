import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Browser session for trader-web. The Web Host (this BFF) keeps the
 * gateway session token in an HttpOnly cookie and attaches it to proxied
 * gateway requests and the private WebSocket, so the page never holds the
 * token. Cookie-authenticated writes must echo the readable `tw_csrf` cookie
 * in `x-csrf-token` (double submit) on top of SameSite=Strict.
 */

export const SESSION_COOKIE = "tw_session";
export const CSRF_COOKIE = "tw_csrf";
export const CSRF_HEADER = "x-csrf-token";

function first(headers: IncomingHttpHeaders, key: string): string | undefined {
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

export function readSessionToken(headers: IncomingHttpHeaders): string | undefined {
  return parseCookies(first(headers, "cookie"))[SESSION_COOKIE] || undefined;
}

export function hasBearer(headers: IncomingHttpHeaders): boolean {
  return Boolean(first(headers, "authorization")?.startsWith("Bearer "));
}

export function csrfSatisfied(method: string, headers: IncomingHttpHeaders): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    return true;
  }
  const expected = parseCookies(first(headers, "cookie"))[CSRF_COOKIE];
  const received = first(headers, CSRF_HEADER);
  if (!expected || !received) {
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildSessionCookies(token: string, expiresAt: string | undefined, secure: boolean): string[] {
  const maxAge = expiresAt
    ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : 7 * 24 * 3600;
  const suffix = `; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure ? "; Secure" : ""}`;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly${suffix}`,
    `${CSRF_COOKIE}=${randomBytes(18).toString("base64url")}${suffix}`
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const suffix = `; Path=/; Max-Age=0; SameSite=Strict${secure ? "; Secure" : ""}`;
  return [`${SESSION_COOKIE}=; HttpOnly${suffix}`, `${CSRF_COOKIE}=${suffix}`];
}
