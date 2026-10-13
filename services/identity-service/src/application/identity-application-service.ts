import { createHash, randomBytes, randomUUID } from "node:crypto";

import { IdentityError } from "../domain/errors.js";
import type { LoginSecurityService } from "./login-security-service.js";
import { hashPassword, verifyPassword } from "../domain/password.js";
import { isKycTier, isVerifiedKycTier, validateKycSubmission } from "../domain/kyc.js";
import { normalizeOpsRoles, resolveOpsPermissions } from "../domain/rbac.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode
} from "../domain/recovery-codes.js";
import type { IdentityRepository } from "../domain/repository.js";
import {
  buildOtpAuthUri,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode
} from "../domain/totp.js";
import type {
  ApiKeyAuthInfo,
  CreateApiKeyCommand,
  CreateCustomerSessionCommand,
  CreateOpsSessionCommand,
  CreateUserCommand,
  CreatedCustomerSession,
  CreatedIdentityApiKey,
  CreatedOpsSession,
  CustomerSessionInfo,
  DisableTwoFactorCommand,
  EnableTwoFactorCommand,
  EnrollTwoFactorCommand,
  FreezeUserCommand,
  IdentityApiKey,
  IdentitySessionInfo,
  IdentitySessionScope,
  IdentityUser,
  KycEventRecord,
  KycProfile,
  KycRequestRecord,
  ListKycRequestsQuery,
  ListUsersQuery,
  OpsSessionInfo,
  OpsSessionRecord,
  PagedResult,
  RegenerateRecoveryCodesCommand,
  ReviewKycRequestCommand,
  SessionDeviceInfo,
  SetKycTierCommand,
  SubmitKycRequestCommand,
  TwoFactorEnrollment,
  TwoFactorProfile,
  TwoFactorStatus,
  TwoFactorStatusWithRecoveryCodes,
  TwoFactorVerificationResult,
  UnfreezeUserCommand,
  VerifyApiKeySignatureCommand,
  VerifyTwoFactorCommand
} from "../domain/types.js";
import {
  ApiKeySecretBox,
  normalizeApiKeyScopes,
  signatureMatches,
  type ApiKeyScope
} from "../domain/api-key-secret.js";

interface ServiceOptions {
  now?: () => Date;
  issuer?: string;
  timeStepSeconds?: number;
  digits?: number;
  window?: number;
  opsSessionTtlHours?: number;
  customerSessionTtlHours?: number;
  requireOpsTwoFactor?: boolean;
  createLabel?: (user: IdentityUser) => string;
  /** Master key used to encrypt API key secrets at rest. */
  apiKeyEncryptionKey?: string;
  /** Login events, devices and failed-login lock; omitted = not recorded. */
  loginSecurity?: LoginSecurityService;
}

export class IdentityApplicationService {
  private readonly now: () => Date;
  private readonly issuer: string;
  private readonly timeStepSeconds: number;
  private readonly digits: number;
  private readonly window: number;
  private readonly opsSessionTtlHours: number;
  private readonly customerSessionTtlHours: number;
  private readonly requireOpsTwoFactor: boolean;
  private readonly createLabel: (user: IdentityUser) => string;
  private readonly secretBox: ApiKeySecretBox;
  private readonly loginSecurity?: LoginSecurityService;

  constructor(
    private readonly repository: IdentityRepository,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.issuer = options.issuer ?? "Web3 CEX";
    this.timeStepSeconds = options.timeStepSeconds ?? 30;
    this.digits = options.digits ?? 6;
    this.window = options.window ?? 1;
    this.opsSessionTtlHours = options.opsSessionTtlHours ?? 12;
    this.customerSessionTtlHours = options.customerSessionTtlHours ?? 24 * 7;
    this.requireOpsTwoFactor = options.requireOpsTwoFactor ?? true;
    this.secretBox = new ApiKeySecretBox(
      options.apiKeyEncryptionKey ?? "web3-cex-demo-api-key-encryption-key"
    );
    this.loginSecurity = options.loginSecurity;
    this.createLabel =
      options.createLabel ??
      ((user) => user.email ?? `user-${user.userId}`);
  }

  async createUser(command: CreateUserCommand): Promise<IdentityUser> {
    const now = this.now().toISOString();
    const targetUserType = command.userType ?? "customer";
    const roles = targetUserType === "ops" ? normalizeOpsRoles(command.roles) : [];
    const passwordHash = command.password ? hashPassword(command.password) : undefined;

    return this.repository.withTransaction(async (repository) => {
      await this.assertUniqueEmail(repository, command.email, command.userId);
      await repository.createUser(command, now);

      if (roles.length > 0) {
        await repository.replaceUserRoles(command.userId, roles, now);
      }

      if (passwordHash) {
        await repository.saveUserCredential(command.userId, passwordHash, now);
      }

      return this.requireUser(repository, command.userId);
    });
  }

