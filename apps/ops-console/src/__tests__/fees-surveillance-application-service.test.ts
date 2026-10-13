import assert from "node:assert/strict";
import test from "node:test";

import { FeesSurveillanceApplicationService } from "../application/fees-surveillance-application-service.js";
import type { AuditedActionOptions } from "../application/ops-console-application-service.js";
import type { OpsSessionInfo } from "../domain/clients.js";

const session: OpsSessionInfo = {
  sessionId: "s1",
  userId: "ops-1",
  email: "ops-admin@example.com",
  roles: ["ops_admin"],
  permissions: ["ops.users.manage", "ops.markets.manage"],
  createdAt: "2026-03-08T00:00:00.000Z",
  expiresAt: "2026-03-09T00:00:00.000Z",
  lastSeenAt: "2026-03-08T00:00:00.000Z",
  active: true,
  status: "active"
};

function setup() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const audited: AuditedActionOptions[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { ok: true, items: [] };
  };
  const service = new FeesSurveillanceApplicationService(
    {
      getFeeTierConfig: record("getFeeTierConfig"),
      getUserFeeTier: record("getUserFeeTier"),
      listFeeTierAudit: record("listFeeTierAudit") as never,
      setFeeTierOverride: record("setFeeTierOverride"),
      clearFeeTierOverride: record("clearFeeTierOverride"),
      getSurveillanceOverview: record("getSurveillanceOverview"),
      listSurveillanceAlerts: record("listSurveillanceAlerts"),
      getSurveillanceAlert: record("getSurveillanceAlert"),
      updateSurveillanceAlertStatus: record("updateSurveillanceAlertStatus"),
      runSurveillanceScan: record("runSurveillanceScan")
    },
    async (options, operation) => {
      audited.push(options);
      return operation();
    }
  );
  return { service, calls, audited };
}

test("fee tier override is audited and passes the operator as actor", async () => {
  const { service, calls, audited } = setup();
  await service.setFeeTierOverride(session, "user-1", { tier: "VIP2", note: "做市商计划" });
  assert.equal(audited[0]?.action, "fee_tier.override.set");
  assert.equal(audited[0]?.permission, "ops.users.manage");
  assert.deepEqual(calls[0]?.args, ["user-1", { tier: "VIP2", note: "做市商计划", actor: "ops-admin@example.com" }]);
  assert.throws(() => service.setFeeTierOverride(session, "user-1", { tier: "VIP2" }), /note is required/i);
  await service.clearFeeTierOverride(session, "user-1", { note: "结束" });
  assert.equal(audited[1]?.action, "fee_tier.override.clear");
});

test("surveillance status changes need a valid status and a note, and are audited", async () => {
  const { service, calls, audited } = setup();
  assert.throws(() => service.updateSurveillanceAlertStatus(session, "a1", { status: "closed", note: "x" }), /status must be/);
  assert.throws(() => service.updateSurveillanceAlertStatus(session, "a1", { status: "dismissed" }), /note is required/i);
  await service.updateSurveillanceAlertStatus(session, "a1", { status: "dismissed", note: "测试账户" });
  assert.equal(audited[0]?.action, "surveillance.alert.dismiss");
  assert.equal(audited[0]?.targetType, "surveillance_alert");
  assert.deepEqual(calls[0]?.args, ["a1", { status: "dismissed", note: "测试账户", actor: "ops-admin@example.com" }]);
  await service.runSurveillanceScan(session);
  assert.equal(audited[1]?.action, "surveillance.scan");
});
