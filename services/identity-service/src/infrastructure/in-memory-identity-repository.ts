import type { IdentityRepository } from "../domain/repository.js";
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
} from "../domain/types.js";

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, IdentityUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly credentials = new Map<string, IdentityUserCredential>();
  private readonly roles = new Map<string, IdentityOpsRole[]>();
  private readonly profiles = new Map<string, TwoFactorProfile>();
  private readonly sessions = new Map<string, OpsSessionRecord>();
  private readonly sessionsByTokenHash = new Map<string, string>();
  private readonly apiKeys = new Map<string, PersistedIdentityApiKey>();
  private readonly recoveryCodes = new Map<string, RecoveryCodeRecord[]>();
  private readonly kycRequests = new Map<string, KycRequestRecord>();
  private readonly kycEvents: KycEventRecord[] = [];

  async withTransaction<T>(operation: (repository: IdentityRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async createUser(command: CreateUserCommand, now: string): Promise<IdentityUser> {
    const existing = this.users.get(command.userId);
    if (existing) {
      if (command.email) {
        this.usersByEmail.set(command.email.toLowerCase(), existing.userId);
      }
      return existing;
    }

    const user: IdentityUser = {
      userId: command.userId,
      email: command.email,
      displayName: command.displayName,
      status: command.status ?? "active",
      statusReason: command.statusReason,
      userType: command.userType ?? "customer",
      roles: [],
      twoFactorEnabled: false,
      kycTier: "unverified",
      statusUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    };

    this.users.set(command.userId, user);
    if (command.email) {
      this.usersByEmail.set(command.email.toLowerCase(), command.userId);
    }
    return user;
  }

  async findUserById(userId: string): Promise<IdentityUser | null> {
    return this.mapUser(this.users.get(userId) ?? null);
  }

  async getUserByEmail(email: string): Promise<IdentityUser | null> {
    const userId = this.usersByEmail.get(email.toLowerCase());
    return userId ? this.findUserById(userId) : null;
  }

  async listUsers(query: ListUsersQuery): Promise<PagedResult<IdentityUser>> {
    const users = [...this.users.values()]
      .map((user) => this.mapUser(user))
      .filter((user): user is IdentityUser => user !== null)
      .filter((user) => {
        if (query.userId && user.userId !== query.userId) {
          return false;
        }

        if (query.email && user.email !== query.email) {
          return false;
        }

        if (query.status && user.status !== query.status) {
          return false;
        }

        if (query.userType && user.userType !== query.userType) {
          return false;
        }

        if (query.role && !user.roles.includes(query.role)) {
          return false;
        }

        if (query.search) {
          const text = query.search.toLowerCase();
          const matches =
            user.userId.toLowerCase().includes(text) ||
            user.email?.toLowerCase().includes(text) ||
            user.displayName?.toLowerCase().includes(text);

          if (!matches) {
            return false;
          }
        }

        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;

    return {
      items: users.slice(offset, offset + limit),
      total: users.length,
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
    const user = this.users.get(userId);
    if (!user) {
      return;
    }

    this.users.set(userId, {
      ...user,
      status,
      statusReason: reason,
      statusUpdatedAt: now,
      updatedAt: now
    });
  }

  async saveUserCredential(userId: string, passwordHash: string, now: string): Promise<void> {
    this.credentials.set(userId, {
      userId,
      passwordHash,
      createdAt: this.credentials.get(userId)?.createdAt ?? now,
      updatedAt: now
    });
  }

  async findUserCredentialByUserId(userId: string): Promise<IdentityUserCredential | null> {
    return this.credentials.get(userId) ?? null;
  }

  async replaceUserRoles(userId: string, roles: IdentityOpsRole[]): Promise<void> {
    this.roles.set(userId, [...roles]);
  }

  async findTwoFactorProfileByUserId(userId: string): Promise<TwoFactorProfile | null> {
    return this.profiles.get(userId) ?? null;
  }

  async saveTwoFactorProfile(profile: TwoFactorProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[], now: string): Promise<void> {
    this.recoveryCodes.set(
      userId,
      codeHashes.map((codeHash) => ({ userId, codeHash, createdAt: now }))
    );
  }

  async listRecoveryCodes(userId: string): Promise<RecoveryCodeRecord[]> {
    return (this.recoveryCodes.get(userId) ?? []).map((code) => ({ ...code }));
  }

  async consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean> {
    const code = (this.recoveryCodes.get(userId) ?? []).find(
      (entry) => entry.codeHash === codeHash && !entry.usedAt
    );
    if (!code) {
      return false;
    }
    code.usedAt = usedAt;
    return true;
  }

  async updateUserKycTier(userId: string, tier: KycTier, now: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) {
      return;
    }
    this.users.set(userId, { ...user, kycTier: tier, kycTierUpdatedAt: now, updatedAt: now });
  }

  async saveKycRequest(request: KycRequestRecord): Promise<void> {
    const { email: _email, displayName: _displayName, currentTier: _tier, ...stored } = request;
    this.kycRequests.set(request.requestId, stored);
  }

  async findKycRequestById(requestId: string): Promise<KycRequestRecord | null> {
    const request = this.kycRequests.get(requestId);
    return request ? this.decorateKycRequest(request) : null;
  }

  async listKycRequests(query: ListKycRequestsQuery): Promise<PagedResult<KycRequestRecord>> {
    const matches = [...this.kycRequests.values()]
      .filter((request) => (query.userId ? request.userId === query.userId : true))
      .filter((request) => (query.status ? request.status === query.status : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    return {
      items: matches.slice(offset, offset + limit).map((request) => this.decorateKycRequest(request)),
      total: matches.length,
      limit,
      offset
    };
  }

  async saveKycEvent(event: KycEventRecord): Promise<void> {
    this.kycEvents.push({ ...event });
  }

  async listKycEvents(userId: string, limit: number): Promise<KycEventRecord[]> {
    return this.kycEvents
      .filter((event) => event.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  private decorateKycRequest(request: KycRequestRecord): KycRequestRecord {
    const user = this.users.get(request.userId);
    return {
      ...request,
      email: user?.email,
      displayName: user?.displayName,
      currentTier: user?.kycTier
    };
  }

  async createSession(session: PersistedOpsSession): Promise<void> {
    const user = this.users.get(session.userId);
    if (!user) {
      return;
    }

    const record: OpsSessionRecord = {
      ...session,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      userType: user.userType
    };

    this.sessions.set(session.sessionId, record);
    this.sessionsByTokenHash.set(session.tokenHash, session.sessionId);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<OpsSessionRecord | null> {
    const sessionId = this.sessionsByTokenHash.get(tokenHash);
    return sessionId ? this.sessions.get(sessionId) ?? null : null;
  }

  async touchSession(sessionId: string, seenAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.set(sessionId, {
      ...session,
      lastSeenAt: seenAt
    });
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.set(sessionId, {
      ...session,
      revokedAt
    });
  }

  async saveApiKey(apiKey: PersistedIdentityApiKey): Promise<void> {
    this.apiKeys.set(apiKey.apiKeyId, apiKey);
  }

  async listApiKeys(userId: string): Promise<IdentityApiKey[]> {
    return [...this.apiKeys.values()]
      .filter((apiKey) => apiKey.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ tokenHash: _tokenHash, secretCiphertext: _secret, ...apiKey }) => ({ ...apiKey }));
  }

  async findApiKeyById(apiKeyId: string): Promise<IdentityApiKey | null> {
    const apiKey = this.apiKeys.get(apiKeyId);
    if (!apiKey) {
      return null;
    }

    const { tokenHash: _tokenHash, secretCiphertext: _secret, ...result } = apiKey;
    return result;
  }

  async findApiKeyAuthInfoByKeyId(
    keyId: string
  ): Promise<(ApiKeyAuthInfo & { secretCiphertext?: string }) | null> {
    const apiKey = [...this.apiKeys.values()].find((entry) => entry.keyId === keyId);
    if (!apiKey) {
      return null;
    }

    const user = this.mapUser(this.users.get(apiKey.userId) ?? null);
    if (!user) {
      return null;
    }

    return {
      apiKeyId: apiKey.apiKeyId,
      userId: apiKey.userId,
      email: user.email,
      displayName: user.displayName,
      userStatus: user.status,
      userType: user.userType,
      label: apiKey.label,
      keyId: apiKey.keyId,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      secretCiphertext: apiKey.secretCiphertext,
      apiKeyStatus: apiKey.status,
      createdBy: apiKey.createdBy,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt,
      active:
        apiKey.status === "active" &&
        !apiKey.revokedAt &&
        (!apiKey.expiresAt || new Date(apiKey.expiresAt).getTime() > Date.now())
    };
  }

  async touchApiKey(apiKeyId: string, usedAt: string): Promise<void> {
    const apiKey = this.apiKeys.get(apiKeyId);
    if (!apiKey) {
      return;
    }

    this.apiKeys.set(apiKeyId, {
      ...apiKey,
      lastUsedAt: usedAt,
      updatedAt: usedAt
    });
  }

  async revokeApiKey(
    apiKeyId: string,
    status: IdentityApiKeyStatus,
    revokedAt: string
  ): Promise<void> {
    const apiKey = this.apiKeys.get(apiKeyId);
    if (!apiKey) {
      return;
    }

    this.apiKeys.set(apiKeyId, {
      ...apiKey,
      status,
      revokedAt,
      updatedAt: revokedAt,
      active: false
    });
  }

  private mapUser(user: IdentityUser | null): IdentityUser | null {
    if (!user) {
      return null;
    }

    const profile = this.profiles.get(user.userId);
    return {
      ...user,
      roles: [...(this.roles.get(user.userId) ?? [])],
      twoFactorEnabled: profile?.enabled ?? false
    };
  }
}
