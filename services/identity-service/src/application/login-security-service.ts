import { randomUUID } from "node:crypto";

import { IdentityError } from "../domain/errors.js";
import {
  DEFAULT_LOGIN_LOCK_POLICY,
  describeLockError,
  describeUserAgent,
  evaluateLoginLock,
  resolveDeviceId,
  type ListLoginEventsQuery,
  type LoginEventRecord,
  type LoginLockPolicy,
  type LoginLockStatus,
  type LoginSecurityRepository,
  type SecurityNotifier,
  type UserDeviceRecord
} from "../domain/login-security.js";
import type { IdentitySessionScope, PagedResult } from "../domain/types.js";

export interface LoginAttemptContext {
  email: string;
  scope: IdentitySessionScope;
  /** Raw device id from the client (may be missing). */
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginDeviceResult {
  deviceId: string;
  deviceLabel: string;
  isNewDevice: boolean;
}

interface SessionRevoker {
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
}

interface LoginSecurityOptions {
  now?: () => Date;
  createId?: () => string;
  lockPolicy?: LoginLockPolicy;
  notifier?: SecurityNotifier;
}

/**
 * Login events, device registry, new-device detection and the temporary
 * lock after repeated failures. Called by IdentityApplicationService around
 * every password login (customer and ops).
 */
export class LoginSecurityService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  readonly lockPolicy: LoginLockPolicy;
  private readonly notifier?: SecurityNotifier;

  constructor(
    private readonly repository: LoginSecurityRepository,
    private readonly sessions: SessionRevoker,
    options: LoginSecurityOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.lockPolicy = options.lockPolicy ?? DEFAULT_LOGIN_LOCK_POLICY;
    this.notifier = options.notifier;
  }

  async getLockStatus(userId: string): Promise<LoginLockStatus> {
    const now = this.now();
    if (this.lockPolicy.maxFailures <= 0) {
      return evaluateLoginLock([], now, this.lockPolicy);
    }
    const since = new Date(now.getTime() - this.lockPolicy.windowSeconds * 1000).toISOString();
    const events = await this.repository.listRecentLoginEvents(userId, since, 100);
    return evaluateLoginLock(events, now, this.lockPolicy);
  }

  /** Throws LOGIN_TEMPORARILY_LOCKED (and records a `locked` event) while locked. */
  async assertNotLocked(context: LoginAttemptContext & { userId: string }): Promise<void> {
    const status = await this.getLockStatus(context.userId);
    if (!status.locked) {
      return;
    }
    await this.saveEvent(context, { userId: context.userId, outcome: "locked", failureCode: "LOGIN_TEMPORARILY_LOCKED" });
    throw new IdentityError("LOGIN_TEMPORARILY_LOCKED", describeLockError(status));
  }

  async recordFailure(
    context: LoginAttemptContext & { userId?: string; failureCode: string }
  ): Promise<void> {
    await this.saveEvent(context, { userId: context.userId, outcome: "failure", failureCode: context.failureCode });
  }

