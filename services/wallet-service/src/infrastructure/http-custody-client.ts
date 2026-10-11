import { WalletError } from "../domain/errors.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { CustodyCreateTransferCommand } from "../domain/custody-client.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

interface CustodyTransferResponse {
  custodyTransferId: string;
  providerName: string;
  txHash: string;
}

export class HttpCustodyClient implements CustodyClient {
  constructor(private readonly baseUrl: string) {}

  async createTransfer(command: CustodyCreateTransferCommand): Promise<{
    custodyRequestId: string;
    providerName: string;
    txHash: string;
  }> {
    const path = "/api/v1/custody/transfers";
    const body = JSON.stringify({
      referenceId: command.withdrawalId,
      assetCode: command.assetCode,
      network: command.network,
      toAddress: command.toAddress,
      amount: command.amount,
      fee: command.fee,
      idempotencyKey: `withdrawal:${command.withdrawalId}`,
      metadata: command.metadata ?? {}
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
      }),
      body
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new WalletError(
        "CUSTODY_TRANSFER_FAILED",
        `Custody adapter rejected transfer request: ${payload}`
      );
    }

    const payload = (await response.json()) as CustodyTransferResponse;
    return {
      custodyRequestId: payload.custodyTransferId,
      providerName: payload.providerName,
      txHash: payload.txHash
    };
  }
}
