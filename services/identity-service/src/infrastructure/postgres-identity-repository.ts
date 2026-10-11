import type { Pool, PoolClient } from "pg";

import type { IdentityRepository } from "../domain/repository.js";
import type {
  ApiKeyAuthInfo,
  CreateUserCommand,
  IdentityApiKey,
  IdentityApiKeyStatus,
  PersistedIdentityApiKey,
  IdentityOpsPermission,
  IdentityOpsRole,
  IdentitySessionScope,
  IdentityUser,
  IdentityUserCredential,
  KycEventRecord,
  KycRequestRecord,
  KycTier,
  ListKycRequestsQuery,
  ListUsersQuery,
  RecoveryCodeRecord,
  OpsSessionRecord,
  PagedResult,
  PersistedOpsSession,
  TwoFactorProfile
} from "../domain/types.js";
import { DEFAULT_API_KEY_SCOPES, type ApiKeyScope } from "../domain/api-key-secret.js";
import { withPgTransaction } from "./postgres.js";

interface IdentityUserRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  status: IdentityUser["status"];
  status_reason: string | null;
  status_updated_at: Date | null;
  user_type: IdentityUser["userType"];
  roles: IdentityOpsRole[] | null;
  two_factor_enabled: boolean;
  kyc_tier: KycTier | null;
  kyc_tier_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RecoveryCodeRow {
  user_id: string;
  code_hash: string;
  created_at: Date;
  used_at: Date | null;
}

interface KycRequestRow {
  request_id: string;
  user_id: string;
  requested_tier: KycRequestRecord["requestedTier"];
  full_name: string;
  id_number_masked: string;
  status: KycRequestRecord["status"];
  approved_tier: KycRequestRecord["approvedTier"] | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  email: string | null;
  display_name: string | null;
  kyc_tier: KycTier | null;
}

interface KycEventRow {
  event_id: string;
  user_id: string;
  from_tier: KycTier;
  to_tier: KycTier;
  action: KycEventRecord["action"];
  request_id: string | null;
  actor_id: string | null;
  reason: string | null;
  created_at: Date;
}

interface IdentityUserCountRow {
  total: string;
}

