import type { AccountType, AssetCode } from "@web3-cex/domain";

import { SettlementServiceError } from "../domain/errors.js";
import type {
  SettlementLedgerAccount,
  SettlementLedgerClient
} from "../domain/ledger-client.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpLedgerClient implements SettlementLedgerClient {
  constructor(private readonly baseUrl: string) {}

  async getAccount(accountId: string): Promise<SettlementLedgerAccount | null> {
    const path = `/api/v1/ledger/accounts/${accountId}`;
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

    if (!response.ok) {
      throw await buildError(response);
    }

    return (await response.json()) as SettlementLedgerAccount;
  }

  async createAccount(command: {
    accountId: string;
    userId?: string;
    accountType: AccountType;
  }): Promise<SettlementLedgerAccount> {
    const path = "/api/v1/ledger/accounts";
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
      throw await buildError(response);
    }

    return (await response.json()) as SettlementLedgerAccount;
  }

  async consumeBalance(command: {
    accountId: string;
    assetCode: AssetCode;
    referenceType: string;
    referenceId: string;
    amount: string;
    settlementAccountId: string;
    businessId: string;
    traceId: string;
    description: string;
  }): Promise<Record<string, unknown>> {
    const path = "/api/v1/ledger/balances/consume";
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
      throw await buildError(response);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  async postJournal(command: {
    businessType: string;
    businessId: string;
    idempotencyKey: string;
    traceId: string;
    description: string;
    entries: Array<{
      accountId: string;
      assetCode: AssetCode;
      direction: "debit" | "credit";
      amount: string;
      referenceType: string;
      referenceId: string;
    }>;
  }): Promise<{ journalId: string }> {
    const path = "/api/v1/ledger/journals";
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
      throw await buildError(response);
    }

    return (await response.json()) as { journalId: string };
  }
}

async function buildError(response: Response): Promise<SettlementServiceError> {
  const payload = await response.text();
  return new SettlementServiceError(
    "LEDGER_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Ledger service rejected request: ${payload}`
  );
}
