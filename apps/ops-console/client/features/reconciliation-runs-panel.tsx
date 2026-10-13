import { useState } from "react";

import { Badge, Button, Empty, Panel, formatAmount, href } from "@web3-cex/web-ui";

import type { ControlsReport, ReconciliationJobStatus, ReconciliationRun } from "../lib/types.js";
import { IdLink, JsonView, QueryView, RefreshButton, StatCard, StatusBadge, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

const STATUS_LABEL: Record<string, string> = {
  ok: "一致",
  suspected: "可疑（待确认）",
  mismatch: "不一致",
  partial: "部分完成",
  failed: "失败"
};

const OUTCOME_LABEL: Record<string, string> = {
  paused: "已自动暂停提现",
  already_paused: "提现已处于暂停",
  failed: "暂停失败",
  disabled: "熔断关闭，仅告警"
};

/**
 * 账本对账 → 定时对账与熔断: ledger-service runs balance + order-vs-lock
 * reconciliation on a schedule; a mismatch pauses that asset's withdrawals.
 */
export function ReconciliationJobPanel() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const runs = useOpsQuery<{ job: ReconciliationJobStatus; items: ReconciliationRun[] }>("/ledger/reconciliation/runs?limit=20", { refreshMs: 15_000 });
  const controls = useOpsQuery<ControlsReport>("/controls", { refreshMs: 15_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const breakerPauses = (controls.data?.state.assetWithdrawalPauses ?? []).filter((entry) => entry.source === "automatic");
  const job = runs.data?.job;
  const latest = runs.data?.items[0];
  const detail = runs.data?.items.find((item) => item.runId === selected) ?? latest;

  return (
    <Panel
      title="定时对账与熔断"
      id="reconciliation-job-panel"
      actions={
        <span className="panel-actions">
          {can("ops.ledger.execute") ? (
            <Button
              size="sm"
              variant="primary"
              loading={busy === "recon-job"}
              id="run-reconciliation-job"
              onClick={async () => {
                await run<ReconciliationRun>(
                  "recon-job",
                  { path: "/ledger/reconciliation/jobs/run" },
                  { success: "对账任务已运行", detail: (result) => `结果：${STATUS_LABEL[result.status] ?? result.status}` }
                );
                runs.reload();
                controls.reload();
              }}
            >
              立即运行
            </Button>
          ) : null}
          <RefreshButton onClick={() => { runs.reload(); controls.reload(); }} loading={runs.loading} updatedAt={runs.updatedAt} />
        </span>
      }
    >
      <div className="stat-grid compact">
        <StatCard
          label="调度"
          value={job ? (job.enabled ? `每 ${job.intervalSeconds} 秒` : "未开启") : "--"}
          hint={job?.nextRunAt ? `下次 ${new Date(job.nextRunAt).toLocaleTimeString()}` : "可手动运行"}
        />
        <StatCard
          label="最近结果"
          value={latest ? <StatusBadge status={latest.status} label={STATUS_LABEL[latest.status] ?? latest.status} /> : "--"}
          hint={latest ? `余额不一致 ${latest.balance?.mismatchCount ?? "--"} · 冻结不一致 ${latest.orderLock?.mismatchCount ?? "--"}` : undefined}
        />
        <StatCard
          label="熔断"
          value={job ? (job.breakerEnabled ? "已开启" : "已关闭") : "--"}
          hint={job ? `冻结对账需连续 ${job.confirmations} 轮 · 在途宽限 ${Math.round(job.graceMs / 1000)}s` : undefined}
        />
        <StatCard
          label="熔断暂停中的币种"
          value={breakerPauses.length ? breakerPauses.map((entry) => entry.assetCode).join(", ") : "无"}
          tone={breakerPauses.length ? "negative" : "positive"}
          hint="在 系统运维 → 紧急开关 中人工恢复"
          href={href("/system?tab=controls")}
        />
      </div>
      <QueryView state={runs} empty={(data) => data.items.length === 0} emptyTitle="还没有对账记录" emptyHint="定时任务运行后，或点击「立即运行」后显示。">
        {(data) => (
          <div className="table-scroll">
            <table className="data-table compact" id="reconciliation-runs">
              <thead>
                <tr>
                  <th>开始时间</th><th>触发</th><th>结果</th>
                  <th className="num">余额扫描 / 不一致</th>
                  <th className="num">委托冻结 一致 / 在途 / 不一致</th>
                  <th>熔断动作</th><th className="num">耗时</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr
                    key={item.runId}
                    className={item.status === "mismatch" ? "row-alert" : item.runId === detail?.runId ? "row-highlight" : ""}
                    onClick={() => setSelected(item.runId)}
                    style={{ cursor: "pointer" }}
                  >
                    <td><Time value={item.startedAt} /></td>
                    <td className="muted">{item.trigger === "manual" ? "手动" : "定时"}</td>
                    <td><StatusBadge status={item.status} label={STATUS_LABEL[item.status] ?? item.status} /></td>
                    <td className="num">{item.balance ? `${item.balance.scannedCount ?? 0} / ${item.balance.mismatchCount ?? 0}` : "--"}</td>
                    <td className="num">
                      {item.orderLock
                        ? `${item.orderLock.matchedCount ?? 0} / ${item.orderLock.inFlightCount ?? 0} / ${item.orderLock.mismatchCount ?? 0}`
                        : <span className="muted" title={item.orderLockError}>不可用</span>}
                    </td>
                    <td className="small">
                      {(item.breaker?.actions ?? []).length === 0
                        ? <span className="muted">--</span>
                        : item.breaker?.actions?.map((action) => (
                            <Badge key={action.assetCode} tone={action.outcome === "failed" ? "negative" : "warning"}>
                              {action.assetCode} {OUTCOME_LABEL[action.outcome] ?? action.outcome}
                            </Badge>
                          ))}
                    </td>
                    <td className="num muted">{item.durationMs ?? 0} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
      {detail ? <RunDetail run={detail} /> : null}
      <ol className="explain-steps">
        <li><b>余额对账</b>：同一快照内比较分录净额、活跃冻结与余额快照；不一致说明账本本身出错，熔断立即暂停该币种提现。</li>
        <li><b>委托冻结对账</b>：order-service 给出每笔委托仍需冻结的金额（未成交部分 + 已成交未结算部分），与账本 spot_order 冻结逐笔比较。</li>
        <li><b>在途处理</b>：两边读取有先后，刚下单、刚成交、恢复中的委托算「在途」不计入；同一委托连续多轮不一致才触发熔断，首次只给 P2 告警。</li>
        <li><b>恢复</b>：熔断暂停只能人工恢复，且必须在之后至少一轮对账恢复一致。</li>
      </ol>
    </Panel>
  );
}

function RunDetail(props: { run: ReconciliationRun }) {
  const { run } = props;
  const orderLock = run.orderLock;
  return (
    <div className="page-stack" id="reconciliation-run-detail">
      <h4 className="small">
        对账记录 <code>{run.runId.slice(0, 8)}</code> · <Time value={run.startedAt} />
      </h4>
      {(run.alerts ?? []).length > 0 ? (
        <ul className="alert-list">
          {run.alerts?.map((alert, index) => (
            <li key={`${alert.code}:${index}`} className={`sev-${alert.level}`}>
              <Badge tone={alert.level === "P1" ? "negative" : alert.level === "P2" ? "warning" : "neutral"}>{alert.level}</Badge>
              <span>{alert.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {orderLock && (orderLock.items ?? []).length > 0 ? (
        <div className="table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>账户</th><th>币种</th>
                <th className="num">账本冻结</th><th className="num">其中委托冻结</th><th className="num">其中提现等</th>
                <th className="num">委托应冻结</th><th className="num">差额</th><th>结果</th>
              </tr>
            </thead>
            <tbody>
              {orderLock.items?.map((item) => (
                <tr key={`${item.accountId}:${item.assetCode}`} className={item.status === "mismatch" ? "row-alert" : ""}>
                  <td><IdLink id={item.accountId} kind="accountId" /></td>
                  <td>{item.assetCode}</td>
                  <td className="num">{formatAmount(item.ledgerLocked)}</td>
                  <td className="num">{formatAmount(item.ledgerOrderLocked)}</td>
                  <td className="num">{formatAmount(item.ledgerOtherLocked)}</td>
                  <td className="num">{formatAmount(item.orderExpectedLocked)}</td>
                  <td className="num">{formatAmount(item.difference)}</td>
                  <td>
                    {item.status === "mismatch" ? <Badge tone="negative">不一致 {item.mismatchCount}</Badge> : <Badge tone="info">在途 {item.inFlightCount}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : orderLock ? (
        <Empty icon="✓" title="委托冻结与账本冻结一致" hint={`比对 ${orderLock.scannedOrders ?? 0} 笔委托 / ${orderLock.scannedAccountAssets ?? 0} 个账户币种`} />
      ) : null}
      <JsonView value={run} label="完整记录" />
    </div>
  );
}
