export interface CreateUserRequestDto {
  userId: string;
  email?: string;
  displayName?: string;
  status?: "active" | "suspended" | "disabled";
  statusReason?: string;
  userType?: "customer" | "ops";
  password?: string;
  roles?: (
    | "ops_admin"
    | "ops_reviewer"
    | "ops_finance_operator"
    | "ops_risk_operator"
    | "ops_platform_operator"
    | "ops_observer"
  )[];
}

export interface RegisterCustomerRequestDto {
  email: string;
  password: string;
  displayName?: string;
}

export interface ListUsersQueryDto {
  userId?: string;
  email?: string;
  status?: "active" | "suspended" | "disabled";
  userType?: "customer" | "ops";
  role?:
    | "ops_admin"
    | "ops_reviewer"
    | "ops_finance_operator"
    | "ops_risk_operator"
    | "ops_platform_operator"
    | "ops_observer";
  search?: string;
  limit?: string;
  offset?: string;
}

export interface EnrollTwoFactorRequestDto {
  issuer?: string;
  label?: string;
}

export interface EnableTwoFactorRequestDto {
  code: string;
}

export interface VerifyTwoFactorRequestDto {
  code: string;
  purpose?: string;
}

export interface CreateOpsSessionRequestDto {
  email: string;
  password: string;
  twoFactorCode?: string;
}

export interface CreateCustomerSessionRequestDto {
  email: string;
  password: string;
  twoFactorCode?: string;
}

export interface CreateApiKeyRequestDto {
  label: string;
  scopes?: string[];
  expiresAt?: string;
  createdBy?: string;
}

export interface VerifyApiKeySignatureRequestDto {
  keyId: string;
  canonicalRequest: string;
  signature: string;
}

export interface FreezeUserRequestDto {
  reason?: string;
}

export interface DisableTwoFactorRequestDto {
  code: string;
}

export interface RegenerateRecoveryCodesRequestDto {
  code: string;
}

export interface SubmitKycRequestDto {
  requestedTier: string;
  fullName: string;
  idNumber: string;
}

export interface ListKycRequestsQueryDto {
  userId?: string;
  status?: "pending" | "approved" | "rejected";
  limit?: string;
  offset?: string;
}

export interface ReviewKycRequestDto {
  reviewedBy?: string;
  tier?: string;
  note?: string;
}

export interface SetKycTierRequestDto {
  tier: string;
  actorId?: string;
  reason?: string;
}
