import { WalletError } from "../domain/errors.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import type {
  LedgerConsumeBalanceCommand,
  LedgerDepositCreditCommand,
  LedgerFreezeBalanceCommand,
  LedgerReleaseBalanceCommand
} from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

interface LedgerJournalResponse {
  journalId: string;
}

interface LedgerFreezeResponse {
  lockId: string;
}

export class HttpLedgerClient implements LedgerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly depositSourceAccountId: string,
    private readonly withdrawalSettlementAccountId: string
  ) {}

  async postDepositCredit(command: LedgerDepositCreditCommand): Promise<{ journalId: string }> {
    const path = "/api/v1/ledger/journals";
    const body = JSON.stringify({
      businessType: "deposit_confirmed",
      businessId: command.depositId,
      idempotencyKey: `deposit:${command.depositId}`,
      traceId: command.traceId,
      entries: [
        {
          accountId: this.depositSourceAccountId,
          assetCode: command.assetCode,
          direction: "debit",
          amount: command.amount,
          referenceType: "deposit",
          referenceId: command.depositId
        },
        {
          accountId: command.ledgerAccountId,
          assetCode: command.assetCode,
          direction: "credit",
          amount: command.amount,
          referenceType: "deposit",
          referenceId: command.depositId
        }
      ]
    });
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: {
          "content-type": "application/json"
        }
      })
      ,
      body
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new WalletError(
        "LEDGER_POST_FAILED",
        `Ledger service rejected deposit credit: ${payload}`
      );
    }

    return (await response.json()) as LedgerJournalResponse;
  }

  async freezeBalance(command: LedgerFreezeBalanceCommand): Promise<{ lockId: string }> {
    const path = "/api/v1/ledger/balances/freeze";
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
      throw new WalletError(
        "LEDGER_FREEZE_FAILED",
        `Ledger service rejected balance freeze: ${payload}`
      );
    }

    return (await response.json()) as LedgerFreezeResponse;
  }

  async releaseBalance(command: LedgerReleaseBalanceCommand): Promise<{ lockId: string }> {
    const path = "/api/v1/ledger/balances/release";
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
      throw new WalletError(
        "LEDGER_RELEASE_FAILED",
        `Ledger service rejected balance release: ${payload}`
      );
    }

    return (await response.json()) as LedgerFreezeResponse;
  }

  async consumeBalance(command: LedgerConsumeBalanceCommand): Promise<{ lockId: string }> {
    // Ledger only consumes locks through a settlement account (M2-6), so the
    // withdrawn amount is journaled out of the user rather than vanishing.
    const body = {
      ...command,
      settlementAccountId: this.withdrawalSettlementAccountId,
      traceId: `withdrawal:${command.referenceId}`,
      businessId: command.referenceId,
      description: `Complete withdrawal ${command.referenceId}`
    };
    const path = "/api/v1/ledger/balances/consume";
    const payload = JSON.stringify(body);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: payload,
        headers: {
          "content-type": "application/json"
        }
      }),
      body: payload
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new WalletError(
        "LEDGER_CONSUME_FAILED",
        `Ledger service rejected balance consume: ${payload}`
      );
    }

    return (await response.json()) as LedgerFreezeResponse;
  }
}
