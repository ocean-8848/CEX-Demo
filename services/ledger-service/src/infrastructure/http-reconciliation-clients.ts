import type { OrderLockExpectationInput } from "../application/order-lock-reconciliation.js";
import type { OrderLockExpectationClient, WithdrawalPauseClient } from "../application/reconciliation-job.js";
import { postInternalJson } from "./internal-service-request.js";

/** order-service accepts at most this many explicit order ids per request. */
const ORDER_ID_CHUNK = 2000;

/** `POST /api/v1/orders/ops/lock-expectations` on order-service, in chunks. */
export class HttpOrderLockExpectationClient implements OrderLockExpectationClient {
  constructor(private readonly baseUrl: string) {}

  async getLockExpectations(orderIds: string[]): Promise<OrderLockExpectationInput[]> {
    const byOrder = new Map<string, OrderLockExpectationInput>();
    const chunks: string[][] = [];
    for (let index = 0; index < orderIds.length; index += ORDER_ID_CHUNK) {
      chunks.push(orderIds.slice(index, index + ORDER_ID_CHUNK));
    }
    if (chunks.length === 0) {
      chunks.push([]);
    }
    for (const [index, chunk] of chunks.entries()) {
      const report = await postInternalJson<{ items?: OrderLockExpectationInput[] }>(
        this.baseUrl,
        "/api/v1/orders/ops/lock-expectations",
        { orderIds: chunk, includeOpenOrders: index === 0 }
      );
      for (const item of report.items ?? []) {
        byOrder.set(item.orderId, item);
      }
    }
    return [...byOrder.values()];
  }
}

/** Trips the breaker: `POST /api/v1/risk/controls` with `source: "automatic"`. */
export class HttpWithdrawalPauseClient implements WithdrawalPauseClient {
  constructor(private readonly baseUrl: string) {}

  async pauseAssetWithdrawals(command: { assetCode: string; reason: string }): Promise<{ changed: boolean }> {
    const result = await postInternalJson<{ changed?: boolean }>(this.baseUrl, "/api/v1/risk/controls", {
      scope: "withdrawals_asset",
      assetCode: command.assetCode,
      enabled: true,
      reason: command.reason,
      operator: "ledger-service:reconciliation",
      source: "automatic"
    });
    return { changed: result.changed === true };
  }
}
