import type { AssetCode, Network } from "@web3-cex/domain";
import type { EvmNetwork } from "./evm-client.js";

export type IndexedDepositStatus = "detected" | "confirming" | "credited" | "closed";
export type IndexedWithdrawalStatus = "detected" | "confirming" | "confirmed";
export type ObservationType = "deposit" | "withdrawal";
export type DepositManualAction = "replayed" | "closed";

export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DepositWatchAddress {
  address: string;
  assetCode: AssetCode;
}

export interface WithdrawalWatchTransaction {
  txHash: string;
  assetCode: AssetCode;
}

export interface EvmTokenContractConfig {
  assetCode: AssetCode;
  contractAddress: string;
  decimals: number;
}

export interface ObserveDepositCommand {
  network: Network;
  assetCode: AssetCode;
  address: string;
  txHash: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface IndexedDepositObservation {
  observationId: string;
  network: Network;
  assetCode: AssetCode;
  address: string;
  txHash: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
  status: IndexedDepositStatus;
  walletDepositId?: string;
  reorgDetectedAt?: string;
  reorgedFromBlockNumber?: number;
  lastManualAction?: DepositManualAction;
  lastManualActionAt?: string;
  lastManualActionBy?: string;
  lastManualActionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletConfirmDepositCommand {
  network: Network;
  txHash: string;
  address: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface ObserveWithdrawalCommand {
  network: Network;
  assetCode: AssetCode;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface IndexedWithdrawalObservation {
  observationId: string;
  network: Network;
  assetCode: AssetCode;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
  status: IndexedWithdrawalStatus;
  walletWithdrawalId?: string;
  reorgDetectedAt?: string;
  reorgedFromBlockNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletConfirmWithdrawalCommand {
  network: Network;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface ScanCursor {
  cursorId: string;
  observationType: ObservationType;
  network: Network;
  lastScannedBlock?: number;
  lastFinalizedBlock?: number;
  reorgDetectedAt?: string;
  reorgDetectedBlock?: number;
  updatedAt: string;
}

export interface ScanEvmDepositsCommand {
  network: EvmNetwork;
  fromBlock?: number;
  toBlock?: number;
  rpcUrl?: string;
  watchAddresses?: DepositWatchAddress[];
  nativeAssetCode?: AssetCode;
  tokenContracts?: EvmTokenContractConfig[];
}

export interface ScanEvmWithdrawalsCommand {
  network: EvmNetwork;
  rpcUrl?: string;
  trackedWithdrawals?: WithdrawalWatchTransaction[];
}

export interface EvmDepositScanResult {
  network: EvmNetwork;
  headBlock: number;
  fromBlock?: number;
  toBlock?: number;
  scannedBlockCount: number;
  matchedObservationCount: number;
  rolledBackObservationCount: number;
  reorgDetected: boolean;
  reorgDetectedBlock?: number;
  cursor: ScanCursor;
}

export interface EvmWithdrawalScanResult {
  network: EvmNetwork;
  headBlock: number;
  trackedTransactionCount: number;
  matchedObservationCount: number;
  rolledBackObservationCount: number;
  reorgDetected: boolean;
  reorgDetectedBlock?: number;
  cursor: ScanCursor;
}

export interface ListDepositObservationsQuery {
  network?: Network;
  assetCode?: AssetCode;
  status?: IndexedDepositStatus | "pending";
  olderThanSeconds?: number;
  limit?: number;
  offset?: number;
}

export interface ReplayDepositObservationCommand {
  observationId: string;
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  operatedBy?: string;
  note?: string;
}

export interface CloseDepositObservationCommand {
  observationId: string;
  operatedBy?: string;
  note?: string;
}
