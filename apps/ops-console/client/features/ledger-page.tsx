import { useEffect, useState, type FormEvent } from "react";

import { Badge, Button, Empty, Panel, formatAmount, toNumber } from "@web3-cex/web-ui";

import { qs, readErrorMessage } from "../lib/api.js";
import type { LedgerOverview, ReconciliationItem, ReconciliationReport } from "../lib/types.js";
import { IdLink, JsonView, PageHeader, QueryView, RefreshButton, StatCard, StatusBadge, Time } from "../components/kit.js";
import { useMarketConfig, useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";
import { AssetOptions } from "../components/market-options.js";

interface ReplayStep {
  at: string;
  type: string;
  amount: string;
  referenceType?: string;
  referenceId?: string;
  availableAfter: string;
  lockedAfter: string;
  description?: string;
}

interface ReplayReport {
  accountId: string;
  assetCode: string;
  snapshotAvailable: string;
  snapshotLocked: string;
  reconstructedAvailable: string;
  reconstructedLocked: string;
  mismatch: boolean;
  steps: ReplayStep[];
}

const STEP_LABEL: Record<string, string> = {
  entry_credit: "分录入账",
  entry_debit: "分录出账",
  lock: "冻结",
  release: "解冻",
  consume: "消耗",
  settle: "结算解冻"
};

export function LedgerPage() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [includeMatched, setIncludeMatched] = useState(false);
  const [replayTarget, setReplayTarget] = useState<{ accountId: string; assetCode: string } | null>(null);
  const overview = useOpsQuery<LedgerOverview>("/ledger/overview", { refreshMs: 15_000 });
  const reconciliation = useOpsQuery<ReconciliationReport>(`/ledger/reconciliation${qs({ includeMatched })}`);

  return (
    <div className="page">
      <PageHeader
        title="账本对账"
        subtitle="ledger-service 是资金事实源：余额快照必须等于分录净额减去活跃冻结"
        actions={<RefreshButton onClick={() => { overview.reload(); reconciliation.reload(); }} loading={overview.loading || reconciliation.loading} />}
      />
      <div className="stat-grid">
        <StatCard
          label="对账结果"
          value={overview.data?.reconciliation ? (overview.data.reconciliation.mismatchCount ? `${overview.data.reconciliation.mismatchCount} 处不一致` : "全部一致") : "--"}
          tone={overview.data?.reconciliation?.mismatchCount ? "negative" : "positive"}
          hint={`扫描 ${overview.data?.reconciliation?.scannedCount ?? "--"} 个余额`}
        />
        <StatCard label="活跃冻结" value={overview.data?.locks?.activeCount ?? "--"} hint={`超过 ${overview.data?.locks?.staleThresholdMinutes ?? 30} 分钟：${overview.data?.locks?.staleCount ?? 0}`} tone={overview.data?.locks?.staleCount ? "warning" : "neutral"} />
        <StatCard
          label="Outbox 待发布"
          value={overview.data?.outbox?.pendingCount ?? "--"}
          tone={overview.data?.outbox?.pendingCount ? "warning" : "positive"}
          hint="账本事件发往 Kafka 的待发队列"
        />
        <StatCard label="死信" value={overview.data?.outbox?.deadLetteredCount ?? "--"} tone={overview.data?.outbox?.deadLetteredCount ? "negative" : "positive"} />
      </div>

      {overview.data?.alerts?.length ? (
        <Panel title="账本告警">
          <ul className="alert-list">
            {overview.data.alerts.map((alert) => (
              <li key={alert}><span className="alert-source">ledger</span><span>{alert}</span></li>
            ))}
          </ul>
          {can("ops.ledger.execute") ? (
            <div className="panel-footer">
              <Button
                size="sm"
                loading={busy === "drain"}
                onClick={async () => {
                  await run("drain", { path: "/ledger/outbox/drain", body: { maxCycles: 5 } }, { success: "Outbox 已投递一轮" });
                  overview.reload();
                }}
              >
                投递 Outbox 事件
              </Button>
              <span className="muted small">stack:start 会常驻运行 ledger-outbox-publisher；积压持续增长通常意味着 publisher 或 Kafka 异常。</span>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        title="余额对账"
        flush
        actions={
          <span className="panel-actions">
            <label className="scope-toggle">
              <input type="checkbox" checked={includeMatched} onChange={(event) => setIncludeMatched(event.target.checked)} />
              显示一致的余额
            </label>
            {can("ops.ledger.execute") ? (
              <Button
                size="sm"
                variant="primary"
                loading={busy === "reconcile"}
                onClick={async () => {
                  await run<ReconciliationReport>(
                    "reconcile",
                    { path: "/ledger/reconciliation/run", body: { includeMatched } },
                    { success: "对账完成", detail: (result) => `扫描 ${result.scannedCount}，不一致 ${result.mismatchCount}` }
                  );
                  reconciliation.reload();
                  overview.reload();
                }}
              >
                重新对账
              </Button>
            ) : null}
          </span>
        }
      >
        <QueryView
          state={reconciliation}
          empty={(data) => !data.items?.length}
          emptyTitle="账本完全一致"
          emptyHint="每个余额快照都与分录净额、活跃冻结吻合。"
        >
          {(data) => (
            <div className="table-scroll">
              <table className="data-table" id="reconciliation-table">
                <thead>
                  <tr>
                    <th>账户</th><th>类型</th><th>币种</th>
                    <th className="num">分录净额</th><th className="num">活跃冻结</th>
                    <th className="num">快照可用</th><th className="num">快照冻结</th>
                    <th className="num">总额差</th><th className="num">冻结差</th><th>结果</th><th className="num">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.items ?? []).map((item: ReconciliationItem) => {
                    const totalDiff = toNumber(item.snapshotTotal) - toNumber(item.expectedTotal ?? item.journalNet);
                    const lockedDiff = toNumber(item.snapshotLocked) - toNumber(item.activeLocked);
                    const mismatch = Math.abs(totalDiff) > 1e-12 || Math.abs(lockedDiff) > 1e-12;
                    return (
                      <tr key={`${item.accountId}:${item.assetCode}`} className={mismatch ? "row-alert" : ""}>
                        <td><IdLink id={item.accountId} kind="accountId" /></td>
                        <td className="muted">{item.accountType}</td>
                        <td>{item.assetCode}</td>
                        <td className="num">{formatAmount(item.journalNet)}</td>
                        <td className="num">{formatAmount(item.activeLocked)}</td>
                        <td className="num">{formatAmount(item.snapshotAvailable)}</td>
                        <td className="num">{formatAmount(item.snapshotLocked)}</td>
                        <td className={`num ${Math.abs(totalDiff) > 1e-12 ? "down" : "muted"}`}>{formatAmount(totalDiff)}</td>
                        <td className={`num ${Math.abs(lockedDiff) > 1e-12 ? "down" : "muted"}`}>{formatAmount(lockedDiff)}</td>
                        <td>{mismatch ? <Badge tone="negative">不一致</Badge> : <Badge tone="positive">一致</Badge>}</td>
                        <td className="num">
                          <Button size="sm" variant="ghost" onClick={() => setReplayTarget({ accountId: item.accountId, assetCode: item.assetCode })}>
                            回放
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Panel>

      <ReplayPanel target={replayTarget} onTarget={setReplayTarget} />

      <Panel title="对账原理">
        <ol className="explain-steps">
          <li><b>分录净额</b>：该账户该币种所有 credit − debit，是不可篡改的历史事实。</li>
          <li><b>活跃冻结</b>：所有仍处于 locked 状态的冻结记录的剩余金额（下单、提现审核中）。</li>
          <li><b>期望值</b>：可用 = 分录净额 − 活跃冻结；冻结 = 活跃冻结。与余额快照逐项比较。</li>
          <li><b>回放</b>：按时间顺序重放分录与每一次冻结 / 解冻 / 结算，逐步展示余额如何演变，用来定位差异出现的那一步。</li>
        </ol>
      </Panel>
    </div>
  );
}

function ReplayPanel(props: { target: { accountId: string; assetCode: string } | null; onTarget: (value: { accountId: string; assetCode: string }) => void }) {
  const { api } = useSession();
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accountId, setAccountId] = useState("");
  const { assets } = useMarketConfig();
  const [selectedAsset, setAssetCode] = useState("");
  const assetCode = selectedAsset || (assets[0]?.code ?? "");

  const load = async (target: { accountId: string; assetCode: string }) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api<ReplayReport>(`/ledger/replay${qs(target)}`));
    } catch (replayError) {
      setReport(null);
      setError(readErrorMessage(replayError));
    } finally {
      setLoading(false);
    }
  };

  const key = props.target ? `${props.target.accountId}:${props.target.assetCode}` : "";
  useEffect(() => {
    if (!props.target) {
      return;
    }
    setAccountId(props.target.accountId);
    setAssetCode(props.target.assetCode);
    void load(props.target);
    document.getElementById("replay-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (accountId.trim()) {
      props.onTarget({ accountId: accountId.trim(), assetCode });
    }
  };

  const steps = report?.steps ?? [];
  return (
    <Panel title="账户回放" id="replay-panel">
      <form className="filters" onSubmit={submit}>
        <input className="filter-input wide" placeholder="ledger accountId" value={accountId} onChange={(event) => setAccountId(event.target.value)} />
        <select value={assetCode} onChange={(event) => setAssetCode(event.target.value)} aria-label="币种">
          <AssetOptions />
        </select>
        <Button size="sm" type="submit" loading={loading}>回放</Button>
      </form>
      {error ? <div className="form-error">{error}</div> : null}
      {report ? (
        <div className="replay-result">
          <div className="stat-grid compact">
            <StatCard label="快照可用 / 冻结" value={`${formatAmount(report.snapshotAvailable)} / ${formatAmount(report.snapshotLocked)}`} />
            <StatCard label="回放可用 / 冻结" value={`${formatAmount(report.reconstructedAvailable)} / ${formatAmount(report.reconstructedLocked)}`} />
            <StatCard label="结果" value={<StatusBadge status={report.mismatch ? "mismatch" : "matched"} label={report.mismatch ? "不一致" : "一致"} />} />
            <StatCard label="事件数" value={steps.length} />
          </div>
          {steps.length === 0 ? (
            <Empty title="没有历史事件" />
          ) : (
            <div className="table-scroll replay-table">
              <table className="data-table compact">
                <thead>
                  <tr><th>时间</th><th>事件</th><th className="num">金额</th><th>业务引用</th><th className="num">可用</th><th className="num">冻结</th></tr>
                </thead>
                <tbody>
                  {steps.slice(-200).map((step, index) => (
                    <tr key={`${step.at}:${index}`}>
                      <td><Time value={step.at} /></td>
                      <td><Badge tone={step.type.includes("credit") || step.type === "release" || step.type === "settle" ? "positive" : step.type === "lock" ? "info" : "warning"}>{STEP_LABEL[step.type] ?? step.type}</Badge></td>
                      <td className="num">{formatAmount(step.amount)}</td>
                      <td className="muted small">{step.referenceType} · <IdLink id={step.referenceId} /></td>
                      <td className="num">{formatAmount(step.availableAfter)}</td>
                      <td className="num">{formatAmount(step.lockedAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {steps.length > 200 ? <p className="muted small">仅显示最近 200 条，共 {steps.length} 条。</p> : null}
            </div>
          )}
          <JsonView value={{ ...report, steps: `${steps.length} steps` }} />
        </div>
      ) : !error ? (
        <p className="muted">在上方对账表中点击「回放」，或输入账户 ID。</p>
      ) : null}
    </Panel>
  );
}
