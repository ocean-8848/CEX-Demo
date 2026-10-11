export class BlockchainIndexerError extends Error {
  constructor(
    public readonly code:
      | "EVM_RPC_FAILED"
      | "EVM_RPC_NOT_CONFIGURED"
      | "INVALID_CONFIRMATION_COUNT"
      | "INVALID_AMOUNT"
      | "INVALID_BLOCK_RANGE"
      | "INVALID_SCAN_RANGE"
      | "OBSERVATION_NOT_FOUND"
      | "OBSERVATION_ALREADY_FINALIZED"
      | "UNSUPPORTED_NETWORK"
      | "WALLET_CONFIRM_FAILED"
      | "WALLET_QUERY_FAILED",
    message: string
  ) {
    super(message);
    this.name = "BlockchainIndexerError";
  }
}
