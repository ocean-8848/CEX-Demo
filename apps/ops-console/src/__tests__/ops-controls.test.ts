import assert from "node:assert/strict";
import test from "node:test";

import { buildControlSwitchState, type ControlSwitchEntry } from "@web3-cex/domain";

import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import { OpsControlsApplicationService } from "../application/ops-controls-application-service.js";
import {
  ALERT_SEVERITY_RULES,
  alertMetricKey,
  classifyAlert,
  summarizeAlerts,
  tradeRuntimeAlertLevel
} from "../domain/alert-severity.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import type { OpsControlSwitchClient, OpsReconciliationClient, OpsReconciliationRun } from "../domain/controls.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";

const session = {
  sessionId: "s",
  userId: "ops-admin",
  email: "ops@example.com",
  roles: ["ops_admin"],
  permissions: ["ops.controls.manage"],
  createdAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-10T12:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
  active: true,
  status: "active"
} as OpsSessionInfo;

const unused = new Proxy({}, { get: () => async () => { throw new Error("unexpected upstream call"); } }) as never;

test("severity rules: every existing alert source maps to a level", () => {
  assert.equal(alertMetricKey("deposit_cursor_lag_blocks:ethereum=12 exceeds threshold 5"), "deposit_cursor_lag_blocks");
  assert.equal(classifyAlert("ledger", "balance_mismatch_count=2 exceeds threshold 0").severity, "P1");
  assert.equal(classifyAlert("ledger", "negative_available_balance_count=1 exceeds threshold 0").severity, "P1");
  assert.equal(classifyAlert("ledger", "dead_lettered_outbox_count=1 exceeds threshold 0").severity, "P2");
  assert.equal(classifyAlert("ledger", "pending_outbox_count=200 exceeds threshold 100").severity, "P3");
  assert.equal(classifyAlert("custody", "open_circuit_count=1 exceeds threshold 0").severity, "P2");
  assert.equal(classifyAlert("indexer", "reorg_cursor_count=1 exceeds threshold 0").severity, "P2");
  assert.equal(classifyAlert("indexer", "deposit_cursor_lag_blocks:ethereum=30 exceeds threshold 20").severity, "P3");
  assert.equal(classifyAlert("wallet", "failed_notifications=3 exceeds threshold 0").severity, "P3");
  assert.equal(classifyAlert("reconciliation", "x", "RECONCILIATION_BREAKER_TRIPPED").severity, "P1");
  assert.equal(classifyAlert("reconciliation", "x", "ORDER_LOCK_MISMATCH_SUSPECTED").severity, "P2");
  assert.equal(classifyAlert("unknown-source", "something_new=1").severity, "P2", "unknown alerts default to P2");
  assert.equal(tradeRuntimeAlertLevel("SETTLEMENT_FAILED", "critical"), "P2");
  assert.equal(tradeRuntimeAlertLevel("TRADE_RUNTIME_SCHEDULE_DUE", "critical"), "P2", "critical is never below P2");
  assert.equal(tradeRuntimeAlertLevel("TRADE_RUNTIME_SCHEDULE_DUE", "warning"), "P3");
  for (const rule of ALERT_SEVERITY_RULES) {
    assert.ok(["P1", "P2", "P3"].includes(rule.severity), `${rule.source}:${rule.key}`);
  }
});

test("summarizeAlerts sorts P1 → P3 and counts per level", () => {
  const summary = summarizeAlerts([
    classifyAlert("wallet", "pending_notifications=30 exceeds threshold 20"),
    classifyAlert("ledger", "balance_mismatch_count=1 exceeds threshold 0"),
    classifyAlert("custody", "open_circuit_count=1 exceeds threshold 0")
  ]);
  assert.deepEqual(summary.items.map((item) => item.severity), ["P1", "P2", "P3"]);
  assert.deepEqual(summary.countsBySeverity, { P1: 1, P2: 1, P3: 1 });
  assert.equal(summary.highestSeverity, "P1");
});

function entry(partial: Partial<ControlSwitchEntry> & Pick<ControlSwitchEntry, "scope">): ControlSwitchEntry {
  return { reason: "r", source: "manual", updatedBy: "ops", updatedAt: "2026-10-10T08:00:00.000Z", ...partial };
}

