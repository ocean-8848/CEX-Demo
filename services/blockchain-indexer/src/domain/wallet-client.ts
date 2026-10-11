import type { Network } from "@web3-cex/domain";

import type {
  DepositWatchAddress,
  WalletConfirmDepositCommand,
  WalletConfirmWithdrawalCommand,
  WithdrawalWatchTransaction
} from "./types.js";

export interface WalletClient {
  confirmDeposit(
    command: WalletConfirmDepositCommand
  ): Promise<{ depositId: string; status: string }>;
  confirmWithdrawal(
    command: WalletConfirmWithdrawalCommand
  ): Promise<{ withdrawalId: string; status: string }>;
  listDepositAddresses(query: {
    network: Network;
    limit?: number;
    offset?: number;
  }): Promise<{ items: DepositWatchAddress[]; total: number }>;
  listBroadcastedWithdrawals(query: {
    network: Network;
    limit?: number;
    offset?: number;
  }): Promise<{ items: WithdrawalWatchTransaction[]; total: number }>;
}
