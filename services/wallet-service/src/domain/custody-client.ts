import type { AssetCode, Network } from "@web3-cex/domain";

export interface CustodyCreateTransferCommand {
  withdrawalId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  metadata?: Record<string, unknown>;
}

export interface CustodyClient {
  createTransfer(command: CustodyCreateTransferCommand): Promise<{
    custodyRequestId: string;
    providerName: string;
    txHash: string;
  }>;
}