function harness(options: { entries?: ControlSwitchEntry[]; runs?: OpsReconciliationRun[] } = {}) {
  let entries = options.entries ?? [];
  const calls: Array<Record<string, unknown>> = [];
  const switches: OpsControlSwitchClient = {
    async getState() {
      return buildControlSwitchState(entries, "2026-10-10T08:05:00.000Z");
    },
    async setSwitch(command) {
      calls.push(command);
      if (!command.enabled) {
        entries = entries.filter((item) => !(item.scope === command.scope && item.assetCode === command.assetCode));
      }
      return { changed: true };
    },
    async listEvents() {
      return { items: [] };
    }
  };
  const reconciliation: OpsReconciliationClient = {
    async listRuns() {
      return {
        job: { enabled: true, intervalSeconds: 30, graceMs: 15000, breakerEnabled: true, confirmations: 2 },
        items: options.runs ?? []
      };
    },
    async runNow() {
      throw new Error("unused");
    },
    async getDrift() {
      return {};
    },
    async injectDrift() {
      return {};
    },
    async clearDrift() {
      return {};
    }
  };
  const audit = new InMemoryOpsActionAuditRepository();
  const base = new OpsConsoleApplicationService(unused, unused, unused, unused, unused, unused, unused, audit, undefined, {});
  const service = new OpsControlsApplicationService({
    switches,
    reconciliation,
    runAudited: (opts, operation) => base.runAuditedAction(opts, operation),
    baseAlerts: async () => ({
      sources: [{ source: "ledger", status: "ok", alerts: [], summary: {} }]
    }),
    now: () => new Date("2026-10-10T08:05:10.000Z")
  });
  return { service, calls, audit };
}

const run = (partial: Partial<OpsReconciliationRun>): OpsReconciliationRun => ({
  runId: "run",
  trigger: "scheduled",
  status: "ok",
  startedAt: "2026-10-10T08:05:00.000Z",
  completedAt: "2026-10-10T08:05:01.000Z",
  balance: { scannedCount: 10, mismatchCount: 0, mismatchedAssets: [] },
  orderLock: { scannedOrders: 5, matchedCount: 5, inFlightCount: 0, mismatchCount: 0, mismatchedAssets: [] },
  alerts: [],
  ...partial
});

test("setControl needs a reason and a configured asset, and is audited", async () => {
  const { service, calls, audit } = harness();
  await assert.rejects(service.setControl(session, { scope: "api_write", enabled: true }), /reason is required/);
  await assert.rejects(service.setControl(session, { scope: "withdrawals_asset", assetCode: "DOGE", enabled: true, reason: "x" }), /assetCode/);
  await assert.rejects(service.setControl(session, { scope: "bogus", enabled: true, reason: "x" }), /scope/);
  await service.setControl(session, { scope: "withdrawals_asset", assetCode: "eth", enabled: true, reason: "hot wallet check" });
  assert.deepEqual(calls[0], { scope: "withdrawals_asset", assetCode: "ETH", enabled: true, reason: "hot wallet check", operator: "ops@example.com" });
  const logs = await audit.list({ limit: 10, offset: 0 });
  assert.equal(logs.items[0]?.action, "controls.withdrawals_asset.enable");
  assert.equal(logs.items[0]?.permission, "ops.controls.manage");
  assert.equal(logs.items[0]?.targetId, "withdrawals_asset:ETH");
});

