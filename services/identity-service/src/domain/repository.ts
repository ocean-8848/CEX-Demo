import type {
  ApiKeyAuthInfo,
  CreateUserCommand,
  IdentityApiKey,
  IdentityApiKeyStatus,
  PersistedIdentityApiKey,
  IdentityOpsRole,
  IdentityUserCredential,
  IdentityUser,
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
} from "./types.js";

export interface IdentityRepository {
  withTransaction<T>(operation: (repository: IdentityRepository) => Promise<T>): Promise<T>;
  createUser(command: CreateUserCommand, now: string): Promise<IdentityUser>;
  findUserById(userId: string): Promise<IdentityUser | null>;
  getUserByEmail(email: string): Promise<IdentityUser | null>;
  listUsers(query: ListUsersQuery): Promise<PagedResult<IdentityUser>>;
  updateUserStatus(
    userId: string,
    status: IdentityUser["status"],
    reason: string | undefined,
    now: string
  ): Promise<void>;
  saveUserCredential(userId: string, passwordHash: string, now: string): Promise<void>;
  findUserCredentialByUserId(userId: string): Promise<IdentityUserCredential | null>;
  replaceUserRoles(userId: string, roles: IdentityOpsRole[], now: string): Promise<void>;
  findTwoFactorProfileByUserId(userId: string): Promise<TwoFactorProfile | null>;
  saveTwoFactorProfile(profile: TwoFactorProfile): Promise<void>;
  /** Replaces every recovery code of the user; an empty list deletes them. */
  replaceRecoveryCodes(userId: string, codeHashes: string[], now: string): Promise<void>;
  listRecoveryCodes(userId: string): Promise<RecoveryCodeRecord[]>;
  /** Marks an unused code as used; returns false when it was already used / unknown. */
  consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean>;
  updateUserKycTier(userId: string, tier: KycTier, now: string): Promise<void>;
  saveKycRequest(request: KycRequestRecord): Promise<void>;
  findKycRequestById(requestId: string): Promise<KycRequestRecord | null>;
  listKycRequests(query: ListKycRequestsQuery): Promise<PagedResult<KycRequestRecord>>;
  saveKycEvent(event: KycEventRecord): Promise<void>;
  listKycEvents(userId: string, limit: number): Promise<KycEventRecord[]>;
  createSession(session: PersistedOpsSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<OpsSessionRecord | null>;
  touchSession(sessionId: string, seenAt: string): Promise<void>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  saveApiKey(
    apiKey: PersistedIdentityApiKey,
    now: string
  ): Promise<void>;
  listApiKeys(userId: string): Promise<IdentityApiKey[]>;
  findApiKeyById(apiKeyId: string): Promise<IdentityApiKey | null>;
  findApiKeyAuthInfoByKeyId(
    keyId: string
  ): Promise<(ApiKeyAuthInfo & { secretCiphertext?: string }) | null>;
  touchApiKey(apiKeyId: string, usedAt: string): Promise<void>;
  revokeApiKey(
    apiKeyId: string,
    status: IdentityApiKeyStatus,
    revokedAt: string
  ): Promise<void>;
}
