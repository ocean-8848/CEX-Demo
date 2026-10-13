import {
  CONTROL_SWITCH_SCOPES,
  controlSwitchKey,
  isAssetCode,
  listAssetCodes,
  type ControlSwitchScope,
  type ControlSwitchState
} from "@web3-cex/domain";

import {
  classifyAlert,
  summarizeAlerts,
  type AlertSeverity,
  type ClassifiedAlert
} from "../domain/alert-severity.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import {
  CONTROLS_MANAGE_PERMISSION,
  type OpsControlSwitchClient,
  type OpsReconciliationClient,
  type OpsReconciliationJobStatus,
  type OpsReconciliationRun
} from "../domain/controls.js";
import { OpsConsoleError } from "../domain/errors.js";
import type { AuditedActionOptions } from "./ops-console-application-service.js";

type AuditedRunner = <T>(options: AuditedActionOptions, operation: () => Promise<T>) => Promise<T>;

export interface AlertSourceView {
  source: string;
  status: "ok" | "alert" | "unknown";
  alerts: string[];
  summary?: unknown;
  items?: ClassifiedAlert[];
  highestSeverity?: AlertSeverity | null;
}

export interface AlertsOverviewView {
  generatedAt: string;
  status: "ok" | "alert";
  alertCount: number;
  sources: AlertSourceView[];
  items?: ClassifiedAlert[];
  countsBySeverity?: Record<AlertSeverity, number>;
  highestSeverity?: AlertSeverity | null;
}

const SETTLEMENT_LAG_WARNING = 10;
const SETTLEMENT_LAG_CRITICAL = 50;

/**
 * 系统运维 → 紧急开关, 账本对账 → 定时对账 / 熔断, and the P1/P2/P3 alert view.
 * Switch changes are audited (`controls.*`) and need ops.controls.manage.
 */
