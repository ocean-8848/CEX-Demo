import type { AssetCode, Network } from "@web3-cex/domain";

import type { EvmNetwork } from "../domain/evm-client.js";
import type {
  IndexedDepositStatus,
  ObservationType
} from "../domain/types.js";

export interface ObserveDepositRequestDto {
  network: Network;
  assetCode: AssetCode;
  address: string;
  txHash: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface ObserveWithdrawalRequestDto {
  network: Network;
  assetCode: AssetCode;
  txHash: string;
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
}

export interface ScanEvmDepositWatchAddressDto {
  address: string;
  assetCode: AssetCode;
}

export interface ScanEvmTokenContractDto {
  assetCode: AssetCode;
  contractAddress: string;
  decimals: number;
}

export interface ScanEvmDepositsRequestDto {
  network: EvmNetwork;
  fromBlock?: number;
  toBlock?: number;
  rpcUrl?: string;
  watchAddresses?: ScanEvmDepositWatchAddressDto[];
  nativeAssetCode?: AssetCode;
  tokenContracts?: ScanEvmTokenContractDto[];
}

export interface ScanEvmTrackedWithdrawalDto {
  txHash: string;
  assetCode: AssetCode;
}

export interface ScanEvmWithdrawalsRequestDto {
  network: EvmNetwork;
  rpcUrl?: string;
  trackedWithdrawals?: ScanEvmTrackedWithdrawalDto[];
}

export interface GetScanCursorParamsDto {
  observationType: ObservationType;
  network: Network;
}

export interface ReplayEvmRequestDto {
  network: EvmNetwork;
  observationType?: ObservationType | "both";
  fromBlock?: number;
  toBlock?: number;
  rpcUrl?: string;
}

export interface RepairIndexerBacklogRequestDto {
  network: EvmNetwork;
  observationType?: ObservationType | "both";
  lookbackBlocks?: number;
  rpcUrl?: string;
}

export interface ListDepositObservationsQueryDto {
  network?: Network;
  assetCode?: AssetCode;
  status?: IndexedDepositStatus | "pending";
  olderThanSeconds?: string;
  limit?: string;
  offset?: string;
}

export interface ReplayDepositObservationRequestDto {
  confirmations?: number;
  blockNumber?: number;
  blockHash?: string;
  operatedBy?: string;
  note?: string;
}

export interface CloseDepositObservationRequestDto {
  operatedBy?: string;
  note?: string;
}