  /**
   * Records the successful login, registers / refreshes the device and, for
   * a device the user has never used while other devices are known, flags it
   * as new and sends the "新设备登录" notification (customer logins only).
   */
  async recordSuccess(
    context: LoginAttemptContext & { userId: string; sessionId: string }
  ): Promise<LoginDeviceResult> {
    const now = this.now().toISOString();
    const deviceId = resolveDeviceId(context.deviceId, context.userAgent);
    const deviceLabel = describeUserAgent(context.userAgent);
    const existing = await this.repository.findDevice(context.userId, deviceId);
    // The very first device of an account is not "new": there is nothing to compare with.
    const isNewDevice = !existing && (await this.repository.countDevices(context.userId)) > 0;

    const device: UserDeviceRecord = existing
      ? {
          ...existing,
          deviceLabel,
          lastSeenAt: now,
          lastIpAddress: context.ipAddress ?? existing.lastIpAddress,
          lastUserAgent: context.userAgent ?? existing.lastUserAgent,
          loginCount: existing.loginCount + 1
        }
      : {
          userId: context.userId,
          deviceId,
          deviceLabel,
          firstSeenAt: now,
          lastSeenAt: now,
          lastIpAddress: context.ipAddress,
          lastUserAgent: context.userAgent,
          loginCount: 1,
          flaggedNew: isNewDevice
        };
    await this.repository.saveDevice(device);
    await this.repository.attachSessionDevice(context.sessionId, deviceId);
    await this.saveEvent(
      { ...context, deviceId },
      { userId: context.userId, outcome: "success", isNewDevice, sessionId: context.sessionId, createdAt: now }
    );

    if (isNewDevice && context.scope === "customer_web" && this.notifier) {
      try {
        await this.notifier.notifyNewDeviceLogin({
          userId: context.userId,
          deviceId,
          deviceLabel,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          loggedInAt: now
        });
      } catch (error) {
        // Best effort: a notification outage must never block logins.
        process.stderr.write(
          `[identity-service] new-device notification degraded: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        );
      }
    }

    return { deviceId, deviceLabel, isNewDevice };
  }

  async listLoginEvents(query: ListLoginEventsQuery): Promise<PagedResult<LoginEventRecord>> {
    return this.repository.listLoginEvents({
      ...query,
      limit: query.limit && query.limit > 0 ? Math.min(query.limit, 200) : 50,
      offset: query.offset && query.offset > 0 ? query.offset : 0
    });
  }

  async listDevices(userId: string): Promise<UserDeviceRecord[]> {
    return this.repository.listDevices(userId, this.now().toISOString());
  }

  /** Revokes every active session created on the device ("在该设备上退出登录"). */
  async revokeDevice(
    userId: string,
    deviceId: string
  ): Promise<{ userId: string; deviceId: string; revokedSessionCount: number; revokedAt: string }> {
    const device = await this.repository.findDevice(userId, deviceId);
    if (!device) {
      throw new IdentityError("DEVICE_NOT_FOUND", `Device ${deviceId} not found for user ${userId}`);
    }
    const revokedAt = this.now().toISOString();
    const sessionIds = await this.repository.listActiveSessionIdsForDevice(userId, deviceId, revokedAt);
    for (const sessionId of sessionIds) {
      await this.sessions.revokeSession(sessionId, revokedAt);
    }
    await this.repository.saveDevice({ ...device, revokedAt });
    return { userId, deviceId, revokedSessionCount: sessionIds.length, revokedAt };
  }

  /** Read by wallet-service for the optional new-device withdrawal lock. */
  async getLoginSecuritySummary(userId: string): Promise<{
    userId: string;
    lastNewDeviceLoginAt?: string;
    lock: LoginLockStatus;
    lockPolicy: LoginLockPolicy;
  }> {
    return {
      userId,
      lastNewDeviceLoginAt: await this.repository.findLastNewDeviceLoginAt(userId),
      lock: await this.getLockStatus(userId),
      lockPolicy: this.lockPolicy
    };
  }

  private async saveEvent(
    context: LoginAttemptContext,
    fields: Pick<LoginEventRecord, "outcome"> &
      Partial<Pick<LoginEventRecord, "userId" | "failureCode" | "isNewDevice" | "sessionId" | "createdAt">>
  ): Promise<void> {
    await this.repository.saveLoginEvent({
      eventId: this.createId(),
      userId: fields.userId,
      email: context.email,
      scope: context.scope,
      deviceId: resolveDeviceId(context.deviceId, context.userAgent),
      deviceLabel: describeUserAgent(context.userAgent),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      outcome: fields.outcome,
      failureCode: fields.failureCode,
      isNewDevice: fields.isNewDevice ?? false,
      sessionId: fields.sessionId,
      createdAt: fields.createdAt ?? this.now().toISOString()
    });
  }
}
