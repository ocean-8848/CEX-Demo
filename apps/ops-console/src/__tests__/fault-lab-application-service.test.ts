import { listSpotMarkets } from "@web3-cex/domain";
import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { FaultLabApplicationService } from "../application/fault-lab-application-service.js";
import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import type { OpsOrderClient, OpsSessionInfo } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { FAULT_LAB_AUDIT_PERMISSION, FAULT_LAB_PERMISSIONS, type OpsFaultLabClient } from "../domain/fault-lab.js";
import { FaultLabController } from "../http/fault-lab.controller.js";
import { OPS_PERMISSIONS_KEY } from "../http/ops-auth.decorator.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";

const session: OpsSessionInfo = {
  sessionId: "session-1",
  userId: "ops-1",
  email: "ops-admin@example.com",
  roles: ["ops_admin"],
  permissions: [...FAULT_LAB_PERMISSIONS],
  createdAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-11T00:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
  active: true,
  status: "active"
};

function createLab(overrides: Partial<OpsFaultLabClient> = {}) {
  const calls: string[] = [];
  let engineBroken = false;
  let paused = false;
  const labClient: OpsFaultLabClient = {
    async getSettlementConsumerState() {
      return { pause: { paused, expiresAt: paused ? "2026-10-10T00:02:00.000Z" : undefined }, lag: [] };
    },
    async pauseSettlementConsumer(command) {
      calls.push(`settlement.pause:${command.durationSeconds}:${command.requestedBy}`);
      paused = true;
      return { pause: { paused: true } };
    },
    async resumeSettlementConsumer() {
      calls.push("settlement.resume");
      paused = false;
      return { pause: { paused: false } };
    },
    async getCustodyLabState() {
      return { injections: [{ providerName: "mock-custody", expiresAt: "2026-10-10T00:03:00.000Z" }], routes: [] };
    },
    async injectCustodyFailure(command) {
      calls.push(`custody.inject:${command.providerName ?? "default"}`);
      return { injection: { providerName: "mock-custody" } };
    },
    async clearCustodyFailure() {
      calls.push("custody.clear");
      return { cleared: ["mock-custody"] };
    },
    async probeCustodyBroadcast(command) {
      calls.push(`custody.probe:${command.network}:${command.count}`);
      return { attempts: [] };
    },
    async getChainLabStatus() {
      throw new Error("demo-simulator is unreachable");
    },
    async haltChain() {
      calls.push("chain.halt");
      return { halted: true };
    },
    async resumeChain() {
      calls.push("chain.resume");
      return { halted: false };
    },
    async seedLabDeposit() {
      calls.push("chain.seed");
      return {};
    },
    async triggerChainReorg(command) {
      calls.push(`chain.reorg:${command.depth}`);
      return { reorg: { depth: command.depth } };
    },
    async acknowledgeIndexerReorg() {
      calls.push("indexer.ack");
      return { clearedCursors: [] };
    },
    async resetMatchingEngine(command) {
      calls.push(`engine.reset:${command.market}:${String(command.resetSequences)}`);
      engineBroken = true;
      return { droppedBookOrderCount: 2 };
    },
    ...overrides
  };
  const orderClient: Pick<OpsOrderClient, "getTradeOpsAnomalies" | "getTradeOpsOverview" | "replayEngineBook"> = {
    async getTradeOpsAnomalies(query) {
      return engineBroken && query.market === "ETH-USDT"
        ? [{ type: "engine_missing_open_order", market: query.market, orderId: "o-1" }]
        : [];
    },
    async getTradeOpsOverview(query) {
      return { market: query.market, engineBidCount: engineBroken ? 0 : 10 };
    },
    async replayEngineBook(query) {
      calls.push(`engine.replay:${query.market}`);
      engineBroken = false;
      return { market: query.market, replayedOrderCount: 2 };
    }
  };
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
  const lab = new FaultLabApplicationService(labClient, orderClient, (options, operation) =>
    ops.runAuditedAction(options, operation)
  );
  return { lab, calls, auditRepository };
}

