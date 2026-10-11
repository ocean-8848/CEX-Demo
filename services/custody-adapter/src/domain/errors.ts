export class CustodyError extends Error {
  constructor(
    public readonly code:
      | "INVALID_AMOUNT"
      | "INVALID_DESTINATION_ADDRESS"
      | "TRANSFER_NOT_FOUND"
      | "TRANSFER_ALREADY_FINALIZED"
      | "TRANSFER_RETRY_NOT_ALLOWED"
      | "PROVIDER_NOT_CONFIGURED"
      | "PROVIDER_ROUTE_UNAVAILABLE"
      | "PROVIDER_UNSUPPORTED_NETWORK"
      | "PROVIDER_UNSUPPORTED_ASSET"
      | "PROVIDER_BROADCAST_FAILED"
      | "PROVIDER_HEALTHCHECK_FAILED"
      | "PROVIDER_STATUS_SYNC_FAILED"
      | "FAULT_LAB_DISABLED"
      | "FAULT_LAB_INVALID_TARGET",
    message: string
  ) {
    super(message);
    this.name = "CustodyError";
  }
}