interface IdentityCredentialRow {
  user_id: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

interface TwoFactorProfileRow {
  user_id: string;
  pending_secret: string | null;
  secret: string | null;
  issuer: string;
  label: string | null;
  enabled: boolean;
  enabled_at: Date | null;
  changed_at: Date | null;
  last_verified_counter: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  token_hash: string;
  scope: IdentitySessionScope;
  roles: IdentityOpsRole[] | null;
  permissions: IdentityOpsPermission[] | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  email: string | null;
  display_name: string | null;
  status: IdentityUser["status"];
  user_type: IdentityUser["userType"];
}

interface ApiKeyRow {
  api_key_id: string;
  user_id: string;
  label: string;
  key_prefix: string;
  key_id: string | null;
  scopes: string[] | null;
  token_hash: string;
  secret_ciphertext?: string | null;
  status: IdentityApiKeyStatus;
  created_by: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ApiKeyAuthRow extends ApiKeyRow {
  email: string | null;
  display_name: string | null;
  user_status: IdentityUser["status"];
  user_type: IdentityUser["userType"];
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(operation: (repository: IdentityRepository) => Promise<T>): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }

    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresIdentityRepository(client))
    );
  }

  async createUser(command: CreateUserCommand, now: string): Promise<IdentityUser> {
    await this.db.query(
      `insert into identity_users (
         user_id,
         email,
         display_name,
         status,
         status_reason,
         status_updated_at,
         user_type,
         created_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       on conflict (user_id) do update
       set email = coalesce(identity_users.email, excluded.email),
           display_name = coalesce(identity_users.display_name, excluded.display_name),
           status = identity_users.status,
           status_reason = identity_users.status_reason,
           status_updated_at = identity_users.status_updated_at,
           user_type = identity_users.user_type,
           updated_at = identity_users.updated_at`,
      [
        command.userId,
        command.email ?? null,
        command.displayName ?? null,
        command.status ?? "active",
        command.statusReason ?? null,
        now,
        command.userType ?? "customer",
        now
      ]
    );

    const created = await this.findUserById(command.userId);
    if (!created) {
      throw new Error(`Failed to create identity user ${command.userId}`);
    }

    return created;
  }

  async findUserById(userId: string): Promise<IdentityUser | null> {
    const result = await this.db.query<IdentityUserRow>(
      `${buildIdentityUserSelect()}
       where iu.user_id = $1
       group by iu.user_id, iu.email, iu.display_name, iu.status, iu.status_reason,
                iu.status_updated_at, iu.user_type, utf.enabled, iu.kyc_tier, iu.kyc_tier_updated_at,
                iu.created_at, iu.updated_at`,
      [userId]
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<IdentityUser | null> {
    const result = await this.db.query<IdentityUserRow>(
      `${buildIdentityUserSelect()}
       where lower(iu.email) = lower($1)
       group by iu.user_id, iu.email, iu.display_name, iu.status, iu.status_reason,
                iu.status_updated_at, iu.user_type, utf.enabled, iu.kyc_tier, iu.kyc_tier_updated_at,
                iu.created_at, iu.updated_at`,
      [email]
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async listUsers(query: ListUsersQuery): Promise<PagedResult<IdentityUser>> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    addIdentityUserFilters(conditions, values, query);

    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const usersResult = await this.db.query<IdentityUserRow>(
      `${buildIdentityUserSelect()}
       ${whereClause}
       group by iu.user_id, iu.email, iu.display_name, iu.status, iu.status_reason,
                iu.status_updated_at, iu.user_type, utf.enabled, iu.kyc_tier, iu.kyc_tier_updated_at,
                iu.created_at, iu.updated_at
       order by iu.created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<IdentityUserCountRow>(
      `select count(*)::text as total
       from identity_users iu
       ${whereClause}`,
      values
    );

    return {
      items: usersResult.rows.map(mapUser),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async updateUserStatus(
    userId: string,
    status: IdentityUser["status"],
    reason: string | undefined,
    now: string
  ): Promise<void> {
    await this.db.query(
      `update identity_users
       set status = $2,
           status_reason = $3,
           status_updated_at = $4,
           updated_at = $4
       where user_id = $1`,
      [userId, status, reason ?? null, now]
    );
  }

  async saveUserCredential(userId: string, passwordHash: string, now: string): Promise<void> {
    await this.db.query(
      `insert into identity_user_credentials (user_id, password_hash, created_at, updated_at)
       values ($1, $2, $3, $3)
       on conflict (user_id) do update
       set password_hash = excluded.password_hash,
           updated_at = excluded.updated_at`,
      [userId, passwordHash, now]
    );
  }

  async findUserCredentialByUserId(userId: string): Promise<IdentityUserCredential | null> {
    const result = await this.db.query<IdentityCredentialRow>(
      `select user_id, password_hash, created_at, updated_at
       from identity_user_credentials
       where user_id = $1`,
      [userId]
    );

    return result.rows[0] ? mapCredential(result.rows[0]) : null;
  }

  async replaceUserRoles(userId: string, roles: IdentityOpsRole[], now: string): Promise<void> {
    await this.db.query(`delete from identity_user_roles where user_id = $1`, [userId]);

    for (const role of roles) {
      await this.db.query(
        `insert into identity_user_roles (user_id, role, created_at)
         values ($1, $2, $3)
         on conflict (user_id, role) do nothing`,
        [userId, role, now]
      );
    }
  }

  async findTwoFactorProfileByUserId(userId: string): Promise<TwoFactorProfile | null> {
    const result = await this.db.query<TwoFactorProfileRow>(
      `select user_id, pending_secret, secret, issuer, label, enabled, enabled_at, changed_at,
              last_verified_counter::text as last_verified_counter, created_at, updated_at
       from user_two_factor_profiles
       where user_id = $1`,
      [userId]
    );

    return result.rows[0] ? mapTwoFactorProfile(result.rows[0]) : null;
  }

  async saveTwoFactorProfile(profile: TwoFactorProfile): Promise<void> {
    await this.db.query(
      `insert into user_two_factor_profiles
       (user_id, pending_secret, secret, issuer, label, enabled, enabled_at, last_verified_counter, created_at, updated_at, changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (user_id) do update
       set pending_secret = excluded.pending_secret,
           secret = excluded.secret,
           issuer = excluded.issuer,
           label = excluded.label,
           enabled = excluded.enabled,
           enabled_at = excluded.enabled_at,
           last_verified_counter = excluded.last_verified_counter,
           updated_at = excluded.updated_at,
           changed_at = excluded.changed_at`,
      [
        profile.userId,
        profile.pendingSecret ?? null,
        profile.secret ?? null,
        profile.issuer,
        profile.label,
        profile.enabled,
        profile.enabledAt ?? null,
        profile.lastVerifiedCounter ?? null,
        profile.createdAt,
        profile.updatedAt,
        profile.changedAt ?? null
      ]
    );
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[], now: string): Promise<void> {
    await this.db.query(`delete from identity_two_factor_recovery_codes where user_id = $1`, [userId]);
    for (const codeHash of codeHashes) {
      await this.db.query(
        `insert into identity_two_factor_recovery_codes (user_id, code_hash, created_at)
         values ($1, $2, $3)
         on conflict (user_id, code_hash) do nothing`,
        [userId, codeHash, now]
      );
    }
  }

  async listRecoveryCodes(userId: string): Promise<RecoveryCodeRecord[]> {
    const result = await this.db.query<RecoveryCodeRow>(
      `select user_id, code_hash, created_at, used_at
       from identity_two_factor_recovery_codes
       where user_id = $1
       order by created_at asc`,
      [userId]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      codeHash: row.code_hash,
      createdAt: row.created_at.toISOString(),
      usedAt: row.used_at?.toISOString()
    }));
  }

  async consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean> {
    // Single conditional update: two concurrent logins cannot both spend a code.
    const result = await this.db.query(
      `update identity_two_factor_recovery_codes
       set used_at = $3
       where user_id = $1 and code_hash = $2 and used_at is null`,
      [userId, codeHash, usedAt]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateUserKycTier(userId: string, tier: KycTier, now: string): Promise<void> {
    await this.db.query(
      `update identity_users
       set kyc_tier = $2,
           kyc_tier_updated_at = $3,
           updated_at = $3
       where user_id = $1`,
      [userId, tier, now]
    );
  }

  async saveKycRequest(request: KycRequestRecord): Promise<void> {
    await this.db.query(
      `insert into identity_kyc_requests
       (request_id, user_id, requested_tier, full_name, id_number_masked, status, approved_tier,
        reviewed_by, review_note, created_at, reviewed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (request_id) do update
       set status = excluded.status,
           approved_tier = excluded.approved_tier,
           reviewed_by = excluded.reviewed_by,
           review_note = excluded.review_note,
           reviewed_at = excluded.reviewed_at`,
      [
        request.requestId,
        request.userId,
        request.requestedTier,
        request.fullName,
        request.idNumberMasked,
        request.status,
        request.approvedTier ?? null,
        request.reviewedBy ?? null,
        request.reviewNote ?? null,
        request.createdAt,
        request.reviewedAt ?? null
      ]
    );
  }

  async findKycRequestById(requestId: string): Promise<KycRequestRecord | null> {
    const result = await this.db.query<KycRequestRow>(
      `${KYC_REQUEST_SELECT}
       where kr.request_id = $1`,
      [requestId]
    );
    return result.rows[0] ? mapKycRequest(result.rows[0]) : null;
  }

  async listKycRequests(query: ListKycRequestsQuery): Promise<PagedResult<KycRequestRecord>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.userId) {
      values.push(query.userId);
      conditions.push(`kr.user_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`kr.status = $${values.length}`);
    }
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const rows = await this.db.query<KycRequestRow>(
      `${KYC_REQUEST_SELECT}
       ${whereClause}
       order by kr.created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );
    const count = await this.db.query<{ total: string }>(
      `select count(*)::text as total from identity_kyc_requests kr ${whereClause}`,
      values
    );
    return {
      items: rows.rows.map(mapKycRequest),
      total: Number(count.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async saveKycEvent(event: KycEventRecord): Promise<void> {
    await this.db.query(
      `insert into identity_kyc_events
       (event_id, user_id, from_tier, to_tier, action, request_id, actor_id, reason, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.eventId,
        event.userId,
        event.fromTier,
        event.toTier,
        event.action,
        event.requestId ?? null,
        event.actorId ?? null,
        event.reason ?? null,
        event.createdAt
      ]
    );
  }

  async listKycEvents(userId: string, limit: number): Promise<KycEventRecord[]> {
    const result = await this.db.query<KycEventRow>(
      `select event_id, user_id, from_tier, to_tier, action, request_id, actor_id, reason, created_at
       from identity_kyc_events
       where user_id = $1
       order by created_at desc
       limit $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      userId: row.user_id,
      fromTier: row.from_tier,
      toTier: row.to_tier,
      action: row.action,
      requestId: row.request_id ?? undefined,
      actorId: row.actor_id ?? undefined,
      reason: row.reason ?? undefined,
      createdAt: row.created_at.toISOString()
    }));
  }

  async createSession(session: PersistedOpsSession): Promise<void> {
    await this.db.query(
      `insert into identity_ops_sessions
       (session_id, user_id, token_hash, scope, roles, permissions, ip_address, user_agent, created_at, expires_at, last_seen_at, revoked_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        session.sessionId,
        session.userId,
        session.tokenHash,
        session.scope,
        JSON.stringify(session.roles),
        JSON.stringify(session.permissions),
        session.ipAddress ?? null,
        session.userAgent ?? null,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.revokedAt ?? null
      ]
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<OpsSessionRecord | null> {
    const result = await this.db.query<SessionRow>(
      `select ios.session_id, ios.user_id, ios.token_hash, ios.scope,
              ios.roles, ios.permissions, ios.ip_address, ios.user_agent,
              ios.created_at, ios.expires_at, ios.last_seen_at, ios.revoked_at,
              iu.email, iu.display_name, iu.status, iu.user_type
       from identity_ops_sessions ios
       join identity_users iu on iu.user_id = ios.user_id
       where ios.token_hash = $1`,
      [tokenHash]
    );

    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async touchSession(sessionId: string, seenAt: string): Promise<void> {
    await this.db.query(
      `update identity_ops_sessions
       set last_seen_at = $2
       where session_id = $1`,
      [sessionId, seenAt]
    );
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    await this.db.query(
      `update identity_ops_sessions
       set revoked_at = coalesce(revoked_at, $2)
       where session_id = $1`,
      [sessionId, revokedAt]
    );
  }

  async saveApiKey(apiKey: PersistedIdentityApiKey, now: string): Promise<void> {
    await this.db.query(
      `insert into identity_api_keys
       (api_key_id, user_id, label, key_prefix, token_hash, status, created_by, last_used_at,
        expires_at, revoked_at, created_at, updated_at, key_id, secret_ciphertext, scopes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (api_key_id) do update
       set label = excluded.label,
           status = excluded.status,
           last_used_at = excluded.last_used_at,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at,
           updated_at = excluded.updated_at`,
      [
        apiKey.apiKeyId,
        apiKey.userId,
        apiKey.label,
        apiKey.keyPrefix,
        apiKey.tokenHash,
        apiKey.status,
        apiKey.createdBy ?? null,
        apiKey.lastUsedAt ?? null,
        apiKey.expiresAt ?? null,
        apiKey.revokedAt ?? null,
        apiKey.createdAt,
        now,
        apiKey.keyId ?? null,
        apiKey.secretCiphertext ?? null,
        apiKey.scopes
      ]
    );
  }

  async listApiKeys(userId: string): Promise<IdentityApiKey[]> {
    const result = await this.db.query<ApiKeyRow>(
      `select api_key_id, user_id, label, key_prefix, key_id, scopes, token_hash, status, created_by,
              last_used_at, expires_at, revoked_at, created_at, updated_at
       from identity_api_keys
       where user_id = $1
       order by created_at desc`,
      [userId]
    );

    return result.rows.map(mapApiKey);
  }

  async findApiKeyById(apiKeyId: string): Promise<IdentityApiKey | null> {
    const result = await this.db.query<ApiKeyRow>(
      `select api_key_id, user_id, label, key_prefix, key_id, scopes, token_hash, status, created_by,
              last_used_at, expires_at, revoked_at, created_at, updated_at
       from identity_api_keys
       where api_key_id = $1`,
      [apiKeyId]
    );

    return result.rows[0] ? mapApiKey(result.rows[0]) : null;
  }

  async findApiKeyAuthInfoByKeyId(
    keyId: string
  ): Promise<(ApiKeyAuthInfo & { secretCiphertext?: string }) | null> {
    const result = await this.db.query<ApiKeyAuthRow>(
      `select iak.api_key_id, iak.user_id, iak.label, iak.key_prefix, iak.key_id, iak.scopes,
              iak.token_hash, iak.secret_ciphertext, iak.status,
              iak.created_by, iak.last_used_at, iak.expires_at, iak.revoked_at, iak.created_at,
              iak.updated_at, iu.email, iu.display_name, iu.status as user_status, iu.user_type
       from identity_api_keys iak
       join identity_users iu on iu.user_id = iak.user_id
       where iak.key_id = $1`,
      [keyId]
    );

    const row = result.rows[0];
    return row
      ? { ...mapApiKeyAuthInfo(row), secretCiphertext: row.secret_ciphertext ?? undefined }
      : null;
  }

  async touchApiKey(apiKeyId: string, usedAt: string): Promise<void> {
    await this.db.query(
      `update identity_api_keys
       set last_used_at = $2,
           updated_at = $2
       where api_key_id = $1`,
      [apiKeyId, usedAt]
    );
  }

  async revokeApiKey(
    apiKeyId: string,
    status: IdentityApiKeyStatus,
    revokedAt: string
  ): Promise<void> {
    await this.db.query(
      `update identity_api_keys
       set status = $2,
           revoked_at = coalesce(revoked_at, $3),
           updated_at = $3
       where api_key_id = $1`,
      [apiKeyId, status, revokedAt]
    );
  }
}

const KYC_REQUEST_SELECT = `select kr.request_id, kr.user_id, kr.requested_tier, kr.full_name,
         kr.id_number_masked, kr.status, kr.approved_tier, kr.reviewed_by, kr.review_note,
         kr.created_at, kr.reviewed_at, iu.email, iu.display_name, iu.kyc_tier
  from identity_kyc_requests kr
  join identity_users iu on iu.user_id = kr.user_id`;

function mapKycRequest(row: KycRequestRow): KycRequestRecord {
  return {
    requestId: row.request_id,
    userId: row.user_id,
    requestedTier: row.requested_tier,
    fullName: row.full_name,
    idNumberMasked: row.id_number_masked,
    status: row.status,
    approvedTier: row.approved_tier ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewNote: row.review_note ?? undefined,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString(),
    email: row.email ?? undefined,
    displayName: row.display_name ?? undefined,
    currentTier: row.kyc_tier ?? undefined
  };
}

function buildIdentityUserSelect(): string {
  return `select iu.user_id,
                 iu.email,
                 iu.display_name,
                 iu.status,
                 iu.status_reason,
                 iu.status_updated_at,
                 iu.user_type,
                 coalesce(array_remove(array_agg(distinct iur.role), null), '{}') as roles,
                 coalesce(utf.enabled, false) as two_factor_enabled,
                 iu.kyc_tier,
                 iu.kyc_tier_updated_at,
                 iu.created_at,
                 iu.updated_at
          from identity_users iu
          left join identity_user_roles iur on iur.user_id = iu.user_id
          left join user_two_factor_profiles utf on utf.user_id = iu.user_id`;
}

function addIdentityUserFilters(
  conditions: string[],
  values: unknown[],
  query: ListUsersQuery
): void {
  if (query.userId) {
    values.push(query.userId);
    conditions.push(`iu.user_id = $${values.length}`);
  }

  if (query.email) {
    values.push(query.email);
    conditions.push(`lower(iu.email) = lower($${values.length})`);
  }

  if (query.status) {
    values.push(query.status);
    conditions.push(`iu.status = $${values.length}`);
  }

  if (query.userType) {
    values.push(query.userType);
    conditions.push(`iu.user_type = $${values.length}`);
  }

  if (query.role) {
    values.push(query.role);
    conditions.push(
      `exists (
         select 1
         from identity_user_roles filter_roles
         where filter_roles.user_id = iu.user_id
           and filter_roles.role = $${values.length}
       )`
    );
  }

  if (query.search) {
    values.push(`%${query.search.toLowerCase()}%`);
    conditions.push(
      `(cast(iu.user_id as text) ilike $${values.length}
        or lower(coalesce(iu.email, '')) ilike $${values.length}
        or lower(coalesce(iu.display_name, '')) ilike $${values.length})`
    );
  }
}

function mapUser(row: IdentityUserRow): IdentityUser {
  return {
    userId: row.user_id,
    email: row.email ?? undefined,
    displayName: row.display_name ?? undefined,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    userType: row.user_type,
    roles: row.roles ?? [],
    twoFactorEnabled: row.two_factor_enabled,
    kycTier: row.kyc_tier ?? "unverified",
    kycTierUpdatedAt: row.kyc_tier_updated_at?.toISOString(),
    statusUpdatedAt: row.status_updated_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapCredential(row: IdentityCredentialRow): IdentityUserCredential {
  return {
    userId: row.user_id,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapTwoFactorProfile(row: TwoFactorProfileRow): TwoFactorProfile {
  return {
    userId: row.user_id,
    enabled: row.enabled,
    issuer: row.issuer,
    label: row.label ?? `user-${row.user_id}`,
    pendingSecret: row.pending_secret ?? undefined,
    secret: row.secret ?? undefined,
    enabledAt: row.enabled_at?.toISOString(),
    changedAt: row.changed_at?.toISOString(),
    lastVerifiedCounter:
      row.last_verified_counter !== null ? Number(row.last_verified_counter) : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapSession(row: SessionRow): OpsSessionRecord {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    scope: row.scope,
    roles: row.roles ?? [],
    permissions: row.permissions ?? [],
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    email: row.email ?? undefined,
    displayName: row.display_name ?? undefined,
    status: row.status,
    userType: row.user_type
  };
}

function mapScopes(scopes: string[] | null): ApiKeyScope[] {
  return (scopes ?? [...DEFAULT_API_KEY_SCOPES]) as ApiKeyScope[];
}

function mapApiKey(row: ApiKeyRow): IdentityApiKey {
  return {
    apiKeyId: row.api_key_id,
    userId: row.user_id,
    label: row.label,
    keyId: row.key_id ?? undefined,
    keyPrefix: row.key_prefix,
    scopes: mapScopes(row.scopes),
    status: row.status,
    createdBy: row.created_by ?? undefined,
    lastUsedAt: row.last_used_at?.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    active: row.status === "active" && !row.revoked_at
  };
}

function mapApiKeyAuthInfo(row: ApiKeyAuthRow): ApiKeyAuthInfo {
  return {
    apiKeyId: row.api_key_id,
    userId: row.user_id,
    email: row.email ?? undefined,
    displayName: row.display_name ?? undefined,
    userStatus: row.user_status,
    userType: row.user_type,
    label: row.label,
    keyId: row.key_id ?? undefined,
    keyPrefix: row.key_prefix,
    scopes: mapScopes(row.scopes),
    apiKeyStatus: row.status,
    createdBy: row.created_by ?? undefined,
    lastUsedAt: row.last_used_at?.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    active:
      row.status === "active" &&
      row.revoked_at === null &&
      (!row.expires_at || row.expires_at.getTime() > Date.now())
  };
}
