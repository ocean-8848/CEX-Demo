export type TreasuryErrorCode =
  | "TREASURY_TRANSFER_NOT_FOUND"
  | "TREASURY_INVALID_STATE"
  | "TREASURY_SAME_APPROVER"
  | "TREASURY_INVALID_REQUEST"
  | "TREASURY_INSUFFICIENT_BALANCE"
  | "TREASURY_UPSTREAM_FAILED"
  | "POR_SNAPSHOT_NOT_FOUND";

export class TreasuryError extends Error {
  constructor(
    public readonly code: TreasuryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TreasuryError";
  }
}

export function treasuryErrorStatus(code: TreasuryErrorCode): number {
  switch (code) {
    case "TREASURY_TRANSFER_NOT_FOUND":
    case "POR_SNAPSHOT_NOT_FOUND":
      return 404;
    case "TREASURY_INVALID_STATE":
    case "TREASURY_SAME_APPROVER":
    case "TREASURY_INSUFFICIENT_BALANCE":
      return 409;
    case "TREASURY_INVALID_REQUEST":
      return 400;
    case "TREASURY_UPSTREAM_FAILED":
      return 502;
    default:
      return 500;
  }
}
