import type {
  ListLoginEventsQuery,
  LoginEventRecord,
  LoginSecurityRepository,
  UserDeviceRecord
} from "../domain/login-security.js";
import type { PagedResult } from "../domain/types.js";

/**
 * In-memory login security store (unit tests and IDENTITY_REPOSITORY=memory).
 * Session revocation itself lives in the identity repository; here a session
 * counts as active until its device's sessions were revoked after it attached.
 */
export class InMemoryLoginSecurityRepository implements LoginSecurityRepository {
  private readonly events: LoginEventRecord[] = [];
  private readonly devices = new Map<string, UserDeviceRecord>();
  private readonly sessions: Array<{ sessionId: string; deviceId: string; attachedAt: number }> = [];
  private readonly sessionOwners = new Map<string, string>();
  /** user:device -> index of the last session attached before the latest revoke. */
  private readonly revokedMarks = new Map<string, number>();

  async saveLoginEvent(event: LoginEventRecord): Promise<void> {
    this.events.push({ ...event });
    if (event.sessionId && event.userId) {
      this.sessionOwners.set(event.sessionId, event.userId);
    }
  }

  async listLoginEvents(query: ListLoginEventsQuery): Promise<PagedResult<LoginEventRecord>> {
    // Newest first; insertion order breaks timestamp ties.
    const items = [...this.events]
      .reverse()
      .filter((event) => event.userId === query.userId && (!query.outcome || event.outcome === query.outcome))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }

  async listRecentLoginEvents(userId: string, since: string, limit: number): Promise<LoginEventRecord[]> {
    return [...this.events]
      .reverse()
      .filter((event) => event.userId === userId && event.createdAt >= since)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async findDevice(userId: string, deviceId: string): Promise<UserDeviceRecord | null> {
    const device = this.devices.get(`${userId}:${deviceId}`);
    return device ? { ...device } : null;
  }

  async countDevices(userId: string): Promise<number> {
    return [...this.devices.values()].filter((device) => device.userId === userId).length;
  }

  async saveDevice(device: UserDeviceRecord): Promise<void> {
    const key = `${device.userId}:${device.deviceId}`;
    const { activeSessionCount: _ignored, ...rest } = device;
    if (device.revokedAt && this.devices.get(key)?.revokedAt !== device.revokedAt) {
      this.revokedMarks.set(key, this.sessions.length - 1);
    }
    this.devices.set(key, rest);
  }

  async listDevices(userId: string, now: string): Promise<UserDeviceRecord[]> {
    const devices = [...this.devices.values()].filter((device) => device.userId === userId);
    const result: UserDeviceRecord[] = [];
    for (const device of devices) {
      const active = await this.listActiveSessionIdsForDevice(userId, device.deviceId, now);
      result.push({ ...device, activeSessionCount: active.length });
    }
    return result.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  async attachSessionDevice(sessionId: string, deviceId: string): Promise<void> {
    this.sessions.push({ sessionId, deviceId, attachedAt: this.sessions.length });
  }

  async listActiveSessionIdsForDevice(userId: string, deviceId: string, _now: string): Promise<string[]> {
    const revokedAfter = this.revokedMarks.get(`${userId}:${deviceId}`) ?? -1;
    return this.sessions
      .filter(
        (session) =>
          session.deviceId === deviceId &&
          this.sessionOwners.get(session.sessionId) === userId &&
          session.attachedAt > revokedAfter
      )
      .map((session) => session.sessionId);
  }

  async findLastNewDeviceLoginAt(userId: string): Promise<string | undefined> {
    return this.events
      .filter((event) => event.userId === userId && event.isNewDevice && event.outcome === "success")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.createdAt;
  }
}
