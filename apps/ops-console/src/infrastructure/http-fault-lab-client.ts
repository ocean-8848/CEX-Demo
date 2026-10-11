import { OpsConsoleError } from "../domain/errors.js";
import type { OpsFaultLabClient } from "../domain/fault-lab.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

export interface FaultLabUpstreams {
  settlementBaseUrl: string;
  custodyBaseUrl: string;
  orderBaseUrl: string;
  indexerBaseUrl: string;
  simulatorBaseUrl: string;
}

/** Calls each upstream's fault-lab endpoints with HMAC-signed internal requests. */
export class HttpFaultLabClient implements OpsFaultLabClient {
  constructor(private readonly upstreams: FaultLabUpstreams) {}

  getSettlementConsumerState() {
    return this.request("settlement-service", this.upstreams.settlementBaseUrl, "GET", "/api/v1/settlement/lab/consumer");
  }

  pauseSettlementConsumer(command: { durationSeconds?: number; reason?: string; requestedBy?: string }) {
    return this.request("settlement-service", this.upstreams.settlementBaseUrl, "POST", "/api/v1/settlement/lab/consumer/pause", command);
  }

  resumeSettlementConsumer() {
    return this.request("settlement-service", this.upstreams.settlementBaseUrl, "POST", "/api/v1/settlement/lab/consumer/resume", {});
  }

  getCustodyLabState(network?: string) {
    const query = network ? `?${new URLSearchParams({ network }).toString()}` : "";
    return this.request("custody-adapter", this.upstreams.custodyBaseUrl, "GET", `/api/v1/custody/lab/state${query}`);
  }

  injectCustodyFailure(command: { providerName?: string; durationSeconds?: number; reason?: string; requestedBy?: string }) {
    return this.request("custody-adapter", this.upstreams.custodyBaseUrl, "POST", "/api/v1/custody/lab/failure-injection", command);
  }

  clearCustodyFailure(command: { providerName?: string }) {
    return this.request("custody-adapter", this.upstreams.custodyBaseUrl, "POST", "/api/v1/custody/lab/failure-injection/clear", command);
  }

  probeCustodyBroadcast(command: { network?: string; count?: number }) {
    return this.request("custody-adapter", this.upstreams.custodyBaseUrl, "POST", "/api/v1/custody/lab/probe-broadcast", command);
  }

  getChainLabStatus() {
    return this.request("demo-simulator", this.upstreams.simulatorBaseUrl, "GET", "/internal/lab/status");
  }

  haltChain(command: { durationSeconds?: number; reason?: string; requestedBy?: string }) {
    return this.request("demo-simulator", this.upstreams.simulatorBaseUrl, "POST", "/internal/lab/chain/halt", command);
  }

  resumeChain() {
    return this.request("demo-simulator", this.upstreams.simulatorBaseUrl, "POST", "/internal/lab/chain/resume", {});
  }

  seedLabDeposit(command: { confirmations?: number }) {
    return this.request("demo-simulator", this.upstreams.simulatorBaseUrl, "POST", "/internal/lab/chain/seed-deposit", command);
  }

  triggerChainReorg(command: { depth?: number; seedIfEmpty?: boolean; requestedBy?: string }) {
    return this.request("demo-simulator", this.upstreams.simulatorBaseUrl, "POST", "/internal/lab/chain/reorg", command);
  }

  acknowledgeIndexerReorg(command: { network: string }) {
    return this.request("blockchain-indexer", this.upstreams.indexerBaseUrl, "POST", "/api/v1/indexer/ops/reorg/acknowledge", command);
  }

  resetMatchingEngine(command: { market: string; resetSequences?: boolean }) {
    return this.request("order-service", this.upstreams.orderBaseUrl, "POST", "/api/v1/orders/ops/lab/engine-reset", command);
  }

  private async request(
    upstream: string,
    baseUrl: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: buildInternalServiceHeaders({
          method,
          path,
          rawBody,
          headers: { "content-type": "application/json" }
        }),
        body: rawBody,
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new OpsConsoleError(
        "FAULT_LAB_UPSTREAM_FAILED",
        503,
        `${upstream} is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new OpsConsoleError(
        "FAULT_LAB_UPSTREAM_FAILED",
        response.status >= 400 && response.status < 600 ? response.status : 502,
        `${upstream} rejected the fault lab request: ${readUpstreamMessage(text)}`
      );
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

function readUpstreamMessage(text: string): string {
  try {
    const payload = JSON.parse(text) as { message?: unknown };
    if (typeof payload.message === "string") {
      return payload.message;
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}
