import { BlockchainIndexerError } from "../domain/errors.js";
import type {
  DepositWatchAddress,
  WalletConfirmDepositCommand,
  WalletConfirmWithdrawalCommand,
  WithdrawalWatchTransaction
} from "../domain/types.js";
import type { WalletClient } from "../domain/wallet-client.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

interface WalletDepositResponse {
  depositId: string;
  status: string;
}

interface WalletWithdrawalResponse {
  withdrawalId: string;
  status: string;
}

interface WalletPagedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface WalletDepositAddressResponse {
  assetCode: DepositWatchAddress["assetCode"];
  address: string;
}

interface WalletListWithdrawalResponse {
  assetCode: WithdrawalWatchTransaction["assetCode"];
  txHash?: string;
}

export class HttpWalletClient implements WalletClient {
  constructor(private readonly baseUrl: string) {}

  async confirmDeposit(
    command: WalletConfirmDepositCommand
  ): Promise<{ depositId: string; status: string }> {
    const path = "/api/v1/wallet/deposits/confirm";
    const body = JSON.stringify(command);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: {
          "content-type": "application/json"
        }
      }),
      body
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new BlockchainIndexerError(
        "WALLET_CONFIRM_FAILED",
        `Wallet service rejected deposit confirmation: ${payload}`
      );
    }

    return (await response.json()) as WalletDepositResponse;
  }

  async confirmWithdrawal(
    command: WalletConfirmWithdrawalCommand
  ): Promise<{ withdrawalId: string; status: string }> {
    const path = "/api/v1/wallet/withdrawals/confirm";
    const body = JSON.stringify(command);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: {
          "content-type": "application/json"
        }
      }),
      body
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new BlockchainIndexerError(
        "WALLET_CONFIRM_FAILED",
        `Wallet service rejected withdrawal confirmation: ${payload}`
      );
    }

    return (await response.json()) as WalletWithdrawalResponse;
  }

  async listDepositAddresses(query: {
    network: WalletConfirmDepositCommand["network"];
    limit?: number;
    offset?: number;
  }): Promise<{ items: DepositWatchAddress[]; total: number }> {
    const path = `/api/v1/wallet/deposit-addresses?${buildQueryString({
      network: query.network,
      limit: query.limit,
      offset: query.offset
    })}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new BlockchainIndexerError(
        "WALLET_QUERY_FAILED",
        `Wallet service rejected deposit address query: ${payload}`
      );
    }

    const payload = (await response.json()) as WalletPagedResponse<WalletDepositAddressResponse>;
    return {
      items: payload.items.map((item) => ({
        assetCode: item.assetCode,
        address: item.address
      })),
      total: payload.total
    };
  }

  async listBroadcastedWithdrawals(query: {
    network: WalletConfirmDepositCommand["network"];
    limit?: number;
    offset?: number;
  }): Promise<{ items: WithdrawalWatchTransaction[]; total: number }> {
    const path = `/api/v1/wallet/withdrawals?${buildQueryString({
      network: query.network,
      status: "broadcasted",
      limit: query.limit,
      offset: query.offset
    })}`;
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        headers: buildInternalServiceHeaders({
          method: "GET",
          path,
          headers: {
            "content-type": "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new BlockchainIndexerError(
        "WALLET_QUERY_FAILED",
        `Wallet service rejected withdrawal query: ${payload}`
      );
    }

    const payload = (await response.json()) as WalletPagedResponse<WalletListWithdrawalResponse>;
    return {
      items: payload.items
        .filter((item): item is WalletListWithdrawalResponse & { txHash: string } =>
          typeof item.txHash === "string" && item.txHash.length > 0
        )
        .map((item) => ({
          assetCode: item.assetCode,
          txHash: item.txHash
        })),
      total: payload.total
    };
  }
}

function buildQueryString(
  query: Record<string, string | number | undefined>
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    search.set(key, String(value));
  }

  return search.toString();
}
