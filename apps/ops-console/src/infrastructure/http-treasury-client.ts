import { OpsConsoleError } from "../domain/errors.js";
import type { OpsTreasuryClient } from "../domain/treasury.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

const BASE = "/api/v1/wallet/treasury";

/** wallet-service treasury endpoints, HMAC-signed like every internal call. */
export class HttpTreasuryClient implements OpsTreasuryClient {
  constructor(private readonly baseUrl: string) {}

  getOverview() {
    return this.request("GET", `${BASE}/overview`);
  }

  listTransfers(query: Record<string, string | number | undefined>) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        search.set(key, String(value));
      }
    }
    const text = search.toString();
    return this.request("GET", `${BASE}/transfers${text ? `?${text}` : ""}`);
  }

  getTransfer(transferId: string) {
    return this.request("GET", `${BASE}/transfers/${encodeURIComponent(transferId)}`);
  }

  proposeTransfer(command: Parameters<OpsTreasuryClient["proposeTransfer"]>[0]) {
    return this.request("POST", `${BASE}/transfers`, command);
  }

  approveTransfer(transferId: string, command: { reviewedBy: string; note?: string }) {
    return this.request("POST", `${BASE}/transfers/${encodeURIComponent(transferId)}/approve`, command);
  }

  rejectTransfer(transferId: string, command: { reviewedBy: string; reason?: string }) {
    return this.request("POST", `${BASE}/transfers/${encodeURIComponent(transferId)}/reject`, command);
  }

  retryTransfer(transferId: string, command: { requestedBy: string }) {
    return this.request("POST", `${BASE}/transfers/${encodeURIComponent(transferId)}/retry`, command);
  }

  runSweeps(command: { requestedBy: string }) {
    return this.request("POST", `${BASE}/sweeps/run`, command);
  }

  evaluateWatermarks(command: { requestedBy: string }) {
    return this.request("POST", `${BASE}/watermarks/evaluate`, command);
  }

  getReconciliation() {
    return this.request("GET", `${BASE}/reconciliation`);
  }

  generateProofOfReserves(command: { generatedBy: string }) {
    return this.request("POST", `${BASE}/proof-of-reserves/snapshots`, command);
  }

  listProofOfReservesSnapshots(limit = 20) {
    return this.request("GET", `${BASE}/proof-of-reserves/snapshots?limit=${limit}`);
  }

  getProofOfReservesSnapshot(snapshotId: string) {
    return this.request("GET", `${BASE}/proof-of-reserves/snapshots/${encodeURIComponent(snapshotId)}`);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: buildInternalServiceHeaders({
          method,
          path,
          rawBody,
          headers: { "content-type": "application/json" }
        }),
        body: rawBody,
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new OpsConsoleError(
        "WALLET_UPSTREAM_FAILED",
        503,
        `wallet-service is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const text = await response.text();
      let code = "WALLET_UPSTREAM_FAILED";
      let message = text.slice(0, 500);
      try {
        const payload = JSON.parse(text) as { code?: unknown; message?: unknown };
        code = typeof payload.code === "string" ? payload.code : code;
        message = typeof payload.message === "string" ? payload.message : message;
      } catch {
        // not JSON
      }
      throw new OpsConsoleError(code, response.status >= 400 && response.status < 600 ? response.status : 502, `${code}: ${message}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