test("fault lab status aggregates every experiment and tolerates an unreachable upstream", async () => {
  const { lab } = createLab();
  await lab.pauseSettlement(session, { durationSeconds: 120 });
  const status = await lab.getStatus({ market: "ETH-USDT" });

  assert.equal(status.market, "ETH-USDT");
  assert.equal(status.settlement.available, true);
  assert.equal(status.chain.available, false);
  assert.match(status.chain.available ? "" : status.chain.error, /unreachable/);
  assert.deepEqual(
    status.activeFaults.map((fault) => fault.experiment),
    ["settlement", "custody"]
  );
  await assert.rejects(lab.getStatus({ market: "DOGE-USDT" }), OpsConsoleError);
});

test("fault lab actions are audited with the admin permission set", async () => {
  const { lab, calls, auditRepository } = createLab();
  await lab.pauseSettlement(session, { durationSeconds: 90 });
  await lab.injectCustodyFailure(session, {});
  await lab.probeCustody(session, { count: 50 });
  await lab.triggerReorg(session, { depth: 40 });

  assert.deepEqual(calls, [
    "settlement.pause:90:ops-admin@example.com",
    "custody.inject:default",
    "custody.probe:ethereum:10",
    "chain.reorg:11"
  ]);
  const logs = await auditRepository.list({ limit: 10, offset: 0 });
  assert.equal(logs.total, 4);
  assert.ok(logs.items.every((item) => item.permission === FAULT_LAB_AUDIT_PERMISSION));
  assert.ok(logs.items.some((item) => item.action === "fault_lab.chain.reorg" && item.status === "succeeded"));
});

test("failed fault lab actions are audited as failed", async () => {
  const { lab, auditRepository } = createLab({
    async pauseSettlementConsumer() {
      throw new OpsConsoleError("FAULT_LAB_UPSTREAM_FAILED", 403, "Fault lab is disabled");
    }
  });
  await assert.rejects(lab.pauseSettlement(session, {}), /disabled/);
  const logs = await auditRepository.list({ action: "fault_lab.settlement.pause", limit: 10, offset: 0 });
  assert.equal(logs.items[0]?.status, "failed");
  assert.equal(logs.items[0]?.errorCode, "FAULT_LAB_UPSTREAM_FAILED");
});

test("engine reset reports anomalies before / after and recover-all repairs only drifted books", async () => {
  const { lab, calls } = createLab();
  const reset = await lab.resetEngine(session, { market: "ETH-USDT" });
  assert.equal(reset.anomalyCountBefore, 0);
  assert.equal(reset.anomalyCountAfter, 1);
  assert.ok(calls.includes("engine.reset:ETH-USDT:false"));

  const recovered = await lab.recoverAll(session);
  assert.equal(recovered.failedCount, 0);
  assert.deepEqual(
    recovered.steps.map((step) => `${step.step}=${step.status}`),
    [
      "settlement.resume=succeeded",
      "custody.clear=succeeded",
      "chain.resume=succeeded",
      // Every configured market is checked; only the drifted one is replayed.
      ...listSpotMarkets({ includeDelisted: true }).map((market) =>
        market === "ETH-USDT" ? "engine.replay:ETH-USDT=succeeded" : `engine.replay:${market}=skipped`
      ),
      "indexer.reorg_acknowledge=succeeded"
    ]
  );
  assert.ok(calls.includes("engine.replay:ETH-USDT"));
  assert.ok(!calls.includes("engine.replay:BTC-USDT"));
});

test("fault lab write endpoints require every admin permission; status is readable by all roles", () => {
  const read = (method: keyof FaultLabController) =>
    Reflect.getMetadata(OPS_PERMISSIONS_KEY, FaultLabController.prototype[method]) as string[];
  assert.deepEqual(read("getStatus"), ["ops.dashboard.read"]);
  for (const method of [
    "pauseSettlement",
    "resumeSettlement",
    "injectCustodyFailure",
    "probeCustody",
    "clearCustodyFailure",
    "haltChain",
    "resumeChain",
    "seedLabDeposit",
    "triggerReorg",
    "acknowledgeReorg",
    "resetEngine",
    "recoverAll"
  ] as const) {
    assert.deepEqual(read(method), [...FAULT_LAB_PERMISSIONS], method);
  }
});
