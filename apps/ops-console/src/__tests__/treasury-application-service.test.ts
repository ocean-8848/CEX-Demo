import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import { TreasuryApplicationService } from "../application/treasury-application-service.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import type { OpsTreasuryClient } from "../domain/treasury.js";
import { OPS_PERMISSIONS_KEY } from "../http/ops-auth.decorator.js";
import { TreasuryController } from "../http/treasury.controller.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";

const session = (email: string): OpsSessionInfo => ({
  sessionId: `session-${email}`,
  userId: `user-${email}`,
  email,
  roles: ["ops_admin"],
  permissions: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-11T00:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
  active: true,
  status: "active"
});

function createTreasury() {
  const calls: Array<[string, unknown]> = [];
  const client = {
    async proposeTransfer(command) {
      calls.push(["propose", command]);
      return { transferId: "t-1", status: "proposed", requestedBy: command.requestedBy };
    },
    async approveTransfer(transferId, command) {
      calls.push(["approve", { transferId, ...command }]);
      if (command.reviewedBy === "admin@example.com") {
        throw new OpsConsoleError("TREASURY_SAME_APPROVER", 409, "TREASURY_SAME_APPROVER: same operator");
      }
      return { transferId, status: "broadcasted" };
    },
    async runSweeps(command) {
      calls.push(["sweep", command]);
      return { plannedCount: 1 };
    },
    async generateProofOfReserves(command) {
      calls.push(["por", command]);
      return { snapshotId: "s-1", merkleRoot: "abc" };
    }
  } as Partial<OpsTreasuryClient> as OpsTreasuryClient;
  const auditRepository = new InMemoryOpsActionAuditRepository();
  const ops = new OpsConsoleApplicationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    auditRepository
  );
  const treasury = new TreasuryApplicationService(client, (options, operation) => ops.runAuditedAction(options, operation));
  return { treasury, calls, auditRepository };
}

test("treasury actions send the operator and are audited, failures included", async () => {
  const { treasury, calls, auditRepository } = createTreasury();
  const admin = session("admin@example.com");
  const reviewer = session("reviewer@example.com");

  await treasury.proposeTransfer(admin, { kind: "rebalance_to_cold", assetCode: "USDT", amount: "10", reason: "drill" });
  await assert.rejects(treasury.approveTransfer(admin, "t-1", {}), /SAME_APPROVER/);
  await treasury.approveTransfer(reviewer, "t-1", { note: "ok" });
  await treasury.runSweeps(admin);
  await treasury.generateProofOfReserves(admin);

  assert.deepEqual(calls[0], [
    "propose",
    { kind: "rebalance_to_cold", assetCode: "USDT", network: undefined, amount: "10", reason: "drill", requestedBy: "admin@example.com" }
  ]);
  assert.deepEqual(calls[2], ["approve", { transferId: "t-1", reviewedBy: "reviewer@example.com", note: "ok" }]);

  const logs = await auditRepository.list({ limit: 20, offset: 0 });
  const actions = logs.items.map((log) => `${log.action}:${log.status}:${log.permission}`).sort();
  assert.deepEqual(actions, [
    "treasury.por.generate:succeeded:ops.ledger.execute",
    "treasury.sweep.run:succeeded:ops.ledger.execute",
    "treasury.transfer.approve:failed:ops.withdrawals.review",
    "treasury.transfer.approve:succeeded:ops.withdrawals.review",
    "treasury.transfer.propose:succeeded:ops.ledger.execute"
  ]);
});

test("treasury routes require read / execute / review permissions", () => {
  const permissions = (method: keyof TreasuryController) =>
    Reflect.getMetadata(OPS_PERMISSIONS_KEY, TreasuryController.prototype[method]) as string[];
  assert.deepEqual(permissions("getOverview"), ["ops.ledger.read"]);
  assert.deepEqual(permissions("getReconciliation"), ["ops.ledger.read"]);
  assert.deepEqual(permissions("runSweeps"), ["ops.ledger.execute"]);
  assert.deepEqual(permissions("generateProofOfReserves"), ["ops.ledger.execute"]);
  assert.deepEqual(permissions("approveTransfer"), ["ops.withdrawals.review"]);
  assert.deepEqual(permissions("rejectTransfer"), ["ops.withdrawals.review"]);
});
