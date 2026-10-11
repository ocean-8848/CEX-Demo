import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryIdempotencyStore } from "../infrastructure/in-memory-idempotency-store.js";

test("idempotency store replays completed mutations with the same fingerprint", async () => {
  const store = new InMemoryIdempotencyStore();

  const claim = await store.begin({
    scopeKey: "session:user-1:session-1",
    idempotencyKey: "withdrawal-1",
    requestFingerprint: "fingerprint-1",
    ttlMs: 60_000,
    now: new Date("2026-03-08T00:00:00.000Z")
  });

  assert.equal(claim.outcome, "acquired");

  await store.complete({
    scopeKey: "session:user-1:session-1",
    idempotencyKey: "withdrawal-1",
    requestFingerprint: "fingerprint-1",
    ttlMs: 60_000,
    statusCode: 201,
    responseBody: '{"withdrawalId":"w-1"}',
    now: new Date("2026-03-08T00:00:01.000Z")
  });

  const replay = await store.begin({
    scopeKey: "session:user-1:session-1",
    idempotencyKey: "withdrawal-1",
    requestFingerprint: "fingerprint-1",
    ttlMs: 60_000,
    now: new Date("2026-03-08T00:00:02.000Z")
  });

  assert.equal(replay.outcome, "replay");
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.responseBody, '{"withdrawalId":"w-1"}');
});

test("idempotency store rejects reused keys with different fingerprints", async () => {
  const store = new InMemoryIdempotencyStore();

  await store.begin({
    scopeKey: "session:user-1:session-1",
    idempotencyKey: "deposit-address-1",
    requestFingerprint: "fingerprint-1",
    ttlMs: 60_000,
    now: new Date("2026-03-08T00:00:00.000Z")
  });

  const conflict = await store.begin({
    scopeKey: "session:user-1:session-1",
    idempotencyKey: "deposit-address-1",
    requestFingerprint: "fingerprint-2",
    ttlMs: 60_000,
    now: new Date("2026-03-08T00:00:01.000Z")
  });

  assert.equal(conflict.outcome, "conflict");
});
