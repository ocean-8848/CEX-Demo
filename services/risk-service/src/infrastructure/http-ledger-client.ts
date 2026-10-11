import type { AssetCode } from "@web3-cex/domain";

import { RiskServiceError } from "../domain/errors.js";
import type { RiskLedgerClient } from "../domain/ledger-client.js";
import type { LedgerBalanceSnapshot } from "../domain/types.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export class HttpLedgerClient implements RiskLedgerClient {
  constructor(private readonly baseUrl: string) {}

  async getBalance(accountId: string, assetCode: AssetCode): Promise<LedgerBalanceSnapshot> {
    const path = `/api/v1/ledger/balances/${accountId}/${assetCode}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: buildInternalServiceHeaders({
        method: "GET",
        path,
        headers: {
          "content-type": "application/json"
        }
      })
    });

    if (!response.ok) {
      throw await buildUpstreamError(response);
    }

    return (await response.json()) as LedgerBalanceSnapshot;
  }
}

async function buildUpstreamError(response: Response): Promise<RiskServiceError> {
  const payload = await response.text();
  return new RiskServiceError(
    "LEDGER_UPSTREAM_FAILED",
    response.status >= 400 && response.status < 600 ? response.status : 502,
    `Ledger service rejected request: ${payload}`
  );
}
