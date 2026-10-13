export interface IdentityTwoFactorStatus {
  userId: string;
  enabled: boolean;
  pendingEnrollment: boolean;
  enabledAt?: string;
  /** Last enable / disable time, used by the security cooldown (M5-2). */
  changedAt?: string;
}

export interface IdentityKycProfile {
  userId: string;
  tier: string;
  tierUpdatedAt?: string;
}

/** Login security facts used by the optional new-device withdrawal lock. */
export interface IdentityLoginSecuritySummary {
  userId: string;
  lastNewDeviceLoginAt?: string;
}

export interface VerifyIdentityTwoFactorCommand {
  userId: string;
  code: string;
  purpose?: string;
}

export interface IdentityClient {
  getTwoFactorStatus(userId: string): Promise<IdentityTwoFactorStatus>;
  getKycProfile(userId: string): Promise<IdentityKycProfile>;
  /** Optional: only called when WITHDRAWAL_NEW_DEVICE_LOCK_SECONDS > 0. */
  getLoginSecuritySummary?(userId: string): Promise<IdentityLoginSecuritySummary>;
  verifyTwoFactor(command: VerifyIdentityTwoFactorCommand): Promise<{
    verifiedAt: string;
    purpose?: string;
  }>;
}
