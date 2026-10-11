import assert from "node:assert/strict";
import test from "node:test";

import {
  createInternalServiceSignature,
  normalizeInternalServicePath,
  verifyInternalServiceSignature
} from "../index.js";

test("a bare trailing '?' does not change the internal service signature", () => {
  // Node 22's fetch sends "/p?" as "/p"; Node 26 keeps the "?". Either way the
  // verifier must accept what the signer signed.
  const base = {
    secret: "secret",
    callerName: "ops-console",
    method: "GET",
    timestamp: "2026-10-11T00:00:00.000Z"
  };
  const signature = createInternalServiceSignature({ ...base, path: "/api/v1/ledger/ops/reconciliation?" });
  assert.equal(
    verifyInternalServiceSignature({ ...base, path: "/api/v1/ledger/ops/reconciliation", signature }),
    true
  );
  assert.equal(
    verifyInternalServiceSignature({ ...base, path: "/api/v1/ledger/ops/reconciliation?", signature }),
    true
  );
  assert.equal(normalizeInternalServicePath("/p?a=1"), "/p?a=1");
  assert.equal(
    verifyInternalServiceSignature({ ...base, path: "/api/v1/ledger/ops/reconciliation?limit=1", signature }),
    false
  );
});
