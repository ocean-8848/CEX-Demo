import type {
  OpsApproveWithdrawalCommand,
  OpsDepositQuery,
  OpsNotificationQuery,
  OpsRejectWithdrawalCommand,
  OpsReviewQueueQuery,
  OpsWalletNotificationDeliveryCommand,
  OpsWalletStaleWithdrawalRepairCommand,
  OpsWithdrawalQuery,
  OpsWalletClient,
  OpsWithdrawalAddressBookQuery,
  OpsWithdrawalAuditLogQuery,
  PagedResponse
} from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpWalletOpsClient implements OpsWalletClient {
  constructor(private readonly baseUrl: string) {}

  async listDeposits(query: OpsDepositQuery): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/deposits?${buildQueryString(query as QueryValueMap)}`);
  }

  async listWithdrawalReviewQueue(
    query: OpsReviewQueueQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(
      `/api/v1/wallet/withdrawals/review-queue?${buildQueryString(query as QueryValueMap)}`
    );
  }

  async listWithdrawals(
    query: OpsWithdrawalQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/withdrawals?${buildQueryString(query as QueryValueMap)}`);
  }

  async getWithdrawal(withdrawalId: string): Promise<Record<string, unknown> | null> {
    const path = `/api/v1/wallet/withdrawals/${withdrawalId}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });

    if (response.status === 404) {
      return null;
    }

    return this.parseResponse<Record<string, unknown>>(response, "WALLET_UPSTREAM_FAILED");
  }

  async approveWithdrawal(command: OpsApproveWithdrawalCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawals/${command.withdrawalId}/approve`, {
      method: "POST",
      body: JSON.stringify({
        reviewedBy: command.reviewedBy,
        note: command.note
      })
    });
  }

  async rejectWithdrawal(command: OpsRejectWithdrawalCommand): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawals/${command.withdrawalId}/reject`, {
      method: "POST",
      body: JSON.stringify({
        reviewedBy: command.reviewedBy,
        reason: command.reason
      })
    });
  }

  async listWithdrawalAuditLogs(
    withdrawalId: string,
    query: OpsWithdrawalAuditLogQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(
      `/api/v1/wallet/withdrawals/${withdrawalId}/audit-logs?${buildQueryString(query as QueryValueMap)}`
    );
  }

  async searchWithdrawalAuditLogs(
    query: OpsWithdrawalAuditLogQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/audit-logs?${buildQueryString(query as QueryValueMap)}`);
  }

  async listWithdrawalAddressBook(
    query: OpsWithdrawalAddressBookQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(
      `/api/v1/wallet/withdrawal-address-book?${buildQueryString(query as QueryValueMap)}`
    );
  }

  async whitelistWithdrawalAddress(addressBookId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawal-address-book/${addressBookId}/whitelist`, {
      method: "POST"
    });
  }

  async unwhitelistWithdrawalAddress(addressBookId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/withdrawal-address-book/${addressBookId}/unwhitelist`, {
      method: "POST"
    });
  }

  async listNotifications(
    query: OpsNotificationQuery
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.fetchJson(`/api/v1/wallet/notifications?${buildQueryString(query as QueryValueMap)}`);
  }

  async deliverNotifications(
    command: OpsWalletNotificationDeliveryCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/ops/notifications/deliver`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  async reconcileStaleWithdrawals(
    command: OpsWalletStaleWithdrawalRepairCommand
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/v1/wallet/ops/withdrawals/reconcile-stale`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
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

    return this.parseResponse<T>(response, "WALLET_UPSTREAM_FAILED");
  }

  private async parseResponse<T>(
    response: Response,
    code: OpsConsoleError["code"]
  ): Promise<T> {
    if (!response.ok) {
      const payload = await response.text();
      throw new OpsConsoleError(
        code,
        mapUpstreamStatus(response.status),
        `Wallet service rejected request: ${payload}`
      );
    }

    return (await response.json()) as T;
  }
}

type QueryValueMap = Record<string, string | number | boolean | undefined>;

function buildQueryString(query: QueryValueMap): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    search.set(key, String(value));
  }

  return search.toString();
}

function mapUpstreamStatus(status: number): number {
  if (status >= 400 && status < 600) {
    return status;
  }

  return 502;
}
