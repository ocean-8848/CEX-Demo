import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionCookies,
  clearSessionCookies,
  csrfSatisfied,
  parseCookies,
  resolveOpsCredential
} from "../http/ops-session-cookie.js";

test("cookie sessions are HttpOnly + SameSite=Strict and carry a readable CSRF cookie", () => {
  const [session, csrf] = buildSessionCookies("tok", new Date(Date.now() + 3600_000).toISOString(), false);
  assert.match(session!, /^ops_session=tok; HttpOnly; Path=\/; Max-Age=3\d{3}; SameSite=Strict$/);
  assert.match(csrf!, /^ops_csrf=[\w-]+; Path=\/; Max-Age=\d+; SameSite=Strict$/);
  assert.doesNotMatch(csrf!, /HttpOnly/);
  assert.match(buildSessionCookies("tok", undefined, true)[0]!, /; Secure$/);
  assert.ok(clearSessionCookies(false).every((cookie) => cookie.includes("Max-Age=0")));
});

test("bearer wins over cookie; cookie writes need the matching CSRF header", () => {
  const cookie = "ops_session=abc; ops_csrf=xyz";
  assert.deepEqual(parseCookies(cookie), { ops_session: "abc", ops_csrf: "xyz" });
  assert.deepEqual(resolveOpsCredential({ cookie }), { token: "abc", source: "cookie" });
  assert.deepEqual(resolveOpsCredential({ cookie, authorization: "Bearer def" }), { token: "def", source: "bearer" });
  assert.equal(resolveOpsCredential({}), undefined);

  assert.equal(csrfSatisfied("GET", { cookie }), true);
  assert.equal(csrfSatisfied("POST", { cookie }), false);
  assert.equal(csrfSatisfied("POST", { cookie, "x-csrf-token": "nope" }), false);
  assert.equal(csrfSatisfied("POST", { cookie, "x-csrf-token": "xyz" }), true);
});
