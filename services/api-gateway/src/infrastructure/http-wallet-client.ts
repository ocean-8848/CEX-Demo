import { ApiGatewayError } from "../domain/errors.js";
import type { PagedResult, WalletGatewayClient } from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpWalletClient implements WalletGatewayClient {
  constructor(private readonly baseUrl: string) {}

  async createDepositAddress(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: string;
    network: string;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/wallet/deposit-addresses", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listDepositAddresses(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: string;
    network?: string;
    status?: "active" | "disabled";
    address?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/deposit-addresses?${toQuery(query)}`);
  }

  async listDeposits(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: string;
    network?: string;
    status?: string;
    txHash?: string;
    address?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/deposits?${toQuery(query)}`);
  }

  async getDeposit(depositId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/deposits/${depositId}`);
  }

  async getProofOfReserves(userId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/treasury/proof-of-reserves/me?${toQuery({ userId })}`);
  }

  async getWithdrawalLimits(userId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawal-limits?${toQuery({ userId })}`);
  }

  async listWithdrawals(query: {
    userId: string;
    ledgerAccountId?: string;
    assetCode?: string;
    network?: string;
    status?: string;
    reviewStatus?: string;
    txHash?: string;
    toAddress?: string;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/withdrawals?${toQuery(query)}`);
  }

  async getWithdrawal(withdrawalId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawals/${withdrawalId}`);
  }

  async validateWithdrawal(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: string;
    network: string;
    toAddress: string;
    amount: string;
    fee: string;
    twoFactorCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/wallet/withdrawals/validate", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async requestWithdrawal(command: {
    userId: string;
    ledgerAccountId: string;
    assetCode: string;
    network: string;
    toAddress: string;
    amount: string;
    fee: string;
    twoFactorCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/wallet/withdrawals/request", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listWithdrawalAddressBookEntries(query: {
    userId: string;
    network?: string;
    address?: string;
    isWhitelisted?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/withdrawal-address-book?${toQuery(query)}`);
  }

  async createWithdrawalAddressBookEntry(command: {
    userId: string;
    network: string;
    address: string;
    label: string;
    isWhitelisted?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/v1/wallet/withdrawal-address-book", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async listWalletNotifications(query: {
    userId: string;
    withdrawalId?: string;
    depositId?: string;
    eventType?: string;
    status?: string;
    channel?: string;
    readState?: "read" | "unread";
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/notifications?${toQuery(query)}`);
  }

  async countUnreadWalletNotifications(userId: string): Promise<{ unreadCount: number }> {
    return this.fetchJson(`/api/v1/wallet/notifications/unread-count?${toQuery({ userId })}`);
  }

  async markWalletNotificationsRead(command: {
    userId: string;
    notificationIds?: string[];
  }): Promise<{ updated: number; readAt: string; unreadCount: number }> {
    return this.fetchJson("/api/v1/wallet/notifications/read", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      body: init?.body,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody: init?.body as Buffer | string | undefined,
        headers: {
          "content-type": "application/json",
          ...((init?.headers ?? {}) as Record<string, string>)
        }
      })
    });

    if (!response.ok) {
      throw await buildUpstreamError(response, "Wallet service");
    }

    return (await response.json()) as T;
  }
}

function toQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
}

async function buildUpstreamError(response: Response, source: string): Promise<ApiGatewayError> {
  const payload = await response.text();
  return new ApiGatewayError(
    "WALLET_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `${source} rejected request: ${payload}`
  );
}
