import assert from "node:assert/strict";
import test from "node:test";

import {
  currentTraceId,
  extractTraceContext,
  injectTraceContext,
  isTelemetryEnabled,
  linkFromTraceContext,
  withSpan
} from "../index.js";

test("isTelemetryEnabled only accepts OTEL_ENABLED=true", () => {
  assert.equal(isTelemetryEnabled({}), false);
  assert.equal(isTelemetryEnabled({ OTEL_ENABLED: "false" }), false);
  assert.equal(isTelemetryEnabled({ OTEL_ENABLED: "TRUE" }), true);
});

test("helpers are no-ops when no SDK is registered", async () => {
  assert.equal(currentTraceId(), undefined);
  assert.deepEqual(injectTraceContext(), {});
  assert.deepEqual(linkFromTraceContext({ traceparent: "" }), []);
  assert.ok(extractTraceContext(undefined));

  const result = await withSpan("noop", { market: "ETH-USDT" }, () => {
    assert.equal(currentTraceId(), undefined);
    return 42;
  });
  assert.equal(result, 42);
});

test("withSpan rethrows errors from the callback", async () => {
  await assert.rejects(
    withSpan("failing", {}, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

test("register entry is a cheap no-op when OTEL_ENABLED is unset", async () => {
  delete process.env.OTEL_ENABLED;
  await import("../register.js");
  assert.equal(currentTraceId(), undefined);
});