export class OpsControlsApplicationService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      switches: OpsControlSwitchClient;
      reconciliation: OpsReconciliationClient;
      runAudited: AuditedRunner;
      /** Existing ledger / indexer / custody / wallet sources. */
      baseAlerts: () => Promise<{
        sources: Array<{ source: string; status: string; alerts: string[]; summary?: unknown }>;
      }>;
      settlementReport?: () => Promise<Record<string, unknown>>;
      settlementConsumer?: () => Promise<Record<string, unknown>>;
      now?: () => Date;
    }
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async getControls() {
    const [state, events, reconciliation] = await Promise.all([
      this.deps.switches.getState(),
      this.deps.switches.listEvents(30).catch(() => ({ items: [] })),
      this.deps.reconciliation.listRuns(1).catch(() => null)
    ]);
    return {
      generatedAt: this.now().toISOString(),
      assets: listAssetCodes(),
      state,
      events: events.items,
      reconciliation: reconciliation
        ? { job: reconciliation.job, latestRun: reconciliation.items[0] ?? null }
        : null
    };
  }

  async setControl(
    session: OpsSessionInfo,
    command: { scope?: string; assetCode?: string; enabled?: unknown; reason?: string }
  ) {
    const scope = command.scope as ControlSwitchScope;
    if (!CONTROL_SWITCH_SCOPES.includes(scope)) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, `scope must be one of ${CONTROL_SWITCH_SCOPES.join(", ")}`);
    }
    if (typeof command.enabled !== "boolean") {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "enabled must be true or false");
    }
    const reason = command.reason?.trim();
    if (!reason) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "A reason is required for every emergency switch change");
    }
    const assetCode = scope === "withdrawals_asset" ? command.assetCode?.trim().toUpperCase() : undefined;
    if (scope === "withdrawals_asset" && (!assetCode || !isAssetCode(assetCode))) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, `assetCode must be one of ${listAssetCodes().join(", ")}`);
    }
    if (!command.enabled && scope === "withdrawals_asset" && assetCode) {
      await this.assertBreakerMayResume(assetCode);
    }

    const enabled = command.enabled;
    return this.deps.runAudited(
      {
        session,
        permission: CONTROLS_MANAGE_PERMISSION,
        action: `controls.${scope}.${enabled ? "enable" : "disable"}`,
        targetType: "control_switch",
        targetId: controlSwitchKey(scope, assetCode),
        requestPayload: { scope, assetCode, enabled, reason }
      },
      () =>
        this.deps.switches.setSwitch({
          scope,
          assetCode,
          enabled,
          reason,
          operator: session.email ?? session.userId
        })
    );
  }

  async getReconciliation(limit = 20) {
    return this.deps.reconciliation.listRuns(Math.min(Math.max(Math.trunc(limit), 1), 100));
  }

  runReconciliation(session: OpsSessionInfo) {
    return this.deps.runAudited(
      {
        session,
        permission: "ops.ledger.execute",
        action: "ledger.reconciliation.run_job",
        targetType: "reconciliation_job",
        targetId: "ledger-service",
        requestPayload: {}
      },
      () => this.deps.reconciliation.runNow()
    );
  }

  /** Existing sources + emergency switches + reconciliation + trading, each alert with a P-level. */
  async getAlertsOverview(): Promise<AlertsOverviewView> {
    const [base, controls, reconciliation, trading] = await Promise.all([
      this.deps.baseAlerts(),
      this.controlsSource(),
      this.reconciliationSource(),
      this.tradingSource()
    ]);
    const sources: AlertSourceView[] = [
      ...base.sources.map((source) =>
        withItems(
          { ...source, status: source.status === "alert" ? "alert" : "ok" },
          source.alerts.map((alert) => classifyAlert(source.source, alert))
        )
      ),
      reconciliation,
      controls,
      trading
    ];
    const summary = summarizeAlerts(sources.flatMap((source) => source.items ?? []));
    return {
      generatedAt: this.now().toISOString(),
      status: sources.some((source) => source.status === "alert") ? "alert" : "ok",
      alertCount: summary.items.length,
      sources,
      items: summary.items,
      countsBySeverity: summary.countsBySeverity,
      highestSeverity: summary.highestSeverity
    };
  }

  /**
   * B04: resuming an asset the breaker paused needs at least one completed
   * reconciliation run after the pause in which that asset is clean.
   */
  private async assertBreakerMayResume(assetCode: string): Promise<void> {
    const state = await this.deps.switches.getState();
    const pause = state.assetWithdrawalPauses.find((entry) => entry.assetCode === assetCode);
    if (!pause || pause.source !== "automatic") {
      return;
    }
    const { items } = await this.deps.reconciliation.listRuns(1);
    const latest = items[0];
    const clean =
      latest &&
      latest.status !== "failed" &&
      Date.parse(latest.startedAt) > Date.parse(pause.updatedAt) &&
      !runMismatchedAssets(latest).includes(assetCode);
    if (!clean) {
      throw new OpsConsoleError(
        "RECONCILIATION_NOT_CLEAN",
        409,
        `${assetCode} was paused by the reconciliation breaker; run reconciliation and resume only after a clean run`
      );
    }
  }

  private async controlsSource(): Promise<AlertSourceView> {
    try {
      const state = await this.deps.switches.getState();
      const items: ClassifiedAlert[] = [];
      if (state.withdrawalsPaused) {
        items.push(classifyAlert("controls", `withdrawals_paused: ${state.withdrawalsPaused.reason ?? ""}`.trim(), "withdrawals_paused"));
      }
      for (const entry of state.assetWithdrawalPauses.filter((item) => item.source === "manual")) {
        items.push(
          classifyAlert("controls", `asset_withdrawals_paused:${entry.assetCode}: ${entry.reason ?? ""}`.trim(), "asset_withdrawals_paused")
        );
      }
      if (state.apiWriteFrozen) {
        items.push(classifyAlert("controls", `api_write_frozen: ${state.apiWriteFrozen.reason ?? ""}`.trim(), "api_write_frozen"));
      }
      return withItems({ source: "controls", status: "ok", alerts: [], summary: summarizeState(state) }, items);
    } catch (error) {
      return unavailable("controls", error);
    }
  }

  private async reconciliationSource(): Promise<AlertSourceView> {
    try {
      const [{ job, items: runs }, state] = await Promise.all([
        this.deps.reconciliation.listRuns(1),
        this.deps.switches.getState().catch(() => null)
      ]);
      const latest = runs[0];
      const items: ClassifiedAlert[] = [];
      for (const entry of state?.assetWithdrawalPauses.filter((item) => item.source === "automatic") ?? []) {
        items.push(
          classifyAlert(
            "reconciliation",
            `${entry.assetCode} withdrawals paused by the reconciliation breaker: ${entry.reason ?? ""}`.trim(),
            "RECONCILIATION_BREAKER_TRIPPED"
          )
        );
      }
      for (const alert of latest?.alerts ?? []) {
        // The live switch state above is the truth for "paused"; a resumed asset is no longer P1.
        if (alert.code === "RECONCILIATION_BREAKER_TRIPPED") {
          continue;
        }
        items.push(classifyAlert("reconciliation", alert.message, alert.code));
      }
      if (isStale(job, latest, this.now())) {
        items.push(
          classifyAlert(
            "reconciliation",
            `last reconciliation run ${latest?.completedAt ?? "never"} is older than 3 × ${job.intervalSeconds}s`,
            "RECONCILIATION_STALE"
          )
        );
      }
      return withItems(
        {
          source: "reconciliation",
          status: "ok",
          alerts: [],
          summary: {
            job,
            latestRun: latest
              ? {
                  runId: latest.runId,
                  status: latest.status,
                  startedAt: latest.startedAt,
                  balanceMismatchCount: latest.balance?.mismatchCount ?? null,
                  orderLockMismatchCount: latest.orderLock?.mismatchCount ?? null,
                  orderLockInFlightCount: latest.orderLock?.inFlightCount ?? null
                }
              : null
          }
        },
        items
      );
    } catch (error) {
      return unavailable("reconciliation", error);
    }
  }

  private async tradingSource(): Promise<AlertSourceView> {
    const items: ClassifiedAlert[] = [];
    const summary: Record<string, unknown> = {};
    const errors: string[] = [];
    if (this.deps.settlementReport) {
      try {
        const report = await this.deps.settlementReport();
        const totals = (report.totals ?? {}) as { failedCount?: number; pendingRecoveryCount?: number };
        summary.settlement = totals;
        if ((totals.failedCount ?? 0) > 0) {
          items.push(classifyAlert("trading", `settlement_failed_count=${totals.failedCount} exceeds threshold 0`));
        }
        if ((totals.pendingRecoveryCount ?? 0) > 0) {
          items.push(
            classifyAlert("trading", `settlement_pending_recovery_count=${totals.pendingRecoveryCount} exceeds threshold 0`)
          );
        }
      } catch (error) {
        errors.push(readMessage(error));
      }
    }
    if (this.deps.settlementConsumer) {
      try {
        const consumer = await this.deps.settlementConsumer();
        const pause = consumer.pause as { paused?: boolean; reason?: string } | undefined;
        const lag = Array.isArray(consumer.lag) ? (consumer.lag as Array<{ market?: string; executionSequenceLag?: number }>) : [];
        const worst = lag.reduce<{ market?: string; executionSequenceLag?: number } | null>(
          (current, item) => ((item.executionSequenceLag ?? 0) > (current?.executionSequenceLag ?? -1) ? item : current),
          null
        );
        summary.consumer = { paused: Boolean(pause?.paused), lag };
        if (pause?.paused) {
          items.push(classifyAlert("trading", `settlement_consumer_paused: ${pause.reason ?? "fault lab"}`, "settlement_consumer_paused"));
        }
        const worstLag = worst?.executionSequenceLag ?? 0;
        if (worstLag >= SETTLEMENT_LAG_CRITICAL) {
          items.push(classifyAlert("trading", `settlement_lag_critical:${worst?.market}=${worstLag} exceeds threshold ${SETTLEMENT_LAG_CRITICAL}`));
        } else if (worstLag >= SETTLEMENT_LAG_WARNING) {
          items.push(classifyAlert("trading", `settlement_lag:${worst?.market}=${worstLag} exceeds threshold ${SETTLEMENT_LAG_WARNING}`));
        }
      } catch (error) {
        errors.push(readMessage(error));
      }
    }
    if (errors.length > 0) {
      summary.errors = errors;
    }
    const view = withItems({ source: "trading", status: "ok", alerts: [], summary }, items);
    return errors.length > 0 && items.length === 0 ? { ...view, status: "unknown" } : view;
  }
}

