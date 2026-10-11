export class IdentityError extends Error {
  constructor(
    public readonly code:
      | "USER_NOT_FOUND"
      | "USER_ALREADY_EXISTS"
      | "USER_NOT_ACTIVE"
      | "USER_FREEZE_NOT_ALLOWED"
      | "INVALID_CREDENTIALS"
      | "OPS_ACCESS_DENIED"
      | "OPS_TWO_FACTOR_REQUIRED"
      | "OPS_SESSION_NOT_FOUND"
      | "OPS_SESSION_EXPIRED"
      | "OPS_SESSION_REVOKED"
      | "CUSTOMER_SESSION_NOT_FOUND"
      | "CUSTOMER_SESSION_EXPIRED"
      | "CUSTOMER_SESSION_REVOKED"
      | "TWO_FACTOR_NOT_ENROLLED"
      | "TWO_FACTOR_NOT_ENABLED"
      | "TWO_FACTOR_ALREADY_ENABLED"
      | "TWO_FACTOR_REQUIRED"
      | "TWO_FACTOR_INVALID_CODE"
      | "TWO_FACTOR_CODE_REUSED"
      | "TWO_FACTOR_RECOVERY_CODE_INVALID"
      | "KYC_REQUEST_INVALID"
      | "KYC_REQUEST_PENDING"
      | "KYC_REQUEST_NOT_FOUND"
      | "KYC_REQUEST_ALREADY_REVIEWED"
      | "KYC_NOT_ALLOWED"
      | "INVALID_API_KEY_LABEL"
      | "INVALID_API_KEY_SCOPE"
      | "INVALID_API_KEY_SIGNATURE"
      | "API_KEY_NOT_FOUND"
      | "API_KEY_REVOKED",
    message: string
  ) {
    super(message);
    this.name = "IdentityError";
  }
}