  async registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<IdentityUser> {
    const normalizedEmail = command.email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new IdentityError("INVALID_CREDENTIALS", "Email is required");
    }

    return this.createUser({
      userId: randomUUID(),
      email: normalizedEmail,
      displayName: command.displayName?.trim() || undefined,
      password: command.password,
      status: "active",
      userType: "customer"
    });
  }

  async getUser(userId: string): Promise<IdentityUser> {
    return this.getRequiredUser(userId);
  }

  async listUsers(query: ListUsersQuery) {
    return this.repository.listUsers(query);
  }

  async freezeUser(command: FreezeUserCommand): Promise<IdentityUser> {
    const user = await this.getRequiredUser(command.userId);
    if (user.status === "disabled") {
      throw new IdentityError(
        "USER_FREEZE_NOT_ALLOWED",
        `User ${command.userId} is disabled and cannot be frozen`
      );
    }

    if (user.status === "suspended") {
      return user;
    }

    const now = this.now().toISOString();
    await this.repository.updateUserStatus(command.userId, "suspended", command.reason, now);
    return this.getRequiredUser(command.userId);
  }

  async unfreezeUser(command: UnfreezeUserCommand): Promise<IdentityUser> {
    const user = await this.getRequiredUser(command.userId);
    if (user.status === "disabled") {
      throw new IdentityError(
        "USER_FREEZE_NOT_ALLOWED",
        `User ${command.userId} is disabled and cannot be reactivated`
      );
    }

    if (user.status === "active") {
      return user;
    }

    const now = this.now().toISOString();
    await this.repository.updateUserStatus(command.userId, "active", undefined, now);
    return this.getRequiredUser(command.userId);
  }

  async createOpsSession(command: CreateOpsSessionCommand): Promise<CreatedOpsSession> {
    const session = await this.createSessionForEmail({
      email: command.email,
      password: command.password,
      twoFactorCode: command.twoFactorCode,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
      deviceId: command.deviceId,
      scope: "ops_console",
      ttlHours: this.opsSessionTtlHours
    });

    return {
      token: session.token,
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      status: session.status,
      roles: session.roles,
      permissions: session.permissions,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      active: session.active,
      ...(session.device ? { device: session.device } : {})
    };
  }

  async createCustomerSession(
    command: CreateCustomerSessionCommand
  ): Promise<CreatedCustomerSession> {
    const session = await this.createSessionForEmail({
      email: command.email,
      password: command.password,
      twoFactorCode: command.twoFactorCode,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
      deviceId: command.deviceId,
      scope: "customer_web",
      ttlHours: this.customerSessionTtlHours
    });

    return {
      token: session.token,
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      status: session.status,
      userType: session.userType,
      scope: "customer_web",
      roles: session.roles,
      permissions: session.permissions,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      active: session.active,
      ...(session.device ? { device: session.device } : {})
    };
  }

  async introspectOpsSession(token: string): Promise<OpsSessionInfo> {
    const session = await this.introspectSession(token, "ops_console");
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      status: session.status,
      roles: session.roles,
      permissions: session.permissions,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      active: session.active
    };
  }

  async introspectCustomerSession(token: string): Promise<CustomerSessionInfo> {
    const session = await this.introspectSession(token, "customer_web");
    return {
      ...session,
      scope: "customer_web"
    };
  }

  async revokeOpsSession(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.revokeSession(token, "ops_console");
  }

  async revokeCustomerSession(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.revokeSession(token, "customer_web");
  }

  async createApiKey(command: CreateApiKeyCommand): Promise<CreatedIdentityApiKey> {
    const label = command.label.trim();
    if (!label) {
      throw new IdentityError("INVALID_API_KEY_LABEL", "API key label cannot be empty");
    }

    let scopes: ApiKeyScope[];
    try {
      scopes = normalizeApiKeyScopes(command.scopes);
    } catch (error) {
      throw new IdentityError("INVALID_API_KEY_SCOPE", (error as Error).message);
    }

    const user = await this.getRequiredUser(command.userId);
    if (user.status !== "active") {
      throw new IdentityError("USER_NOT_ACTIVE", `User ${user.userId} is not active`);
    }

    const now = this.now().toISOString();
    const apiKeyId = randomUUID();
    // keyId is public (sent on every request); the secret is shown once and only
    // ever used as the HMAC key, so it never travels over the wire again.
    const keyId = `ak_${randomBytes(12).toString("hex")}`;
    const secret = `sk_${randomBytes(24).toString("base64url")}`;
    const keyPrefix = keyId;

    await this.repository.saveApiKey(
      {
        apiKeyId,
        userId: command.userId,
        label,
        keyId,
        keyPrefix,
        scopes,
        tokenHash: hashToken(secret),
        secretCiphertext: this.secretBox.seal(secret),
        status: "active",
        active: true,
        createdBy: command.createdBy,
        expiresAt: command.expiresAt,
        createdAt: now,
        updatedAt: now
      },
      now
    );

    return {
      apiKeyId,
      userId: command.userId,
      label,
      keyId,
      keyPrefix,
      scopes,
      secret,
      status: "active",
      createdBy: command.createdBy,
      expiresAt: command.expiresAt,
      createdAt: now,
      updatedAt: now,
      active: true
    };
  }

  async listApiKeys(userId: string): Promise<IdentityApiKey[]> {
    await this.getRequiredUser(userId);
    return this.repository.listApiKeys(userId);
  }

  async revokeApiKey(apiKeyId: string): Promise<IdentityApiKey> {
    const existing = await this.repository.findApiKeyById(apiKeyId);
    if (!existing) {
      throw new IdentityError("API_KEY_NOT_FOUND", `API key ${apiKeyId} not found`);
    }

    if (existing.status === "revoked") {
      return existing;
    }

    const revokedAt = this.now().toISOString();
    await this.repository.revokeApiKey(apiKeyId, "revoked", revokedAt);
    const updated = await this.repository.findApiKeyById(apiKeyId);
    if (!updated) {
      throw new IdentityError("API_KEY_NOT_FOUND", `API key ${apiKeyId} not found`);
    }

    return updated;
  }

  /**
   * Verifies an API request signature on behalf of the gateway. The gateway
   * builds the canonical request (it owns the raw body) and checks timestamp /
   * nonce freshness; identity owns the secret and the key's lifecycle.
   */
  async verifyApiKeySignature(command: VerifyApiKeySignatureCommand): Promise<ApiKeyAuthInfo> {
    const keyId = command.keyId.trim();
    if (!keyId) {
      throw new IdentityError("API_KEY_NOT_FOUND", "API key id is required");
    }

    const authInfo = await this.repository.findApiKeyAuthInfoByKeyId(keyId);
    if (!authInfo || !authInfo.secretCiphertext) {
      throw new IdentityError("API_KEY_NOT_FOUND", "API key is not recognized");
    }

    let secret: string;
    try {
      secret = this.secretBox.open(authInfo.secretCiphertext);
    } catch {
      throw new IdentityError("API_KEY_NOT_FOUND", `API key ${keyId} cannot be decrypted`);
    }
    if (!signatureMatches(secret, command.canonicalRequest, command.signature)) {
      throw new IdentityError("INVALID_API_KEY_SIGNATURE", "API key signature is invalid");
    }

    if (authInfo.userType !== "customer") {
      throw new IdentityError(
        "API_KEY_NOT_FOUND",
        `API key ${authInfo.apiKeyId} cannot be used for customer APIs`
      );
    }

    if (authInfo.userStatus !== "active") {
      throw new IdentityError("USER_NOT_ACTIVE", `User ${authInfo.userId} is not active`);
    }

    if (!authInfo.active || authInfo.apiKeyStatus !== "active") {
      throw new IdentityError("API_KEY_NOT_FOUND", `API key ${authInfo.apiKeyId} is not active`);
    }

    if (authInfo.expiresAt && new Date(authInfo.expiresAt).getTime() <= this.now().getTime()) {
      throw new IdentityError("API_KEY_NOT_FOUND", `API key ${authInfo.apiKeyId} is expired`);
    }

    const usedAt = this.now().toISOString();
    await this.repository.touchApiKey(authInfo.apiKeyId, usedAt);
    const { secretCiphertext: _secret, ...result } = authInfo;
    return { ...result, lastUsedAt: usedAt };
  }

  async getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
    const user = await this.getRequiredUser(userId);
    const profile = await this.repository.findTwoFactorProfileByUserId(userId);

    return mapTwoFactorStatus(
      user,
      profile,
      this.createLabel(user),
      this.issuer,
      await this.countUnusedRecoveryCodes(userId)
    );
  }

  async enrollTwoFactor(command: EnrollTwoFactorCommand): Promise<TwoFactorEnrollment> {
    const user = await this.getRequiredUser(command.userId);
    const existing = await this.repository.findTwoFactorProfileByUserId(command.userId);

    if (existing?.enabled) {
      throw new IdentityError(
        "TWO_FACTOR_ALREADY_ENABLED",
        `Two-factor authentication is already enabled for user ${command.userId}`
      );
    }

    const enrolledAt = this.now().toISOString();
    const issuer = command.issuer ?? existing?.issuer ?? this.issuer;
    const label = command.label ?? existing?.label ?? this.createLabel(user);
    const secret = generateTotpSecret();

    const profile: TwoFactorProfile = {
      userId: command.userId,
      enabled: false,
      issuer,
      label,
      pendingSecret: secret,
      secret: undefined,
      enabledAt: undefined,
      lastVerifiedCounter: existing?.lastVerifiedCounter,
      changedAt: existing?.changedAt,
      createdAt: existing?.createdAt ?? enrolledAt,
      updatedAt: enrolledAt
    };

    await this.repository.withTransaction((repository) => repository.saveTwoFactorProfile(profile));

    return {
      userId: command.userId,
      secret,
      otpauthUri: buildOtpAuthUri({
        issuer,
        label,
        secret,
        digits: this.digits,
        periodSeconds: this.timeStepSeconds
      }),
      issuer,
      label,
      enrolledAt
    };
  }

  async enableTwoFactor(
    command: EnableTwoFactorCommand
  ): Promise<TwoFactorStatusWithRecoveryCodes> {
    const user = await this.getRequiredUser(command.userId);
    const profile = await this.repository.findTwoFactorProfileByUserId(command.userId);
    if (!profile?.pendingSecret) {
      throw new IdentityError(
        "TWO_FACTOR_NOT_ENROLLED",
        `Two-factor authentication is not enrolled for user ${command.userId}`
      );
    }

    const counter = verifyTotpCode({
      secret: profile.pendingSecret,
      code: command.code,
      now: this.now(),
      periodSeconds: this.timeStepSeconds,
      digits: this.digits,
      window: this.window
    });

    if (counter === null) {
      throw new IdentityError("TWO_FACTOR_INVALID_CODE", "Two-factor code is invalid");
    }

    const enabledAt = this.now().toISOString();
    const nextProfile: TwoFactorProfile = {
      ...profile,
      enabled: true,
      secret: profile.pendingSecret,
      pendingSecret: undefined,
      enabledAt,
      lastVerifiedCounter: counter,
      changedAt: enabledAt,
      updatedAt: enabledAt
    };

    // Recovery codes are shown once in this response; only hashes are stored.
    const recoveryCodes = generateRecoveryCodes();
    await this.repository.withTransaction(async (repository) => {
      await repository.saveTwoFactorProfile(nextProfile);
      await repository.replaceRecoveryCodes(
        command.userId,
        recoveryCodes.map((code) => hashRecoveryCode(command.userId, code)),
        enabledAt
      );
    });

    return {
      ...mapTwoFactorStatus(
        user,
        nextProfile,
        this.createLabel(user),
        this.issuer,
        recoveryCodes.length
      ),
      recoveryCodes
    };
  }

  /**
   * Turns 2FA off. Requires a valid current TOTP code or an unused recovery
   * code, so a stolen session alone cannot remove the second factor.
   */
  async disableTwoFactor(command: DisableTwoFactorCommand): Promise<TwoFactorStatus> {
    const user = await this.getRequiredUser(command.userId);
    const profile = await this.repository.findTwoFactorProfileByUserId(command.userId);
    if (!profile?.enabled || !profile.secret) {
      throw new IdentityError(
        "TWO_FACTOR_NOT_ENABLED",
        `Two-factor authentication is not enabled for user ${command.userId}`
      );
    }

    await this.verifySecondFactor(command.userId, command.code ?? "", "two_factor_disable");

    const changedAt = this.now().toISOString();
    const latest = (await this.repository.findTwoFactorProfileByUserId(command.userId)) ?? profile;
    const nextProfile: TwoFactorProfile = {
      ...latest,
      enabled: false,
      secret: undefined,
      pendingSecret: undefined,
      enabledAt: undefined,
      changedAt,
      updatedAt: changedAt
    };

    await this.repository.withTransaction(async (repository) => {
      await repository.saveTwoFactorProfile(nextProfile);
      await repository.replaceRecoveryCodes(command.userId, [], changedAt);
    });

    return mapTwoFactorStatus(user, nextProfile, this.createLabel(user), this.issuer, 0);
  }

  /** Replaces every recovery code; requires a current TOTP code. */
  async regenerateRecoveryCodes(
    command: RegenerateRecoveryCodesCommand
  ): Promise<TwoFactorStatusWithRecoveryCodes> {
    const user = await this.getRequiredUser(command.userId);
    await this.verifyTwoFactor({
      userId: command.userId,
      code: command.code ?? "",
      purpose: "recovery_codes_regenerate"
    });

    const now = this.now().toISOString();
    const recoveryCodes = generateRecoveryCodes();
    await this.repository.withTransaction((repository) =>
      repository.replaceRecoveryCodes(
        command.userId,
        recoveryCodes.map((code) => hashRecoveryCode(command.userId, code)),
        now
      )
    );
    const profile = await this.repository.findTwoFactorProfileByUserId(command.userId);
    return {
      ...mapTwoFactorStatus(user, profile, this.createLabel(user), this.issuer, recoveryCodes.length),
      recoveryCodes
    };
  }

  async verifyTwoFactor(command: VerifyTwoFactorCommand): Promise<TwoFactorVerificationResult> {
    await this.getRequiredUser(command.userId);
    const profile = await this.repository.findTwoFactorProfileByUserId(command.userId);
    if (!profile?.enabled || !profile.secret) {
      throw new IdentityError(
        "TWO_FACTOR_NOT_ENABLED",
        `Two-factor authentication is not enabled for user ${command.userId}`
      );
    }

    const counter = verifyTotpCode({
      secret: profile.secret,
      code: command.code,
      now: this.now(),
      periodSeconds: this.timeStepSeconds,
      digits: this.digits,
      window: this.window
    });

    if (counter === null) {
      throw new IdentityError("TWO_FACTOR_INVALID_CODE", "Two-factor code is invalid");
    }

    if (
      profile.lastVerifiedCounter !== undefined &&
      Number.isFinite(profile.lastVerifiedCounter) &&
      counter <= profile.lastVerifiedCounter
    ) {
      throw new IdentityError(
        "TWO_FACTOR_CODE_REUSED",
        "Two-factor code has already been used for this user"
      );
    }

    const verifiedAt = this.now().toISOString();
    await this.repository.withTransaction((repository) =>
      repository.saveTwoFactorProfile({
        ...profile,
        lastVerifiedCounter: counter,
        updatedAt: verifiedAt
      })
    );

    return {
      verified: true,
      userId: command.userId,
      verifiedAt,
      purpose: command.purpose
    };
  }

  generateCurrentTotpCode(secret: string): { code: string; counter: number } {
    return generateTotpCode(secret, this.now(), this.timeStepSeconds, this.digits);
  }

  // ---------------------------------------------------------------------------
  // KYC tiers (M4-4)
  // ---------------------------------------------------------------------------

  async getKycProfile(userId: string): Promise<KycProfile> {
    const user = await this.getRequiredUser(userId);
    const [requests, events] = await Promise.all([
      this.repository.listKycRequests({ userId, limit: 1, offset: 0 }),
      this.repository.listKycEvents(userId, 20)
    ]);
    const latestRequest = requests.items[0];
    return {
      userId,
      tier: user.kycTier,
      tierUpdatedAt: user.kycTierUpdatedAt,
      latestRequest,
      pendingRequest: latestRequest?.status === "pending" ? latestRequest : undefined,
      events
    };
  }

  async submitKycRequest(command: SubmitKycRequestCommand): Promise<KycRequestRecord> {
    const user = await this.getRequiredUser(command.userId);
    if (user.userType !== "customer") {
      throw new IdentityError("KYC_NOT_ALLOWED", "Only customer accounts can submit KYC requests");
    }
    if (user.status !== "active") {
      throw new IdentityError("USER_NOT_ACTIVE", `User ${user.userId} is not active`);
    }

    const validation = validateKycSubmission(user.kycTier, command);
    if (!validation.ok) {
      throw new IdentityError("KYC_REQUEST_INVALID", validation.reason);
    }

    const pending = await this.repository.listKycRequests({
      userId: command.userId,
      status: "pending",
      limit: 1,
      offset: 0
    });
    if (pending.items.length > 0) {
      throw new IdentityError(
        "KYC_REQUEST_PENDING",
        "A KYC request is already waiting for review"
      );
    }

    const request: KycRequestRecord = {
      requestId: randomUUID(),
      userId: command.userId,
      requestedTier: validation.value.requestedTier,
      fullName: validation.value.fullName,
      idNumberMasked: validation.value.idNumberMasked,
      status: "pending",
      createdAt: this.now().toISOString()
    };
    await this.repository.withTransaction((repository) => repository.saveKycRequest(request));
    return (await this.repository.findKycRequestById(request.requestId)) ?? request;
  }

  async listKycRequests(query: ListKycRequestsQuery): Promise<PagedResult<KycRequestRecord>> {
    return this.repository.listKycRequests({
      ...query,
      limit: query.limit && query.limit > 0 ? Math.min(query.limit, 200) : 50,
      offset: query.offset && query.offset > 0 ? query.offset : 0
    });
  }

  async approveKycRequest(command: ReviewKycRequestCommand): Promise<KycRequestRecord> {
    const request = await this.getPendingKycRequest(command.requestId);
    const tier = command.tier ?? request.requestedTier;
    if (!isVerifiedKycTier(tier)) {
      throw new IdentityError("KYC_REQUEST_INVALID", "Approved tier must be L1 or L2");
    }

    const user = await this.getRequiredUser(request.userId);
    const reviewedAt = this.now().toISOString();
    const reviewed: KycRequestRecord = {
      ...request,
      status: "approved",
      approvedTier: tier,
      reviewedBy: command.reviewedBy,
      reviewNote: command.note,
      reviewedAt
    };
    const event: KycEventRecord = {
      eventId: randomUUID(),
      userId: request.userId,
      fromTier: user.kycTier,
      toTier: tier,
      action: "request_approved",
      requestId: request.requestId,
      actorId: command.reviewedBy,
      reason: command.note,
      createdAt: reviewedAt
    };

    await this.repository.withTransaction(async (repository) => {
      await repository.saveKycRequest(reviewed);
      await repository.updateUserKycTier(request.userId, tier, reviewedAt);
      await repository.saveKycEvent(event);
    });
    return (await this.repository.findKycRequestById(request.requestId)) ?? reviewed;
  }

  async rejectKycRequest(command: ReviewKycRequestCommand): Promise<KycRequestRecord> {
    const request = await this.getPendingKycRequest(command.requestId);
    const user = await this.getRequiredUser(request.userId);
    const reviewedAt = this.now().toISOString();
    const reviewed: KycRequestRecord = {
      ...request,
      status: "rejected",
      reviewedBy: command.reviewedBy,
      reviewNote: command.note,
      reviewedAt
    };
    await this.repository.withTransaction(async (repository) => {
      await repository.saveKycRequest(reviewed);
      await repository.saveKycEvent({
        eventId: randomUUID(),
        userId: request.userId,
        fromTier: user.kycTier,
        toTier: user.kycTier,
        action: "request_rejected",
        requestId: request.requestId,
        actorId: command.reviewedBy,
        reason: command.note,
        createdAt: reviewedAt
      });
    });
    return (await this.repository.findKycRequestById(request.requestId)) ?? reviewed;
  }

  /** Manual ops adjustment (up or down), always recorded as a KYC event. */
  async setKycTier(command: SetKycTierCommand): Promise<KycProfile> {
    if (!isKycTier(command.tier)) {
      throw new IdentityError("KYC_REQUEST_INVALID", "tier must be unverified, L1 or L2");
    }
    const tier = command.tier;
    const user = await this.getRequiredUser(command.userId);
    if (user.userType !== "customer") {
      throw new IdentityError("KYC_NOT_ALLOWED", "Only customer accounts have a KYC tier");
    }

    if (user.kycTier !== tier) {
      const now = this.now().toISOString();
      await this.repository.withTransaction(async (repository) => {
        await repository.updateUserKycTier(command.userId, tier, now);
        await repository.saveKycEvent({
          eventId: randomUUID(),
          userId: command.userId,
          fromTier: user.kycTier,
          toTier: tier,
          action: "tier_adjusted",
          actorId: command.actorId,
          reason: command.reason,
          createdAt: now
        });
      });
    }
    return this.getKycProfile(command.userId);
  }

  private async getPendingKycRequest(requestId: string): Promise<KycRequestRecord> {
    const request = await this.repository.findKycRequestById(requestId);
    if (!request) {
      throw new IdentityError("KYC_REQUEST_NOT_FOUND", `KYC request ${requestId} not found`);
    }
    if (request.status !== "pending") {
      throw new IdentityError(
        "KYC_REQUEST_ALREADY_REVIEWED",
        `KYC request ${requestId} was already ${request.status}`
      );
    }
    return request;
  }

  /**
   * Accepts either a TOTP code (with replay protection) or an unused recovery
   * code. Recovery codes are consumed on success.
   */
  private async verifySecondFactor(userId: string, code: string, purpose: string): Promise<void> {
    if (looksLikeRecoveryCode(code)) {
      const consumed = await this.repository.consumeRecoveryCode(
        userId,
        hashRecoveryCode(userId, code),
        this.now().toISOString()
      );
      if (!consumed) {
        throw new IdentityError(
          "TWO_FACTOR_RECOVERY_CODE_INVALID",
          "Recovery code is invalid or has already been used"
        );
      }
      return;
    }

    await this.verifyTwoFactor({ userId, code, purpose });
  }

  private async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const codes = await this.repository.listRecoveryCodes(userId);
    return codes.filter((code) => !code.usedAt).length;
  }

  private async createSessionForEmail(params: {
    email: string;
    password: string;
    twoFactorCode?: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
    scope: IdentitySessionScope;
    ttlHours: number;
  }): Promise<CreatedSession> {
    const email = params.email.trim().toLowerCase();
    const attempt = {
      email,
      scope: params.scope,
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent
    };
    const user = await this.repository.getUserByEmail(email);
    if (!user) {
      await this.loginSecurity?.recordFailure({ ...attempt, failureCode: "INVALID_CREDENTIALS" });
      throw new IdentityError("INVALID_CREDENTIALS", "Email or password is invalid");
    }

    try {
      await this.verifyLoginSecrets(user, params);
    } catch (error) {
      if (error instanceof IdentityError && error.code !== "LOGIN_TEMPORARILY_LOCKED") {
        await this.loginSecurity?.recordFailure({ ...attempt, userId: user.userId, failureCode: error.code });
      }
      throw error;
    }

    const session = await this.issueSession(user, params);
    if (this.loginSecurity) {
      session.device = await this.loginSecurity.recordSuccess({
        ...attempt,
        userId: user.userId,
        sessionId: session.sessionId
      });
    }
    return session;
  }

  /** Scope / status checks, failed-login lock, password and 2FA. */
  private async verifyLoginSecrets(
    user: IdentityUser,
    params: {
      email: string;
      password: string;
      twoFactorCode?: string;
      scope: IdentitySessionScope;
      deviceId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<void> {
    if (params.scope === "ops_console" && user.userType !== "ops") {
      throw new IdentityError("OPS_ACCESS_DENIED", `User ${user.userId} is not an ops user`);
    }

    if (params.scope === "customer_web" && user.userType !== "customer") {
      throw new IdentityError(
        "INVALID_CREDENTIALS",
        "Email or password is invalid"
      );
    }

    if (user.status !== "active") {
      throw new IdentityError("USER_NOT_ACTIVE", `User ${user.userId} is not active`);
    }

    // Checked before the password so a locked account cannot keep guessing.
    await this.loginSecurity?.assertNotLocked({
      email: params.email.trim().toLowerCase(),
      scope: params.scope,
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      userId: user.userId
    });

    const credential = await this.repository.findUserCredentialByUserId(user.userId);
    if (!credential || !verifyPassword(params.password, credential.passwordHash)) {
      throw new IdentityError("INVALID_CREDENTIALS", "Email or password is invalid");
    }

    await this.assertTwoFactorForLogin(user, params.scope, params.twoFactorCode);
  }

  private async issueSession(
    user: IdentityUser,
    params: { userAgent?: string; ipAddress?: string; scope: IdentitySessionScope; ttlHours: number }
  ): Promise<CreatedSession> {
    const createdAt = this.now().toISOString();
    const rawToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const roles = params.scope === "ops_console" ? normalizeOpsRoles(user.roles) : [];
    const permissions = params.scope === "ops_console" ? resolveOpsPermissions(roles) : [];
    const expiresAt = new Date(
      this.now().getTime() + params.ttlHours * 60 * 60 * 1000
    ).toISOString();

    await this.repository.createSession({
      sessionId,
      userId: user.userId,
      tokenHash: hashToken(rawToken),
      scope: params.scope,
      roles,
      permissions,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      createdAt,
      expiresAt,
      lastSeenAt: createdAt
    });

    return {
      token: rawToken,
      sessionId,
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      userType: user.userType,
      scope: params.scope,
      roles,
      permissions,
      createdAt,
      expiresAt,
      lastSeenAt: createdAt,
      active: true
    };
  }

  private async introspectSession(
    token: string,
    scope: IdentitySessionScope
  ): Promise<IdentitySessionInfo> {
    const session = await this.getRequiredActiveSession(token, scope);
    const now = this.now().toISOString();

    if (shouldTouchSession(session.lastSeenAt, now)) {
      await this.repository.touchSession(session.sessionId, now);
      session.lastSeenAt = now;
    }

    return mapSessionInfo(session, now);
  }

  private async revokeSession(
    token: string,
    scope: IdentitySessionScope
  ): Promise<{ revoked: true; revokedAt: string }> {
    const session = await this.getRequiredSession(token, scope);
    if (session.revokedAt) {
      return {
        revoked: true,
        revokedAt: session.revokedAt
      };
    }

    const revokedAt = this.now().toISOString();
    await this.repository.revokeSession(session.sessionId, revokedAt);
    return {
      revoked: true,
      revokedAt
    };
  }

  private async assertTwoFactorForLogin(
    user: IdentityUser,
    scope: IdentitySessionScope,
    code?: string
  ): Promise<void> {
    const profile = await this.repository.findTwoFactorProfileByUserId(user.userId);

    if (scope === "ops_console" && this.requireOpsTwoFactor && !profile?.enabled) {
      throw new IdentityError(
        "OPS_TWO_FACTOR_REQUIRED",
        `Ops user ${user.userId} must enable two-factor authentication before login`
      );
    }

    if (!profile?.enabled) {
      return;
    }

    if (!code) {
      throw new IdentityError(
        scope === "ops_console" ? "OPS_TWO_FACTOR_REQUIRED" : "TWO_FACTOR_REQUIRED",
        "Two-factor code is required"
      );
    }

    // A one-time recovery code is accepted instead of the TOTP code (M4-1).
    await this.verifySecondFactor(
      user.userId,
      code,
      scope === "ops_console" ? "ops_console_login" : "customer_login"
    );
  }

  private async getRequiredUser(userId: string): Promise<IdentityUser> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new IdentityError("USER_NOT_FOUND", `User ${userId} not found`);
    }

    return user;
  }

  private async assertUniqueEmail(
    repository: IdentityRepository,
    email: string | undefined,
    currentUserId: string
  ): Promise<void> {
    if (!email) {
      return;
    }

    const existing = await repository.getUserByEmail(email);
    if (existing && existing.userId !== currentUserId) {
      throw new IdentityError("USER_ALREADY_EXISTS", `Email ${email} is already registered`);
    }
  }

  private async requireUser(
    repository: IdentityRepository,
    userId: string
  ): Promise<IdentityUser> {
    const user = await repository.findUserById(userId);
    if (!user) {
      throw new IdentityError("USER_NOT_FOUND", `User ${userId} not found`);
    }

    return user;
  }

  private async getRequiredSession(
    token: string,
    scope: IdentitySessionScope
  ): Promise<OpsSessionRecord> {
    const tokenHash = hashToken(token);
    const session = await this.repository.findSessionByTokenHash(tokenHash);
    if (!session || session.scope !== scope) {
      throw new IdentityError(
        scope === "ops_console" ? "OPS_SESSION_NOT_FOUND" : "CUSTOMER_SESSION_NOT_FOUND",
        `${scope} session was not found`
      );
    }

    return session;
  }

  private async getRequiredActiveSession(
    token: string,
    scope: IdentitySessionScope
  ): Promise<OpsSessionRecord> {
    const session = await this.getRequiredSession(token, scope);
    const now = this.now().toISOString();

    if (scope === "ops_console" && session.userType !== "ops") {
      throw new IdentityError("OPS_ACCESS_DENIED", `User ${session.userId} is not an ops user`);
    }

    if (scope === "customer_web" && session.userType !== "customer") {
      throw new IdentityError(
        "CUSTOMER_SESSION_NOT_FOUND",
        `Customer session for user ${session.userId} was not found`
      );
    }

    if (session.status !== "active") {
      throw new IdentityError("USER_NOT_ACTIVE", `User ${session.userId} is not active`);
    }

    if (session.revokedAt) {
      throw new IdentityError(
        scope === "ops_console" ? "OPS_SESSION_REVOKED" : "CUSTOMER_SESSION_REVOKED",
        `${scope} session has been revoked`
      );
    }

    if (session.expiresAt <= now) {
      throw new IdentityError(
        scope === "ops_console" ? "OPS_SESSION_EXPIRED" : "CUSTOMER_SESSION_EXPIRED",
        `${scope} session has expired`
      );
    }

    return session;
  }
}

