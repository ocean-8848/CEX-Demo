import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApiKeyCanonicalRequest,
  createApiKeySignature,
  verifyApiKeySignature
} from "../http/api-key-signature.js";

test("api key signature canonicalizes method url timestamp and body hash", () => {
  const canonical = buildApiKeyCanonicalRequest({
    method: "post",
    url: "/api/v1/gateway/withdrawals/request?network=ethereum",
    timestamp: "1741382400000",
    nonce: "n-12345678",
    rawBody: Buffer.from('{"amount":"12.5"}')
  });

  assert.match(canonical, /^POST\n\/api\/v1\/gateway\/withdrawals\/request\?network=ethereum\n1741382400000\nn-12345678\n[a-f0-9]{64}$/);
});

test("api key signature verifies expected hmac", () => {
  const signature = createApiKeySignature({
    secret: "w3c_demo_secret",
    method: "GET",
    url: "/api/v1/gateway/balances",
    timestamp: "1741382400000",
    nonce: "n-12345678"
  });

  assert.equal(
    verifyApiKeySignature({
      secret: "w3c_demo_secret",
      method: "GET",
      url: "/api/v1/gateway/balances",
      timestamp: "1741382400000",
      nonce: "n-12345678",
      signature
    }),
    true
  );

  assert.equal(
    verifyApiKeySignature({
      secret: "w3c_demo_secret",
      method: "GET",
      url: "/api/v1/gateway/balances",
      timestamp: "1741382400000",
      nonce: "n-12345678",
      signature: `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`
    }),
    false
  );
});
