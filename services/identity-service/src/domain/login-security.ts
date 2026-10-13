import { createHash } from "node:crypto";

import type { IdentitySessionScope, PagedResult } from "./types.js";

/**
 * Login security: login events, known devices, new-device detection and a
 * temporary lock after repeated failed logins. Pure helpers live here; the
 * LoginSecurityService wires them to storage and notifications.
 */

export type LoginOutcome = "success" | "failure" | "locked";

export interface LoginEventRecord {
  eventId: string;
  /** Unknown emails are still recorded, without a user id. */
  userId?: string;
  email: string;
  scope: IdentitySessionScope;
  deviceId: string;
  deviceLabel: string;
  ipAddress?: string;
  userAgent?: string;
  outcome: LoginOutcome;
  failureCode?: string;
  isNewDevice: boolean;
  sessionId?: string;
  createdAt: string;
}

export interface UserDeviceRecord {
  userId: string;
  deviceId: string;
  deviceLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIpAddress?: string;
  lastUserAgent?: string;
  loginCount: number;
  /** true when the first login from this device was flagged as a new device. */
  flaggedNew: boolean;
  /** Last time the user / ops revoked this device's sessions. */
  revokedAt?: string;
  /** Filled by list queries: sessions still active on this device. */
  activeSessionCount?: number;
}

export interface ListLoginEventsQuery {
  userId: string;
  outcome?: LoginOutcome;
  limit?: number;
  offset?: number;
}

export interface LoginLockPolicy {
  /** Failed attempts (since the last success, inside the window) that trigger a lock; 0 disables. */
  maxFailures: number;
  windowSeconds: number;
  lockSeconds: number;
}

export const DEFAULT_LOGIN_LOCK_POLICY: LoginLockPolicy = {
  maxFailures: 5,
  windowSeconds: 15 * 60,
  lockSeconds: 5 * 60
};

/**
 * Only wrong secrets count towards the lock. A missing 2FA code (step-up
 * prompt) or a TOTP code reused within its window is not a guess.
 */
export const LOCK_COUNTED_FAILURE_CODES = new Set([
  "INVALID_CREDENTIALS",
  "TWO_FACTOR_INVALID_CODE",
  "TWO_FACTOR_RECOVERY_CODE_INVALID"
]);

export interface LoginLockStatus {
  locked: boolean;
  failures: number;
  maxFailures: number;
  remainingSeconds: number;
  until?: string;
}

/** `events` = the user's recent login events (any order). */
export function evaluateLoginLock(
  events: readonly LoginEventRecord[],
  now: Date,
  policy: LoginLockPolicy
): LoginLockStatus {
  const base = { locked: false, failures: 0, maxFailures: policy.maxFailures, remainingSeconds: 0 };
  if (policy.maxFailures <= 0) {
    return base;
  }
  const windowStart = now.getTime() - policy.windowSeconds * 1000;
  const sorted = [...events].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const counted: LoginEventRecord[] = [];
  for (const event of sorted) {
    const at = Date.parse(event.createdAt);
    if (at < windowStart || event.outcome === "success") {
      break;
    }
    if (event.outcome === "failure" && event.failureCode && LOCK_COUNTED_FAILURE_CODES.has(event.failureCode)) {
      counted.push(event);
    }
  }
  if (counted.length < policy.maxFailures) {
    return { ...base, failures: counted.length };
  }
  const untilMs = Date.parse(counted[0]!.createdAt) + policy.lockSeconds * 1000;
  const remainingMs = untilMs - now.getTime();
  return {
    locked: remainingMs > 0,
    failures: counted.length,
    maxFailures: policy.maxFailures,
    remainingSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    until: new Date(untilMs).toISOString()
  };
}

/**
 * trader-web sends a long-lived random device id. Clients that send none
 * (scripts, API tools) get a stable id derived from the user agent, so they
 * show up as one device instead of a new one per login.
 */
export function resolveDeviceId(deviceId: string | undefined, userAgent: string | undefined): string {
  const trimmed = deviceId?.trim();
  if (trimmed && /^[A-Za-z0-9_-]{8,64}$/.test(trimmed)) {
    return trimmed;
  }
  return `ua-${createHash("sha256").update(userAgent?.trim() || "unknown").digest("hex").slice(0, 16)}`;
}

/** Very small user-agent summary for lists ("Chrome · macOS"). */
export function describeUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) {
    return "未知设备";
  }
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : /node|undici/i.test(ua) ? "Node.js 脚本"
    : /curl/i.test(ua) ? "curl"
    : ua.split(/[\s/]/)[0] || "未知客户端";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

export function describeLockError(status: LoginLockStatus): string {
  return (
    `Too many failed login attempts (${status.failures}/${status.maxFailures}); ` +
    `login is temporarily locked, retry in ${status.remainingSeconds}s (remainingSeconds=${status.remainingSeconds}, until ${status.until})`
  );
}

export interface LoginSecurityRepository {
  saveLoginEvent(event: LoginEventRecord): Promise<void>;
  listLoginEvents(query: ListLoginEventsQuery): Promise<PagedResult<LoginEventRecord>>;
  /** The user's events at or after `since`, newest first (for the lock check). */
  listRecentLoginEvents(userId: string, since: string, limit: number): Promise<LoginEventRecord[]>;
  findDevice(userId: string, deviceId: string): Promise<UserDeviceRecord | null>;
  countDevices(userId: string): Promise<number>;
  saveDevice(device: UserDeviceRecord): Promise<void>;
  listDevices(userId: string, now: string): Promise<UserDeviceRecord[]>;
  attachSessionDevice(sessionId: string, deviceId: string): Promise<void>;
  listActiveSessionIdsForDevice(userId: string, deviceId: string, now: string): Promise<string[]>;
  findLastNewDeviceLoginAt(userId: string): Promise<string | undefined>;
}

export interface NewDeviceLoginNotice {
  userId: string;
  deviceId: string;
  deviceLabel: string;
  ipAddress?: string;
  userAgent?: string;
  loggedInAt: string;
}

/** Delivers the "新设备登录" inbox message (wallet-service owns the inbox). */
export interface SecurityNotifier {
  notifyNewDeviceLogin(notice: NewDeviceLoginNotice): Promise<void>;
}
