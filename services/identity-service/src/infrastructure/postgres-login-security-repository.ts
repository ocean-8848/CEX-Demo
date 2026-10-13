import type {
  ListLoginEventsQuery,
  LoginEventRecord,
  LoginSecurityRepository,
  UserDeviceRecord
} from "../domain/login-security.js";
import type { IdentitySessionScope, PagedResult } from "../domain/types.js";
import type { SqlClient } from "./postgres.js";

interface LoginEventRow {
  event_id: string;
  user_id: string | null;
  email: string;
  scope: IdentitySessionScope;
  device_id: string;
  device_label: string;
  ip_address: string | null;
  user_agent: string | null;
  outcome: LoginEventRecord["outcome"];
  failure_code: string | null;
  is_new_device: boolean;
  session_id: string | null;
  created_at: Date;
}

interface DeviceRow {
  user_id: string;
  device_id: string;
  device_label: string;
  first_seen_at: Date;
  last_seen_at: Date;
  last_ip_address: string | null;
  last_user_agent: string | null;
  login_count: number;
  flagged_new: boolean;
  revoked_at: Date | null;
  active_session_count?: string;
}

const EVENT_COLUMNS = `event_id, user_id, email, scope, device_id, device_label, ip_address, user_agent,
       outcome, failure_code, is_new_device, session_id, created_at`;
const DEVICE_COLUMNS = `user_id, device_id, device_label, first_seen_at, last_seen_at, last_ip_address,
       last_user_agent, login_count, flagged_new, revoked_at`;

export class PostgresLoginSecurityRepository implements LoginSecurityRepository {
  constructor(private readonly db: SqlClient) {}

  async saveLoginEvent(event: LoginEventRecord): Promise<void> {
    await this.db.query(
      `insert into identity_login_events
       (event_id, user_id, email, scope, device_id, device_label, ip_address, user_agent,
        outcome, failure_code, is_new_device, session_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (event_id) do nothing`,
      [
        event.eventId,
        event.userId ?? null,
        event.email,
        event.scope,
        event.deviceId,
        event.deviceLabel,
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.outcome,
        event.failureCode ?? null,
        event.isNewDevice,
        event.sessionId ?? null,
        event.createdAt
      ]
    );
  }

  async listLoginEvents(query: ListLoginEventsQuery): Promise<PagedResult<LoginEventRecord>> {
    const values: unknown[] = [query.userId];
    let where = "where user_id = $1";
    if (query.outcome) {
      values.push(query.outcome);
      where += ` and outcome = $${values.length}`;
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const rows = await this.db.query<LoginEventRow>(
      `select ${EVENT_COLUMNS}
       from identity_login_events
       ${where}
       order by created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );
    const count = await this.db.query<{ total: string }>(
      `select count(*)::text as total from identity_login_events ${where}`,
      values
    );
    return {
      items: rows.rows.map(mapEvent),
      total: Number(count.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async listRecentLoginEvents(userId: string, since: string, limit: number): Promise<LoginEventRecord[]> {
    const rows = await this.db.query<LoginEventRow>(
      `select ${EVENT_COLUMNS}
       from identity_login_events
       where user_id = $1 and created_at >= $2
       order by created_at desc
       limit $3`,
      [userId, since, limit]
    );
    return rows.rows.map(mapEvent);
  }

  async findDevice(userId: string, deviceId: string): Promise<UserDeviceRecord | null> {
    const rows = await this.db.query<DeviceRow>(
      `select ${DEVICE_COLUMNS}
       from identity_user_devices
       where user_id = $1 and device_id = $2`,
      [userId, deviceId]
    );
    return rows.rows[0] ? mapDevice(rows.rows[0]) : null;
  }

  async countDevices(userId: string): Promise<number> {
    const rows = await this.db.query<{ total: string }>(
      `select count(*)::text as total from identity_user_devices where user_id = $1`,
      [userId]
    );
    return Number(rows.rows[0]?.total ?? "0");
  }

  async saveDevice(device: UserDeviceRecord): Promise<void> {
    await this.db.query(
      `insert into identity_user_devices
       (user_id, device_id, device_label, first_seen_at, last_seen_at, last_ip_address,
        last_user_agent, login_count, flagged_new, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (user_id, device_id) do update
       set device_label = excluded.device_label,
           last_seen_at = excluded.last_seen_at,
           last_ip_address = excluded.last_ip_address,
           last_user_agent = excluded.last_user_agent,
           login_count = excluded.login_count,
           revoked_at = excluded.revoked_at`,
      [
        device.userId,
        device.deviceId,
        device.deviceLabel,
        device.firstSeenAt,
        device.lastSeenAt,
        device.lastIpAddress ?? null,
        device.lastUserAgent ?? null,
        device.loginCount,
        device.flaggedNew,
        device.revokedAt ?? null
      ]
    );
  }

  async listDevices(userId: string, now: string): Promise<UserDeviceRecord[]> {
    const rows = await this.db.query<DeviceRow>(
      `select d.user_id, d.device_id, d.device_label, d.first_seen_at, d.last_seen_at, d.last_ip_address,
              d.last_user_agent, d.login_count, d.flagged_new, d.revoked_at,
              (select count(*)::text
                 from identity_ops_sessions s
                where s.user_id = d.user_id
                  and s.device_id = d.device_id
                  and s.revoked_at is null
                  and s.expires_at > $2) as active_session_count
       from identity_user_devices d
       where d.user_id = $1
       order by d.last_seen_at desc`,
      [userId, now]
    );
    return rows.rows.map(mapDevice);
  }

  async attachSessionDevice(sessionId: string, deviceId: string): Promise<void> {
    await this.db.query(`update identity_ops_sessions set device_id = $2 where session_id = $1`, [
      sessionId,
      deviceId
    ]);
  }

  async listActiveSessionIdsForDevice(userId: string, deviceId: string, now: string): Promise<string[]> {
    const rows = await this.db.query<{ session_id: string }>(
      `select session_id
       from identity_ops_sessions
       where user_id = $1 and device_id = $2 and revoked_at is null and expires_at > $3`,
      [userId, deviceId, now]
    );
    return rows.rows.map((row) => row.session_id);
  }

  async findLastNewDeviceLoginAt(userId: string): Promise<string | undefined> {
    const rows = await this.db.query<{ created_at: Date }>(
      `select created_at
       from identity_login_events
       where user_id = $1 and is_new_device = true and outcome = 'success'
       order by created_at desc
       limit 1`,
      [userId]
    );
    return rows.rows[0]?.created_at.toISOString();
  }
}

function mapEvent(row: LoginEventRow): LoginEventRecord {
  return {
    eventId: row.event_id,
    userId: row.user_id ?? undefined,
    email: row.email,
    scope: row.scope,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    outcome: row.outcome,
    failureCode: row.failure_code ?? undefined,
    isNewDevice: row.is_new_device,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

function mapDevice(row: DeviceRow): UserDeviceRecord {
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    lastIpAddress: row.last_ip_address ?? undefined,
    lastUserAgent: row.last_user_agent ?? undefined,
    loginCount: Number(row.login_count),
    flaggedNew: row.flagged_new,
    revokedAt: row.revoked_at?.toISOString(),
    ...(row.active_session_count !== undefined
      ? { activeSessionCount: Number(row.active_session_count) }
      : {})
  };
}
