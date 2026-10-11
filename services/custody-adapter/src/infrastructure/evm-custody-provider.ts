import type { AssetCode, Network } from "@web3-cex/domain";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  parseUnits,
  type Hex
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

import { CustodyError } from "../domain/errors.js";
import type { CustodyProvider } from "../domain/provider.js";
import type {
  CustodyProviderCreateTransferCommand,
  CustodyProviderCreateTransferResult,
  CustodyProviderHealthcheckCommand,
  CustodyProviderHealthcheckResult,
  CustodyProviderTransferStatusCommand,
  CustodyProviderTransferStatusResult
} from "../domain/types.js";
import type {
  EvmHotWalletConfig,
  EvmNetwork,
  EvmTokenContractConfig
} from "./evm-provider-config.js";

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "to",
        type: "address"
      },
      {
        name: "value",
        type: "uint256"
      }
    ],
    outputs: [
      {
        name: "",
        type: "bool"
      }
    ]
  }
] as const;

export class EvmCustodyProvider implements CustodyProvider {
  readonly providerName = "evm-hot-wallet";

  constructor(private readonly config: EvmHotWalletConfig) {}

  supportsNetwork(network: Network): boolean {
    return (
      isEvmNetwork(network) &&
      typeof this.config.rpcUrls[network] === "string" &&
      this.config.rpcUrls[network].length > 0 &&
      (typeof this.config.privateKeys[network] === "string" ||
        typeof this.config.mnemonic === "string")
    );
  }

  async createTransfer(
    command: CustodyProviderCreateTransferCommand
  ): Promise<CustodyProviderCreateTransferResult> {
    const network = assertEvmNetwork(command.network);
    const context = await this.getNetworkContext(network);

    if (!isAddress(command.toAddress)) {
      throw new CustodyError(
        "INVALID_DESTINATION_ADDRESS",
        `Destination address ${command.toAddress} is not a valid EVM address`
      );
    }

    const nativeAssetCode = this.config.nativeAssetCodes[network];
    let txHash: Hex;
    let requestPayload: Record<string, unknown>;

    try {
      if (nativeAssetCode && command.assetCode === nativeAssetCode) {
        const value = parseUnits(command.amount, 18);
        requestPayload = {
          type: "native_transfer",
          from: context.account.address,
          to: command.toAddress,
          value: value.toString()
        };
        txHash = await context.walletClient.sendTransaction({
          account: context.account,
          chain: context.chain,
          to: command.toAddress as Hex,
          value
        });
      } else {
        const token = this.findTokenContract(network, command.assetCode);
        const value = parseUnits(command.amount, token.decimals);
        requestPayload = {
          type: "erc20_transfer",
          from: context.account.address,
          tokenAddress: token.contractAddress,
          to: command.toAddress,
          value: value.toString()
        };
        txHash = await context.walletClient.sendTransaction({
          account: context.account,
          chain: context.chain,
          to: token.contractAddress as Hex,
          data: encodeFunctionData({
            abi: erc20TransferAbi,
            functionName: "transfer",
            args: [command.toAddress as Hex, value]
          })
        });
      }
    } catch (error) {
      throw new CustodyError(
        "PROVIDER_BROADCAST_FAILED",
        error instanceof Error ? error.message : "Failed to broadcast custody transfer"
      );
    }

    return {
      providerName: this.providerName,
      providerTransferId: txHash,
      status: "broadcasted",
      txHash,
      requestPayload,
      responsePayload: {
        txHash
      }
    };
  }

  async getTransferStatus(
    command: CustodyProviderTransferStatusCommand
  ): Promise<CustodyProviderTransferStatusResult> {
    const network = assertEvmNetwork(command.network);
    const txHash = command.txHash ?? command.providerTransferId;

    if (!txHash) {
      throw new CustodyError(
        "PROVIDER_STATUS_SYNC_FAILED",
        `Transfer ${command.custodyTransferId} does not have a provider reference`
      );
    }

    const context = await this.getNetworkContext(network);

    try {
      const receipt = await context.publicClient.getTransactionReceipt({
        hash: txHash as Hex
      });

      return {
        providerName: this.providerName,
        providerTransferId: command.providerTransferId ?? txHash,
        status: receipt.status === "success" ? "confirmed" : "failed",
        txHash,
        errorCode: receipt.status === "reverted" ? "EVM_TX_REVERTED" : undefined,
        errorMessage: receipt.status === "reverted" ? "Transaction reverted on chain" : undefined,
        requestPayload: {
          txHash
        },
        responsePayload: {
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber?.toString(),
          status: receipt.status
        }
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") {
        return {
          providerName: this.providerName,
          providerTransferId: command.providerTransferId ?? txHash,
          status: "broadcasted",
          txHash,
          requestPayload: {
            txHash
          },
          responsePayload: {
            status: "pending"
          }
        };
      }

      throw new CustodyError(
        "PROVIDER_STATUS_SYNC_FAILED",
        error instanceof Error ? error.message : "Failed to sync custody transfer status"
      );
    }
  }

