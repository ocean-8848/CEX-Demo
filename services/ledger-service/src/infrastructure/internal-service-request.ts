import { createInternalServiceAuthHeaders } from "@web3-cex/domain";

const DEFAULT_CALLER_NAME = "ledger-service";

/** Signs ledger-service's own outbound calls (reconciliation job → order-service / risk-service). */
export function buildInternalServiceHeaders(input: {
  method: string;
  path: string;
  rawBody?: Buffer | string;
  headers?: Record<string, string>;
}): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("INTERNAL_SERVICE_AUTH_SECRET is required for internal service calls");
  }

  return createInternalServiceAuthHeaders({
    secret,
    callerName: process.env.INTERNAL_SERVICE_CALLER_NAME ?? DEFAULT_CALLER_NAME,
    method: input.method,
    path: input.path,
    rawBody: input.rawBody,
    headers: input.headers
  });
}

export async function postInternalJson<T>(baseUrl: string, path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  const rawBody = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: buildInternalServiceHeaders({
      method: "POST",
      path,
      rawBody,
      headers: { "content-type": "application/json" }
    }),
    body: rawBody,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`${baseUrl}${path} responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as T;
}
