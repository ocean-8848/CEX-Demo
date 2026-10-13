import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionContext } from "@nestjs/common";

import type { ApiGatewayHttpService } from "../http/api-gateway-http.service.js";
import { ApiGatewayRateLimitGuard } from "../http/api-gateway-rate-limit.guard.js";
import {
  isGatewayTrustProxyEnabled,
  resolveClientIp,
  resolveSessionIp
} from "../http/client-ip.js";

const spoofed = {
  headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  ip: "::ffff:127.0.0.1",
  socket: { remoteAddress: "::ffff:127.0.0.1" }
};

test("X-Forwarded-For is ignored unless GATEWAY_TRUST_PROXY is enabled", () => {
  assert.equal(resolveClientIp(spoofed, false), "127.0.0.1");
  assert.equal(resolveClientIp(spoofed, true), "203.0.113.7");
});

test("socket address wins over request.ip and falls back sensibly", () => {
  assert.equal(
    resolveClientIp({ headers: {}, ip: "10.9.9.9", socket: { remoteAddress: "192.0.2.1" } }, false),
    "192.0.2.1"
  );
  assert.equal(resolveClientIp({ headers: {}, ip: "10.9.9.9" }, false), "10.9.9.9");
  assert.equal(resolveClientIp({ headers: {} }, false), "0.0.0.0");
  assert.equal(resolveSessionIp({ headers: {} }, false), undefined);
  // Trusted proxy but no header: still the socket peer.
  assert.equal(resolveClientIp({ headers: {}, socket: { remoteAddress: "192.0.2.1" } }, true), "192.0.2.1");
});

test("GATEWAY_TRUST_PROXY parsing defaults to off", () => {
  assert.equal(isGatewayTrustProxyEnabled({}), false);
  assert.equal(isGatewayTrustProxyEnabled({ GATEWAY_TRUST_PROXY: "false" }), false);
  assert.equal(isGatewayTrustProxyEnabled({ GATEWAY_TRUST_PROXY: "TRUE" }), true);
  assert.equal(isGatewayTrustProxyEnabled({ GATEWAY_TRUST_PROXY: "1" }), true);
});

test("rate-limit guard buckets spoofed X-Forwarded-For requests by socket address", async () => {
  const seen: string[] = [];
  const guard = new ApiGatewayRateLimitGuard({
    async consumeRateLimit(input: { ipAddress: string }) {
      seen.push(input.ipAddress);
      return { allowed: true, limit: 10, remaining: 9, resetAt: "2026-01-01T00:00:00.000Z" };
    }
  } as unknown as ApiGatewayHttpService);
  const context = (request: object) =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader() {} })
      })
    }) as unknown as ExecutionContext;

  const previous = process.env.GATEWAY_TRUST_PROXY;
  try {
    delete process.env.GATEWAY_TRUST_PROXY;
    await guard.canActivate(context({ ...spoofed, headers: { "x-forwarded-for": "198.51.100.1" } }));
    await guard.canActivate(context({ ...spoofed, headers: { "x-forwarded-for": "198.51.100.2" } }));
    process.env.GATEWAY_TRUST_PROXY = "true";
    await guard.canActivate(context({ ...spoofed, headers: { "x-forwarded-for": "198.51.100.3" } }));
  } finally {
    if (previous === undefined) {
      delete process.env.GATEWAY_TRUST_PROXY;
    } else {
      process.env.GATEWAY_TRUST_PROXY = previous;
    }
  }

  assert.deepEqual(seen, ["127.0.0.1", "127.0.0.1", "198.51.100.3"]);
});