  async checkHealth(
    command: CustodyProviderHealthcheckCommand
  ): Promise<CustodyProviderHealthcheckResult> {
    const network = assertEvmNetwork(command.network);
    const startedAt = Date.now();

    if (!this.supportsNetwork(network)) {
      return {
        providerName: this.providerName,
        network,
        status: "unhealthy",
        errorCode: "PROVIDER_NOT_CONFIGURED",
        errorMessage: `No RPC URL or signing account configured for ${network}`
      };
    }

    try {
      const context = await this.getNetworkContext(network);
      const blockNumber = await context.publicClient.getBlockNumber();

      return {
        providerName: this.providerName,
        network,
        status: "healthy",
        latencyMs: Date.now() - startedAt,
        metadata: {
          chainId: context.chain.id,
          latestBlockNumber: blockNumber.toString(),
          signerAddress: context.account.address
        }
      };
    } catch (error) {
      return {
        providerName: this.providerName,
        network,
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        errorCode: "PROVIDER_HEALTHCHECK_FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Failed to check EVM custody provider health"
      };
    }
  }

  private async getNetworkContext(network: EvmNetwork): Promise<{
    account: ReturnType<typeof privateKeyToAccount> | ReturnType<typeof mnemonicToAccount>;
    chain: ReturnType<typeof defineChain>;
    publicClient: ReturnType<typeof createPublicClient>;
    walletClient: ReturnType<typeof createWalletClient>;
  }> {
    const rpcUrl = this.config.rpcUrls[network];

    if (!rpcUrl) {
      throw new CustodyError(
        "PROVIDER_NOT_CONFIGURED",
        `No EVM RPC URL configured for ${network}`
      );
    }

    const account = this.resolveAccount(network);
    const publicClient = createPublicClient({
      transport: http(rpcUrl)
    });
    const chainId = await publicClient.getChainId();
    const chain = defineChain({
      id: chainId,
      name: network,
      nativeCurrency: {
        name: "Native",
        symbol: "NATIVE",
        decimals: 18
      },
      rpcUrls: {
        default: {
          http: [rpcUrl]
        }
      }
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl)
    });

    return {
      account,
      chain,
      publicClient,
      walletClient
    };
  }

  private resolveAccount(network: EvmNetwork) {
    const privateKey = this.config.privateKeys[network];
    if (privateKey) {
      return privateKeyToAccount(privateKey);
    }

    if (this.config.mnemonic) {
      return mnemonicToAccount(this.config.mnemonic, {
        addressIndex: this.config.accountIndexes[network] ?? 0
      });
    }

    throw new CustodyError(
      "PROVIDER_NOT_CONFIGURED",
      `No private key or mnemonic configured for ${network}`
    );
  }

  private findTokenContract(network: EvmNetwork, assetCode: AssetCode): EvmTokenContractConfig {
    const token = (this.config.tokenContracts[network] ?? []).find(
      (entry) => entry.assetCode === assetCode
    );

    if (!token) {
      throw new CustodyError(
        "PROVIDER_UNSUPPORTED_ASSET",
        `Asset ${assetCode} is not configured for ${network} custody transfers`
      );
    }

    return token;
  }
}

function assertEvmNetwork(network: Network): EvmNetwork {
  if (network === "ethereum" || network === "bsc" || network === "base") {
    return network;
  }

  throw new CustodyError(
    "PROVIDER_UNSUPPORTED_NETWORK",
    `Network ${network} is not supported by the EVM custody provider`
  );
}

function isEvmNetwork(network: Network): network is EvmNetwork {
  return network === "ethereum" || network === "bsc" || network === "base";
}
