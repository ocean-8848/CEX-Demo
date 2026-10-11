export class OpsConsoleError extends Error {
  constructor(
    public readonly code:
      | "IDENTITY_UPSTREAM_FAILED"
      | "LEDGER_UPSTREAM_FAILED"
      | "INDEXER_UPSTREAM_FAILED"
      | "WALLET_UPSTREAM_FAILED"
      | "CUSTODY_UPSTREAM_FAILED"
      | "FAULT_LAB_UPSTREAM_FAILED"
      | "VALIDATION_ERROR"
      | "RESOURCE_NOT_FOUND"
      | "OPS_UNAUTHORIZED"
      | "OPS_FORBIDDEN"
      | "RISK_UPSTREAM_FAILED"
      // Business codes passed through from upstream services (e.g. MARKET_DELISTED).
      | (string & {}),
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "OpsConsoleError";
  }
}
