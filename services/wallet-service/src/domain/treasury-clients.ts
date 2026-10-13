import type { AssetCode, Network } from "@web3-cex/domain";

/** custody-adapter: signs and broadcasts internal treasury transfers. */
export interface TreasuryCustodyClient {
  broadcastInternalTransfer(command: {
    transferId: string;
    /** 1 for the first broadcast; a retry after a failure uses a fresh custody idempotency key. */
    attempt: number;
    assetCode: AssetCode;
    network: Network;
    fromAddress?: string;
    toAddress: string;
    amount: string;
    metadata: Record<string, unknown>;
  }): Promise<{ custodyTransferId: string; providerName: string; txHash?: string; status: string }>;
}

/** ledger-service: customer liabilities (user-owned accounts). */
export interface TreasuryLedgerClient {
  getLiabilitySummary(): Promise<{
    generatedAt: string;
    userCount: number;
    assets: Array<{ assetCode: AssetCode; total: string; available: string; locked: string; userCount: number }>;
  }>;
  listUserLiabilities(): Promise<{
    generatedAt: string;
    items: Array<{ userId: string; balances: Record<AssetCode, string> }>;
  }>;
}