interface CreatedSession extends IdentitySessionInfo {
  token: string;
  device?: SessionDeviceInfo;
}

function mapTwoFactorStatus(
  user: IdentityUser,
  profile: TwoFactorProfile | null,
  defaultLabel: string,
  defaultIssuer: string,
  recoveryCodesRemaining: number
): TwoFactorStatus {
  return {
    userId: user.userId,
    enabled: profile?.enabled ?? false,
    pendingEnrollment: Boolean(profile?.pendingSecret),
    issuer: profile?.issuer ?? defaultIssuer,
    label: profile?.label ?? defaultLabel,
    enabledAt: profile?.enabledAt,
    changedAt: profile?.changedAt,
    recoveryCodesRemaining: profile?.enabled ? recoveryCodesRemaining : 0,
    createdAt: profile?.createdAt ?? user.createdAt,
    updatedAt: profile?.updatedAt ?? user.updatedAt
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapSessionInfo(session: OpsSessionRecord, now: string): IdentitySessionInfo {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    status: session.status,
    userType: session.userType,
    scope: session.scope,
    roles: session.roles,
    permissions: session.permissions,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    active: !session.revokedAt && Date.parse(session.expiresAt) > Date.parse(now)
  };
}

function shouldTouchSession(lastSeenAt: string, now: string): boolean {
  return Date.parse(now) - Date.parse(lastSeenAt) >= 60_000;
}
