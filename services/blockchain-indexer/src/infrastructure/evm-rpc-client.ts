import { BlockchainIndexerError } from "../domain/errors.js";
import type {
  EvmBlock,
  EvmClient,
  EvmLog,
  EvmLogFilter,
  EvmTransactionReceipt
} from "../domain/evm-client.js";

interface JsonRpcSuccessResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse;

interface RpcBlock {
  number: string;
  hash: string;
  parentHash: string;
  transactions: Array<{
    hash: string;
    to: string | null;
    value: string;
  }>;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
}

interface RpcTransactionReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status?: string;
}

export class EvmRpcClient implements EvmClient {
  private requestId = 0;

  constructor(private readonly rpcUrl: string) {}

  async getBlockNumber(): Promise<number> {
    return parseHexQuantity(await this.request<string>("eth_blockNumber", []));
  }

  async getBlockByNumber(
    blockNumber: number,
    includeTransactions: boolean
  ): Promise<EvmBlock | null> {
    const result = await this.request<RpcBlock | null>("eth_getBlockByNumber", [
      toBlockTag(blockNumber),
      includeTransactions
    ]);

    if (!result) {
      return null;
    }

    return {
      number: parseHexQuantity(result.number),
      hash: result.hash.toLowerCase(),
      parentHash: result.parentHash.toLowerCase(),
      transactions: result.transactions.map((transaction) => ({
        hash: transaction.hash.toLowerCase(),
        to: transaction.to?.toLowerCase() ?? undefined,
        value: transaction.value
      }))
    };
  }

  async getLogs(filter: EvmLogFilter): Promise<EvmLog[]> {
    const payload = {
      fromBlock: toBlockTag(filter.fromBlock),
      toBlock: toBlockTag(filter.toBlock),
      address: filter.addresses,
      topics: filter.topics
    };

    const result = await this.request<RpcLog[]>("eth_getLogs", [payload]);
    return result.map((entry) => ({
      address: entry.address.toLowerCase(),
      topics: entry.topics.map((topic) => topic.toLowerCase()),
      data: entry.data.toLowerCase(),
      transactionHash: entry.transactionHash.toLowerCase(),
      blockNumber: parseHexQuantity(entry.blockNumber),
      blockHash: entry.blockHash.toLowerCase()
    }));
  }

  async getTransactionReceipt(txHash: string): Promise<EvmTransactionReceipt | null> {
    const result = await this.request<RpcTransactionReceipt | null>("eth_getTransactionReceipt", [
      txHash
    ]);

    if (!result) {
      return null;
    }

    return {
      transactionHash: result.transactionHash.toLowerCase(),
      blockNumber: parseHexQuantity(result.blockNumber),
      blockHash: result.blockHash.toLowerCase(),
      status: result.status ? parseHexQuantity(result.status) : undefined
    };
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method,
        params
      })
    }).catch((error) => {
      throw new BlockchainIndexerError(
        "EVM_RPC_FAILED",
        `Failed to call ${method} on ${this.rpcUrl}: ${
          error instanceof Error ? error.message : "unknown network error"
        }`
      );
    });

    if (!response.ok) {
      throw new BlockchainIndexerError(
        "EVM_RPC_FAILED",
        `EVM RPC ${method} failed with HTTP ${response.status}`
      );
    }

    const payload = (await response.json()) as JsonRpcResponse<T>;
    if ("error" in payload) {
      throw new BlockchainIndexerError(
        "EVM_RPC_FAILED",
        `EVM RPC ${method} failed: ${payload.error.message}`
      );
    }

    return payload.result;
  }
}

function toBlockTag(blockNumber: number): string {
  return `0x${blockNumber.toString(16)}`;
}

function parseHexQuantity(value: string): number {
  return Number(BigInt(value));
}
