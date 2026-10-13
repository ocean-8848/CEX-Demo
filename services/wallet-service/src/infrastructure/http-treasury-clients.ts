import type { TreasuryCustodyClient, TreasuryLedgerClient } from "../domain/treasury-clients.js";
import { TreasuryError } from "../domain/treasury-errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

async function signedFetch(baseUrl: string, path: string, init: { method: "GET" | "POST"; body?: string }) {
  return fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: buildInternalServiceHeaders({
      method: init.method,
      path,
      rawBody: init.body,
      headers: { "content-type": "application/json" }
    }),
    body: init.body
  });
}

/**
 * Internal transfers reuse custody-adapter's generic transfer API with their
 * own idempotency key (`treasury:<transferId>`) and a `purpose` in metadata,
 * so they show up next to withdrawals in custody audits.
 */
export class HttpTreasuryCustodyClient implements TreasuryCustodyClient {
  constructor(private readonly baseUrl: string) {}

  async broadcastInternalTransfer(command: Parameters<TreasuryCustodyClient["broadcastInternalTransfer"]>[0]) {
    const body = JSON.stringify({
      referenceId: command.transferId,
      assetCode: command.assetCode,
      network: command.network,
      toAddress: command.toAddress,
      amount: command.amount,
      fee: "0",
      idempotencyKey:
        command.attempt > 1 ? `treasury:${command.transferId}:${command.attempt}` : `treasury:${command.transferId}`,
      metadata: { ...command.metadata, fromAddress: command.fromAddress }
    });
    const response = await signedFetch(this.baseUrl, "/api/v1/custody/transfers", { method: "POST", body });
    if (!response.ok) {
      throw new TreasuryError("TREASURY_UPSTREAM_FAILED", `Custody adapter rejected treasury transfer: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      custodyTransferId: string;
      providerName: string;
      txHash?: string;
      status: string;
      lastErrorMessage?: string;
    };
    if (payload.status === "failed" || !payload.txHash) {
      throw new TreasuryError(
        "TREASURY_UPSTREAM_FAILED",
        `Custody broadcast failed: ${payload.lastErrorMessage ?? payload.status}`
      );
    }
    return payload;
  }
}

export class HttpTreasuryLedgerClient implements TreasuryLedgerClient {
  constructor(private readonly baseUrl: string) {}

  getLiabilitySummary() {
    return this.get<Awaited<ReturnType<TreasuryLedgerClient["getLiabilitySummary"]>>>("/api/v1/ledger/ops/liabilities");
  }

  listUserLiabilities() {
    return this.get<Awaited<ReturnType<TreasuryLedgerClient["listUserLiabilities"]>>>(
      "/api/v1/ledger/ops/liabilities/users"
    );
  }

  private async get<T>(path: string): Promise<T> {
    const response = await signedFetch(this.baseUrl, path, { method: "GET" });
    if (!response.ok) {
      throw new TreasuryError("TREASURY_UPSTREAM_FAILED", `Ledger service rejected ${path}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}