test("resuming a breaker pause needs a clean reconciliation run after the pause", async () => {
  const pause = entry({ scope: "withdrawals_asset", assetCode: "SOL", source: "automatic", updatedAt: "2026-10-10T08:04:00.000Z" });
  const dirty = harness({ entries: [pause], runs: [run({ status: "mismatch", balance: { scannedCount: 1, mismatchCount: 1, mismatchedAssets: ["SOL"] } })] });
  await assert.rejects(
    dirty.service.setControl(session, { scope: "withdrawals_asset", assetCode: "SOL", enabled: false, reason: "checked" }),
    (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_NOT_CLEAN"
  );
  const stale = harness({ entries: [pause], runs: [run({ startedAt: "2026-10-10T08:03:00.000Z" })] });
  await assert.rejects(
    stale.service.setControl(session, { scope: "withdrawals_asset", assetCode: "SOL", enabled: false, reason: "checked" }),
    (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_NOT_CLEAN"
  );
  const clean = harness({ entries: [pause], runs: [run({})] });
  await clean.service.setControl(session, { scope: "withdrawals_asset", assetCode: "SOL", enabled: false, reason: "drift cleared" });
  assert.equal(clean.calls.length, 1);
  const manual = harness({ entries: [entry({ scope: "withdrawals_asset", assetCode: "SOL" })], runs: [] });
  await manual.service.setControl(session, { scope: "withdrawals_asset", assetCode: "SOL", enabled: false, reason: "done" });
  assert.equal(manual.calls.length, 1, "manual pauses resume without a reconciliation check");
});

test("alerts overview: breaker pause is P1, manual switches P2, sorted with counts", async () => {
  const { service } = harness({
    entries: [
      entry({ scope: "withdrawals_asset", assetCode: "SOL", source: "automatic" }),
      entry({ scope: "api_write", reason: "drill" })
    ],
    runs: [run({ status: "suspected", alerts: [{ level: "P2", code: "ORDER_LOCK_MISMATCH_SUSPECTED", message: "USDT: 1 order locks differ" }] })]
  });
  const overview = await service.getAlertsOverview();
  assert.equal(overview.status, "alert");
  assert.deepEqual(overview.countsBySeverity, { P1: 1, P2: 2, P3: 0 });
  assert.equal(overview.items?.[0]?.code, "RECONCILIATION_BREAKER_TRIPPED");
  assert.equal(overview.highestSeverity, "P1");
  assert.equal(overview.alertCount, 3);
  const sources = new Map(overview.sources.map((source) => [source.source, source]));
  assert.equal(sources.get("ledger")?.status, "ok");
  assert.equal(sources.get("reconciliation")?.highestSeverity, "P1");
  assert.equal(sources.get("controls")?.items?.[0]?.code, "api_write_frozen");
});

test("treasury, KYT and surveillance alerts get levels; coverage shortfall is P1 alert only", async () => {
  const now = new Date("2026-10-10T08:05:10.000Z");
  let pauses = 0;
  const service = new OpsControlsApplicationService({
    switches: {
      async getState() {
        return buildControlSwitchState([]);
      },
      async setSwitch() {
        pauses += 1;
        return {};
      },
      async listEvents() {
        return { items: [] };
      }
    },
    reconciliation: {
      async listRuns() {
        return { job: { enabled: false, intervalSeconds: 0, graceMs: 0, breakerEnabled: true, confirmations: 2 }, items: [] };
      },
      async runNow() {
        throw new Error("unused");
      },
      async getDrift() {
        return {};
      },
      async injectDrift() {
        return {};
      },
      async clearDrift() {
        return {};
      }
    },
    runAudited: (_options, operation) => operation(),
    baseAlerts: async () => ({ sources: [] }),
    treasuryReconciliation: async () => ({
      status: "shortfall",
      shortfallCount: 1,
      items: [
        { assetCode: "ETH", status: "shortfall", reserves: "90", netLiabilities: "100", surplus: "-10" },
        { assetCode: "USDT", status: "covered", reserves: "1000", netLiabilities: "900", surplus: "100" }
      ]
    }),
    failedTreasuryTransfers: async () => ({
      items: [
        { kind: "sweep", status: "failed" },
        { kind: "rebalance_to_cold", status: "failed" }
      ]
    }),
    blockedWithdrawals: async () => ({
      items: [
        { riskLevel: "blocked", requestedAt: "2026-10-10T07:00:00.000Z" },
        { riskLevel: "blocked", requestedAt: "2026-10-01T07:00:00.000Z" }
      ]
    }),
    highRiskReviewQueue: async () => ({ items: [{}], total: 2 }),
    surveillanceOverview: async () => ({ openByType: { wash_trade: 1, spoofing: 0, concentrated_volume: 3, price_move: 0 } }),
    now: () => now
  });
  const overview = await service.getAlertsOverview();
  const byCode = new Map((overview.items ?? []).map((item) => [item.code, item]));
  assert.equal(byCode.get("reserve_coverage_shortfall")?.severity, "P1");
  assert.match(byCode.get("reserve_coverage_shortfall")?.message ?? "", /ETH/);
  assert.equal(byCode.get("treasury_transfer_failed")?.severity, "P2");
  assert.equal(byCode.get("treasury_sweep_failed")?.severity, "P2");
  assert.equal(byCode.get("blocked_withdrawals_24h")?.severity, "P2");
  assert.match(byCode.get("blocked_withdrawals_24h")?.message ?? "", /=1 /, "only the last 24h count");
  assert.equal(byCode.get("high_risk_withdrawals_pending")?.severity, "P2");
  assert.equal(byCode.get("surveillance_open_wash_trade")?.severity, "P2");
  assert.equal(byCode.get("surveillance_open_concentrated_volume")?.severity, "P3");
  assert.equal(byCode.has("surveillance_open_spoofing"), false);
  assert.equal(overview.items?.[0]?.code, "reserve_coverage_shortfall", "P1 first");
  assert.equal(pauses, 0, "a coverage shortfall never pauses withdrawals");
});
