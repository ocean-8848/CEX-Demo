import type { ApiKeyScope } from "./api-key-secret.js";
import type { KycRequestStatus, KycTier, VerifiedKycTier } from "./kyc.js";

export type { KycRequestStatus, KycTier, VerifiedKycTier } from "./kyc.js";

export type IdentityUserStatus = "active" | "suspended" | "disabled";
export type IdentityUserType = "customer" | "ops";
export type IdentityOpsRole =
  | "ops_admin"
  | "ops_reviewer"
  | "ops_finance_operator"
  | "ops_risk_operator"
  | "ops_platform_operator"
  | "ops_observer";
export type IdentityOpsPermission =
  | "ops.dashboard.read"
  | "ops.withdrawals.read"
  | "ops.withdrawals.review"
  | "ops.withdrawals.batch_review"
  | "ops.users.read"
  | "ops.users.manage"
  | "ops.users.freeze"
  | "ops.assets.read"
  | "ops.ledger.manage"
  | "ops.ledger.read"
  | "ops.ledger.execute"
  | "ops.deposits.read"
  | "ops.notifications.read"
  | "ops.notifications.manage"
  | "ops.indexer.manage"
  | "ops.indexer.read"
  | "ops.indexer.execute"
  | "ops.indexer.pending.manage"
  | "ops.custody.read"
  | "ops.providers.manage"
  | "ops.address_book.read"
  | "ops.address_book.manage"
  | "ops.audit.read"
  | "ops.alerts.read"
  | "ops.markets.read"
  | "ops.markets.manage"
  | "ops.risk.read"
  | "ops.risk.manage"
  | "ops.controls.manage";
export type IdentitySessionScope = "ops_console" | "customer_web";
export type IdentityApiKeyStatus = "active" | "revoked";

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateUserCommand {
  userId: string;
  email?: string;
  displayName?: string;
  status?: IdentityUserStatus;
  statusReason?: string;
  userType?: IdentityUserType;
  password?: string;
  roles?: IdentityOpsRole[];
}

