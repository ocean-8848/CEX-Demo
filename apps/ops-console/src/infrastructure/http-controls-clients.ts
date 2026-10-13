import {
  normalizeControlSwitchState,
  type ControlSwitchState
} from "@web3-cex/domain";

import type {
  OpsControlSwitchClient,
  OpsReconciliationClient,
  OpsReconciliationJobStatus,
  OpsReconciliationRun
} from "../domain/controls.js";
import { OpsConsoleError } from "../domain/errors.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

async function requestJson<T>(
  baseUrl: string,
  path: string,
  fallbackCode: string,
  init?: { method?: "GET" | "POST"; body?: unknown }
): Promise<T> {
  const method = init?.method ?? "GET";
  const rawBody = init?.body === undefined ? undefined : JSON.stringify(init.body);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      body: rawBody,
      headers: buildInternalServiceHeaders({
        method,
        path,
        rawBody,
        headers: { "content-type": "application/json" }
      })
    });
  } catch (error) {
    throw new OpsConsoleError(fallbackCode, 502, `${baseUrl}${path} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const payload = await response.text();
    throw new OpsConsoleError(
      readUpstreamCode(payload) ?? fallbackCode,
      response.status >= 400 && response.status < 600 ? response.status : 502,
      `Upstream rejected request: ${payload}`
    );
  }
  return (await response.json()) as T;
}

function readUpstreamCode(payload: string): string | undefined {
  try {
    const code = (JSON.parse(payload) as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code) && code !== "HTTP_EXCEPTION" ? code : undefined;
  } catch {
    return undefined;
  }
}

export class HttpControlSwitchClient implements OpsControlSwitchClient {
  constructor(private readonly baseUrl: string) {}

  async getState(): Promise<ControlSwitchState> {
    return normalizeControlSwitchState(await requestJson(this.baseUrl, "/api/v1/risk/controls", "RISK_UPSTREAM_FAILED"));
  }

  setSwitch(command: Parameters<OpsControlSwitchClient["setSwitch"]>[0]) {
    return requestJson<Record<string, unknown>>(this.baseUrl, "/api/v1/risk/controls", "RISK_UPSTREAM_FAILED", {
      method: "POST",
      body: { ...command, source: "manual" }
    });
  }

  listEvents(limit: number) {
    return requestJson<{ items: Array<Record<string, unknown>> }>(
      this.baseUrl,
      `/api/v1/risk/controls/events?limit=${encodeURIComponent(String(limit))}`,
      "RISK_UPSTREAM_FAILED"
    );
  }
}

export class HttpReconciliationClient implements OpsReconciliationClient {
  constructor(private readonly baseUrl: string) {}

  listRuns(limit: number) {
    return requestJson<{ job: OpsReconciliationJobStatus; items: OpsReconciliationRun[] }>(
      this.baseUrl,
      `/api/v1/ledger/ops/reconciliation/runs?limit=${encodeURIComponent(String(limit))}`,
      "LEDGER_UPSTREAM_FAILED"
    );
  }

  runNow() {
    return requestJson<OpsReconciliationRun>(this.baseUrl, "/api/v1/ledger/ops/reconciliation/jobs/run", "LEDGER_UPSTREAM_FAILED", {
      method: "POST",
      body: {}
    });
  }

  getDrift() {
    return requestJson<Record<string, unknown>>(this.baseUrl, "/api/v1/ledger/ops/reconciliation/lab/drift", "LEDGER_UPSTREAM_FAILED");
  }

  injectDrift(command: { assetCode: string; amount?: string }) {
    return requestJson<Record<string, unknown>>(this.baseUrl, "/api/v1/ledger/ops/reconciliation/lab/drift", "LEDGER_UPSTREAM_FAILED", {
      method: "POST",
      body: command
    });
  }

  clearDrift() {
    return requestJson<Record<string, unknown>>(this.baseUrl, "/api/v1/ledger/ops/reconciliation/lab/drift/clear", "LEDGER_UPSTREAM_FAILED", {
      method: "POST",
      body: {}
    });
  }
}
