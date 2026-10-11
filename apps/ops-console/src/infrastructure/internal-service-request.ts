import { createInternalServiceAuthHeaders } from "@web3-cex/domain";

const DEFAULT_CALLER_NAME = "ops-console";

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
