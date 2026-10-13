import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionContext } from "@nestjs/common";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createInternalServiceAuthHeaders } from "@web3-cex/domain";

import { InternalServiceAuthGuard } from "../http/internal-service-auth.guard.js";

const SECRET = "guard-test-secret";
const PATH = "/api/v1/custody/transfers";

function contextFor(request: {
  method: string;
  originalUrl: string;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;
}

function signedRequest(callerName: string, body = '{"amount":"1"}') {
  return {
    method: "POST",
    originalUrl: PATH,
    rawBody: Buffer.from(body),
    headers: createInternalServiceAuthHeaders({
      secret: SECRET,
      callerName,
      method: "POST",
      path: PATH,
      rawBody: body
    })
  };
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const guard = new InternalServiceAuthGuard();

test("custody-adapter accepts a correctly signed request from an allowlisted caller", () => {
  withEnv({ INTERNAL_SERVICE_AUTH_SECRET: SECRET, INTERNAL_SERVICE_ALLOWED_CALLERS: undefined }, () => {
    assert.equal(guard.canActivate(contextFor(signedRequest("wallet-service"))), true);
    assert.equal(guard.canActivate(contextFor(signedRequest("demo-scripts"))), true);
  });
});

test("custody-adapter rejects unsigned, non-allowlisted and tampered requests", () => {
  withEnv({ INTERNAL_SERVICE_AUTH_SECRET: SECRET, INTERNAL_SERVICE_ALLOWED_CALLERS: undefined }, () => {
    assert.throws(
      () => guard.canActivate(contextFor({ method: "POST", originalUrl: PATH, headers: {} })),
      UnauthorizedException
    );
    assert.throws(() => guard.canActivate(contextFor(signedRequest("api-gateway"))), /not allowed/);
    const tampered = { ...signedRequest("wallet-service"), rawBody: Buffer.from('{"amount":"999"}') };
    assert.throws(() => guard.canActivate(contextFor(tampered)), /signature is invalid/);
  });
});

test("custody-adapter honours INTERNAL_SERVICE_ALLOWED_CALLERS and requires the shared secret", () => {
  withEnv({ INTERNAL_SERVICE_AUTH_SECRET: SECRET, INTERNAL_SERVICE_ALLOWED_CALLERS: "api-gateway" }, () => {
    assert.equal(guard.canActivate(contextFor(signedRequest("api-gateway"))), true);
    assert.throws(() => guard.canActivate(contextFor(signedRequest("wallet-service"))), /not allowed/);
  });
  withEnv({ INTERNAL_SERVICE_AUTH_SECRET: undefined }, () => {
    assert.throws(
      () => guard.canActivate(contextFor(signedRequest("wallet-service"))),
      ServiceUnavailableException
    );
  });
});
