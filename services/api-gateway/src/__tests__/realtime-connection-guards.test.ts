import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WS_ALLOWED_ORIGINS,
  MessageRateLimiter,
  isOriginAllowed,
  msUntilExpiry,
  parseAllowedOrigins
} from "../http/realtime-connection-guards.js";

test("origin allow-list rejects other sites but lets non-browser clients through", () => {
  const allowed = parseAllowedOrigins(undefined);
  assert.deepEqual(allowed, DEFAULT_WS_ALLOWED_ORIGINS);
  assert.equal(isOriginAllowed("http://127.0.0.1:3013", allowed), true);
  assert.equal(isOriginAllowed("http://localhost:3013/", allowed), true);
  assert.equal(isOriginAllowed("https://evil.example", allowed), false);
  assert.equal(isOriginAllowed(undefined, allowed), true);
  assert.equal(isOriginAllowed("https://evil.example", parseAllowedOrigins("*")), true);
  assert.deepEqual(parseAllowedOrigins("https://a.test, https://b.test/"), ["https://a.test", "https://b.test"]);
});

test("message rate limiter drops excess messages and flags abuse", () => {
  const limiter = new MessageRateLimiter(3, 1000);
  const results = Array.from({ length: 7 }, () => limiter.hit(100));
  assert.deepEqual(results, ["ok", "ok", "ok", "limited", "limited", "limited", "abuse"]);
  assert.equal(limiter.hit(1200), "ok");
});

test("msUntilExpiry clamps to zero and ignores missing expiry", () => {
  assert.equal(msUntilExpiry(undefined), undefined);
  assert.equal(msUntilExpiry("2026-01-01T00:00:10.000Z", Date.parse("2026-01-01T00:00:00.000Z")), 10_000);
  assert.equal(msUntilExpiry("2025-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z")), 0);
});
