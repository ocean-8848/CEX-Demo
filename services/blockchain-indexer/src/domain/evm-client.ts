import type { Network } from "@web3-cex/domain";

export type EvmNetwork = Extract<Network, "ethereum" | "bsc" | "base">;

export interface EvmTransaction {
  hash: string;
  to?: string;
  value: string;
}

export interface EvmBlock {
  number: number;
  hash: string;
  parentHash: string;
  transactions: EvmTransaction[];
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
}

export interface EvmTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status?: number;
}

export interface EvmLogFilter {
  fromBlock: number;
  toBlock: number;
  addresses?: string[];
  topics?: Array<string | string[] | null>;
}

export interface EvmClient {
  getBlockNumber(): Promise<number>;
  getBlockByNumber(blockNumber: number, includeTransactions: boolean): Promise<EvmBlock | null>;
  getLogs(filter: EvmLogFilter): Promise<EvmLog[]>;
  getTransactionReceipt(txHash: string): Promise<EvmTransactionReceipt | null>;
}