function withItems(source: AlertSourceView, items: ClassifiedAlert[]): AlertSourceView {
  const summary = summarizeAlerts(items);
  return {
    ...source,
    status: items.length > 0 ? "alert" : source.status === "unknown" ? "unknown" : "ok",
    alerts: summary.items.map((item) => item.message),
    items: summary.items,
    highestSeverity: summary.highestSeverity
  };
}

function unavailable(source: string, error: unknown): AlertSourceView {
  return withItems({ source, status: "unknown", alerts: [], summary: { error: readMessage(error) } }, [
    classifyAlert(source, `${source}_unavailable: ${readMessage(error)}`, "SOURCE_UNAVAILABLE")
  ]);
}

function summarizeState(state: ControlSwitchState) {
  return {
    withdrawalsPaused: Boolean(state.withdrawalsPaused),
    pausedAssets: state.assetWithdrawalPauses.map((entry) => `${entry.assetCode}${entry.source === "automatic" ? " (auto)" : ""}`),
    apiWriteFrozen: Boolean(state.apiWriteFrozen)
  };
}

export function runMismatchedAssets(run: OpsReconciliationRun): string[] {
  return [...new Set([...(run.balance?.mismatchedAssets ?? []), ...(run.orderLock?.mismatchedAssets ?? [])])];
}

function isStale(job: OpsReconciliationJobStatus, latest: OpsReconciliationRun | undefined, now: Date): boolean {
  if (!job.enabled || job.intervalSeconds <= 0 || !latest) {
    return false;
  }
  return now.getTime() - Date.parse(latest.completedAt) > job.intervalSeconds * 3000;
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
