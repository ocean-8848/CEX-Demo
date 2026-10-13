import assert from "node:assert/strict";
import test from "node:test";

import type { AuditedActionOptions } from "../application/ops-console-application-service.js";
import { OpsRiskSecurityService } from "../application/ops-risk-security-service.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import type { OpsRiskSecurityClient } from "../domain/risk-security.js";

const session: OpsSessionInfo = {
  sessionId: "s-1",
  userId: "ops-1",
  email: "risk@example.com",
  roles: ["ops_risk_operator"],
  permissions: ["ops.risk.read", "ops.risk.manage"],
  createdAt: "2026-06-01T00:00:00.000Z",
  expiresAt: "2026-06-02T00:00:00.000Z",
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  active: true,
  status: "active"
};

function createHarness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const audits: AuditedActionOptions[] = [];
  const client: OpsRiskSecurityClient = {
    async listAddressBlacklist(query) {
      calls.push({ method: "list", args: [query] });
      return { items: [], total: 0, limit: 50, offset: 0 };
    },
    async addAddressBlacklistEntry(command) {
      calls.push({ method: "add", args: [command] });
      return { entry: { entryId: "e-1" }, autoRejectedWithdrawalIds: [] };
    },
    async removeAddressBlacklistEntry(command) {
      calls.push({ method: "remove", args: [command] });
      return { entryId: command.entryId, status: "removed" };
    },
    async listAddressRiskLabels() {
      return { items: [] };
    },
    async listLoginEvents(userId, query) {
      calls.push({ method: "events", args: [userId, query] });
      return { items: [], total: 0, limit: 20, offset: 0 };
    },
    async listDevices(userId) {
      calls.push({ method: "devices", args: [userId] });
      return { items: [] };
    },
    async revokeDevice(userId, deviceId) {
      calls.push({ method: "revoke", args: [userId, deviceId] });
      return { revokedSessionCount: 2 };
    }
  };
  const service = new OpsRiskSecurityService(client, async (options, operation) => {
    audits.push(options);
    return operation();
  });
  return { service, calls, audits };
}

test("blacklist add is validated, audited and records the operator", async () => {
  const { service, calls, audits } = createHarness();
  await assert.rejects(
    service.addAddressBlacklistEntry(session, { network: "ethereum", address: "0xabc", category: "nope", reason: "x" }),
    (error: unknown) => error instanceof OpsConsoleError && error.statusCode === 400
  );
  await assert.rejects(
    service.addAddressBlacklistEntry(session, { network: "ethereum", address: "0xabc", category: "scam", reason: "  " }),
    /reason/
  );
  assert.equal(calls.length, 0, "invalid requests never reach wallet-service");

  await service.addAddressBlacklistEntry(session, {
    network: "ethereum",
    address: " 0xABC ",
    category: "scam",
    reason: "phishing report"
  });
  assert.deepEqual(calls[0], {
    method: "add",
    args: [{ network: "ethereum", address: "0xABC", category: "scam", reason: "phishing report", createdBy: "risk@example.com" }]
  });
  assert.equal(audits[0]?.permission, "ops.risk.manage");
  assert.equal(audits[0]?.action, "risk.blacklist.add");
  assert.equal(audits[0]?.targetId, "ethereum:0xabc");
});

test("blacklist removal needs a reason and is audited", async () => {
  const { service, calls, audits } = createHarness();
  await assert.rejects(service.removeAddressBlacklistEntry(session, { entryId: "e-1", reason: "" }), /reason/);
  await service.removeAddressBlacklistEntry(session, { entryId: "e-1", reason: "false positive" });
  assert.deepEqual(calls[0]?.args[0], { entryId: "e-1", reason: "false positive", removedBy: "risk@example.com" });
  assert.equal(audits[0]?.action, "risk.blacklist.remove");
});

test("device revoke is audited under ops.users.freeze; reads are not audited", async () => {
  const { service, audits } = createHarness();
  await service.listUserLoginEvents("user-1", { limit: 20 });
  await service.listUserDevices("user-1");
  assert.equal(audits.length, 0);
  await service.revokeUserDevice(session, "user-1", "web_abc");
  assert.equal(audits[0]?.permission, "ops.users.freeze");
  assert.equal(audits[0]?.action, "user.device.revoke");
});