export interface IdentityUser {
  userId: string;
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  statusReason?: string;
  userType: IdentityUserType;
  roles: IdentityOpsRole[];
  twoFactorEnabled: boolean;
  kycTier: KycTier;
  kycTierUpdatedAt?: string;
  statusUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityUserCredential {
  userId: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListUsersQuery {
  userId?: string;
  email?: string;
  status?: IdentityUserStatus;
  userType?: IdentityUserType;
  role?: IdentityOpsRole;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TwoFactorProfile {
  userId: string;
  enabled: boolean;
  issuer: string;
  label: string;
  pendingSecret?: string;
  secret?: string;
  enabledAt?: string;
  lastVerifiedCounter?: number;
  /** Last enable / disable; drives the wallet withdrawal cooldown (M5-2). */
  changedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TwoFactorStatus {
  userId: string;
  enabled: boolean;
  pendingEnrollment: boolean;
  issuer: string;
  label: string;
  enabledAt?: string;
  changedAt?: string;
  recoveryCodesRemaining: number;
  createdAt: string;
  updatedAt: string;
}

/** Returned once by enable / regenerate; codes are stored hashed only. */
export interface TwoFactorStatusWithRecoveryCodes extends TwoFactorStatus {
  recoveryCodes: string[];
}

export interface DisableTwoFactorCommand {
  userId: string;
  /** Current TOTP code or an unused recovery code. */
  code: string;
}

export interface RegenerateRecoveryCodesCommand {
  userId: string;
  /** Current TOTP code. */
  code: string;
}

export interface RecoveryCodeRecord {
  userId: string;
  codeHash: string;
  createdAt: string;
  usedAt?: string;
}

export interface KycRequestRecord {
  requestId: string;
  userId: string;
  requestedTier: VerifiedKycTier;
  fullName: string;
  idNumberMasked: string;
  status: KycRequestStatus;
  approvedTier?: VerifiedKycTier;
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
  reviewedAt?: string;
  /** Joined from identity_users for list views. */
  email?: string;
  displayName?: string;
  currentTier?: KycTier;
}

export interface KycEventRecord {
  eventId: string;
  userId: string;
  fromTier: KycTier;
  toTier: KycTier;
  action: "request_approved" | "request_rejected" | "tier_adjusted";
  requestId?: string;
  actorId?: string;
  reason?: string;
  createdAt: string;
}

export interface KycProfile {
  userId: string;
  tier: KycTier;
  tierUpdatedAt?: string;
  pendingRequest?: KycRequestRecord;
  latestRequest?: KycRequestRecord;
  events: KycEventRecord[];
}

export interface SubmitKycRequestCommand {
  userId: string;
  requestedTier: unknown;
  fullName: unknown;
  idNumber: unknown;
}

export interface ListKycRequestsQuery {
  userId?: string;
  status?: KycRequestStatus;
  limit?: number;
  offset?: number;
}

export interface ReviewKycRequestCommand {
  requestId: string;
  reviewedBy?: string;
  /** approve only: tier to grant (defaults to the requested tier). */
  tier?: unknown;
  note?: string;
}

export interface SetKycTierCommand {
  userId: string;
  tier: unknown;
  actorId?: string;
  reason?: string;
}

export interface EnrollTwoFactorCommand {
  userId: string;
  issuer?: string;
  label?: string;
}

export interface TwoFactorEnrollment {
  userId: string;
  secret: string;
  otpauthUri: string;
  issuer: string;
  label: string;
  enrolledAt: string;
}

export interface EnableTwoFactorCommand {
  userId: string;
  code: string;
}

export interface VerifyTwoFactorCommand {
  userId: string;
  code: string;
  purpose?: string;
}

export interface TwoFactorVerificationResult {
  verified: true;
  userId: string;
  verifiedAt: string;
  purpose?: string;
}

export interface CreateOpsSessionCommand {
  email: string;
  password: string;
  twoFactorCode?: string;
  userAgent?: string;
  ipAddress?: string;
  /** Long-lived client device id (login security / new-device detection). */
  deviceId?: string;
}

export interface RegisterCustomerCommand {
  email: string;
  password: string;
  displayName?: string;
}

export interface CreateCustomerSessionCommand {
  email: string;
  password: string;
  twoFactorCode?: string;
  userAgent?: string;
  ipAddress?: string;
  /** Long-lived client device id (trader-web localStorage). */
  deviceId?: string;
}

/** Device facts returned with a new session. */
export interface SessionDeviceInfo {
  deviceId: string;
  deviceLabel: string;
  isNewDevice: boolean;
}

export interface PersistedOpsSession {
  sessionId: string;
  userId: string;
  tokenHash: string;
  scope: IdentitySessionScope;
  roles: IdentityOpsRole[];
  permissions: IdentityOpsPermission[];
  userAgent?: string;
  ipAddress?: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface OpsSessionRecord extends PersistedOpsSession {
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  userType: IdentityUserType;
}

export interface IdentitySessionInfo {
  sessionId: string;
  userId: string;
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  userType: IdentityUserType;
  scope: IdentitySessionScope;
  roles: IdentityOpsRole[];
  permissions: IdentityOpsPermission[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  active: boolean;
}

export interface OpsSessionInfo {
  sessionId: string;
  userId: string;
  email?: string;
  displayName?: string;
  status: IdentityUserStatus;
  roles: IdentityOpsRole[];
  permissions: IdentityOpsPermission[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  active: boolean;
}

export interface CreatedOpsSession extends OpsSessionInfo {
  token: string;
  device?: SessionDeviceInfo;
}

export interface CustomerSessionInfo extends IdentitySessionInfo {
  scope: "customer_web";
}

export interface CreatedCustomerSession extends CustomerSessionInfo {
  token: string;
  device?: SessionDeviceInfo;
}

export interface CreateApiKeyCommand {
  userId: string;
  label: string;
  scopes?: string[];
  expiresAt?: string;
  createdBy?: string;
}

export interface IdentityApiKey {
  apiKeyId: string;
  userId: string;
  label: string;
  /** Public identifier sent as X-API-Key. Legacy keys created before M2-4 have none. */
  keyId?: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  status: IdentityApiKeyStatus;
  createdBy?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface PersistedIdentityApiKey extends IdentityApiKey {
  tokenHash: string;
  secretCiphertext?: string;
}

export interface VerifyApiKeySignatureCommand {
  keyId: string;
  /** METHOD\nURL\nTIMESTAMP\nNONCE\nSHA256(body), built by the gateway. */
  canonicalRequest: string;
  signature: string;
}

export interface CreatedIdentityApiKey extends IdentityApiKey {
  secret: string;
}

export interface ApiKeyAuthInfo {
  apiKeyId: string;
  userId: string;
  email?: string;
  displayName?: string;
  userStatus: IdentityUserStatus;
  userType: IdentityUserType;
  label: string;
  keyId?: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  apiKeyStatus: IdentityApiKeyStatus;
  createdBy?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface FreezeUserCommand {
  userId: string;
  reason?: string;
}

export interface UnfreezeUserCommand {
  userId: string;
}
