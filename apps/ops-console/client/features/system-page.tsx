import { useState, type ReactNode } from "react";

import { Button, Panel, Tabs, parseHashRoute } from "@web3-cex/web-ui";

import { itemsOf, qs } from "../lib/api.js";
import type { AlertsReport, CustodyRoute, ExecutionSchedule, ExecutionTemplate, RecoveryJob } from "../lib/types.js";
import {
  ConfirmDialog,
  IdLink,
  JsonView,
  KeyValue,
  PageHeader,
  QueryView,
  RefreshButton,
  StatCard,
  StatusBadge,
  Time
} from "../components/kit.js";
import { useMarketConfig, useOpsAction, useOpsQuery } from "../state/hooks.js";
import { FaultLabTab } from "./fault-lab-tab.js";
import { useSession } from "../state/session.js";
import { MarketOptions } from "../components/market-options.js";

type SystemTab = "alerts" | "custody" | "recovery" | "eventbus" | "automation" | "lab";
const SYSTEM_TABS: SystemTab[] = ["alerts", "custody", "recovery", "eventbus", "automation", "lab"];

export function SystemPage() {
  // `#/system?tab=lab` opens a tab directly (trader-web guided scenarios link here).
  const [tab, setTab] = useState<SystemTab>(() => {
    const requested = parseHashRoute(window.location.hash).query.get("tab");
    return (SYSTEM_TABS as string[]).includes(requested ?? "") ? (requested as SystemTab) : "alerts";
  });
  return (
    <div className="page">
      <PageHeader title="系统运维" subtitle="告警、托管通道、交易恢复队列、事件总线、自动化作业与故障注入实验室" />
      <Tabs
        className="page-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "alerts", label: "告警" },
          { value: "custody", label: "托管通道" },
          { value: "recovery", label: "恢复队列" },
          { value: "eventbus", label: "事件总线" },
          { value: "automation", label: "自动化作业" },
          { value: "lab", label: "实验室" }
        ]}
      />
      {tab === "alerts" ? <AlertsTab /> : null}
      {tab === "custody" ? <CustodyTab /> : null}
      {tab === "recovery" ? <RecoveryTab /> : null}
      {tab === "eventbus" ? <EventBusTab /> : null}
      {tab === "automation" ? <AutomationTab /> : null}
      {tab === "lab" ? <FaultLabTab /> : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  ledger: "账本 ledger-service",
  indexer: "链上观察 blockchain-indexer",
  custody: "托管 custody-adapter",
  wallet: "钱包 wallet-service",
  trading: "交易域"
};

function AlertsTab() {
  const alerts = useOpsQuery<AlertsReport>("/alerts", { refreshMs: 15_000 });
  return (
    <QueryView state={alerts}>
      {(data) => (
        <div className="source-grid">
          {data.sources.map((source) => (
            <Panel
              key={source.source}
              title={SOURCE_LABEL[source.source] ?? source.source}
              actions={<StatusBadge status={source.status} />}
            >
              {source.alerts.length === 0 ? (
                <p className="muted">所有指标都在阈值内。</p>
              ) : (
                <ul className="alert-list">
                  {source.alerts.map((alert) => (
                    <li key={alert}><span>{alert}</span></li>
                  ))}
                </ul>
              )}
              <JsonView value={source.summary} label="指标明细" />
            </Panel>
          ))}
        </div>
      )}
    </QueryView>
  );
}

interface CustodyOverview {
  status?: string;
  alerts?: string[];
  openCircuitCount?: number;
  unhealthyRouteCount?: number;
  backlog?: { pendingSyncCount?: number; retryableCount?: number; failedCount?: number };
  routes?: CustodyRoute[];
}

function CustodyTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const overview = useOpsQuery<CustodyOverview>("/custody/overview", { refreshMs: 15_000 });
  return (
    <QueryView state={overview}>
      {(data) => (
        <div className="page-stack">
          <div className="stat-grid">
            <StatCard label="托管状态" value={<StatusBadge status={data.status} />} />
            <StatCard label="熔断中的通道" value={data.openCircuitCount ?? 0} tone={data.openCircuitCount ? "negative" : "positive"} />
            <StatCard label="不健康通道" value={data.unhealthyRouteCount ?? 0} tone={data.unhealthyRouteCount ? "negative" : "positive"} />
            <StatCard label="待回查 / 可重试 / 失败" value={`${data.backlog?.pendingSyncCount ?? 0} / ${data.backlog?.retryableCount ?? 0} / ${data.backlog?.failedCount ?? 0}`} />
          </div>
          <Panel
            title="路由表"
            flush
            actions={
              <span className="panel-actions">
                {can("ops.providers.manage") ? (
                  <Button
                    size="sm"
                    loading={busy === "health"}
                    onClick={async () => {
                      await run("health", { path: "/custody/providers/health/check" }, { success: "健康检查已执行" });
                      overview.reload();
                    }}
                  >
                    立即健康检查
                  </Button>
                ) : null}
                <RefreshButton onClick={overview.reload} loading={overview.loading} />
              </span>
            }
          >
            <table className="data-table">
              <thead>
                <tr><th>网络</th><th>Provider</th><th>优先级</th><th>健康</th><th>熔断器</th><th className="num">连续失败</th><th className="num">广播成功 / 失败</th><th>最近检查</th></tr>
              </thead>
              <tbody>
                {(data.routes ?? []).map((route) => (
                  <tr key={`${route.network}:${route.providerName}`}>
                    <td>{route.network}</td>
                    <td><code>{route.providerName}</code></td>
                    <td>{route.priority}</td>
                    <td><StatusBadge status={route.healthStatus} /></td>
                    <td><StatusBadge status={route.circuitState === "closed" ? "ok" : route.circuitState} label={route.circuitState === "closed" ? "闭合" : route.circuitState === "open" ? "熔断" : route.circuitState} /></td>
                    <td className="num">{route.consecutiveFailures ?? 0}</td>
                    <td className="num">{route.broadcastSuccessCount ?? 0} / {route.broadcastFailureCount ?? 0}</td>
                    <td><Time value={route.lastHealthCheckedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <p className="muted small">
            mock-custody 是演示用的模拟托管商，广播时直接返回交易哈希；真实环境中 evm-hot-wallet 通道会用私钥签名并广播到 RPC 节点。连续失败达到阈值时通道熔断，路由自动切到下一优先级。
          </p>
        </div>
      )}
    </QueryView>
  );
}

interface RecoveryMetrics {
  totalJobs?: number;
  pendingJobs?: number;
  processingJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  deadLetteredJobs?: number;
  averageDurationMs?: number;
}

function RecoveryTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [status, setStatus] = useState("pending");
  const metrics = useOpsQuery<RecoveryMetrics>("/spot/ops/recovery-metrics", { refreshMs: 15_000 });
  const orderJobs = useOpsQuery<RecoveryJob[]>(`/spot/ops/recovery-jobs${qs({ status: status || undefined, limit: 30 })}`, { refreshMs: 15_000 });
  const deadLetters = useOpsQuery<RecoveryJob[]>("/spot/ops/dead-letter-jobs?limit=30", { refreshMs: 15_000 });
  const settlementJobs = useOpsQuery<RecoveryJob[]>(`/spot/settlements/recovery-jobs${qs({ status: status || undefined, limit: 30 })}`, { refreshMs: 15_000 });
  const canExecute = can("ops.ledger.execute");
  const reload = () => {
    metrics.reload();
    orderJobs.reload();
    deadLetters.reload();
    settlementJobs.reload();
  };

  return (
    <div className="page-stack">
      <div className="stat-grid">
        <StatCard label="订单恢复任务" value={metrics.data?.totalJobs ?? "--"} hint={`完成 ${metrics.data?.completedJobs ?? 0}`} />
        <StatCard label="待处理" value={metrics.data?.pendingJobs ?? "--"} tone={metrics.data?.pendingJobs ? "warning" : "positive"} />
        <StatCard label="失败" value={metrics.data?.failedJobs ?? "--"} tone={metrics.data?.failedJobs ? "negative" : "positive"} />
        <StatCard label="死信" value={metrics.data?.deadLetteredJobs ?? "--"} tone={metrics.data?.deadLetteredJobs ? "negative" : "positive"} />
      </div>
      <p className="muted small">
        撮合结果落库、成交结算任何一步失败时，任务会进入恢复队列自动重试；超过最大次数后进入终态失败或死信，需要人工处理。
      </p>
      <div className="filters">
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="任务状态">
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="processing">处理中</option>
          <option value="failed">失败</option>
          <option value="completed">已完成</option>
        </select>
        <RefreshButton onClick={reload} />
      </div>
      <JobPanel
        title="订单恢复队列（order-service）"
        state={orderJobs}
        idKind="orderId"
        actions={
          canExecute ? (
            <Button size="sm" loading={busy === "order-process"} onClick={async () => { await run("order-process", { path: "/spot/ops/recovery-jobs/process", body: { limit: 20 } }, { success: "已处理一批订单恢复任务" }); reload(); }}>
              处理一批
            </Button>
          ) : null
        }
        rowAction={(job) =>
          canExecute && job.status !== "completed" ? (
            <Button size="sm" variant="ghost" loading={busy === job.jobId} onClick={async () => { await run(job.jobId, { path: `/spot/ops/recovery-jobs/${encodeURIComponent(job.jobId)}/recover` }, { success: "已触发恢复" }); reload(); }}>
              恢复
            </Button>
          ) : null
        }
      />
      <JobPanel
        title="死信任务"
        state={deadLetters}
        idKind="orderId"
        actions={
          canExecute ? (
            <Button size="sm" loading={busy === "dl-process"} onClick={async () => { await run("dl-process", { path: "/spot/ops/dead-letter-jobs/process", body: { limit: 20 } }, { success: "死信已重新入队" }); reload(); }}>
              全部重新入队
            </Button>
          ) : null
        }
        rowAction={(job) =>
          canExecute ? (
            <Button size="sm" variant="ghost" loading={busy === job.jobId} onClick={async () => { await run(job.jobId, { path: `/spot/ops/dead-letter-jobs/${encodeURIComponent(job.jobId)}/requeue` }, { success: "已重新入队" }); reload(); }}>
              重新入队
            </Button>
          ) : null
        }
      />
      <JobPanel
        title="结算恢复队列（settlement-service）"
        state={settlementJobs}
        idKind="tradeId"
        actions={
          canExecute ? (
            <Button size="sm" loading={busy === "settle-process"} onClick={async () => { await run("settle-process", { path: "/spot/settlements/recovery-jobs/process", body: { limit: 20 } }, { success: "已处理一批结算恢复任务" }); reload(); }}>
              处理一批
            </Button>
          ) : null
        }
        rowAction={(job) =>
          canExecute && job.tradeId && job.status !== "completed" ? (
            <Button size="sm" variant="ghost" loading={busy === job.jobId} onClick={async () => { await run(job.jobId, { path: `/spot/settlements/${encodeURIComponent(job.tradeId ?? "")}/recover` }, { success: "已触发结算恢复" }); reload(); }}>
              恢复
            </Button>
          ) : null
        }
      />
    </div>
  );
}

function JobPanel(props: {
  title: string;
  state: { data: RecoveryJob[] | undefined; error: string | null; loading: boolean; reload: () => void };
  idKind: "orderId" | "tradeId";
  actions?: ReactNode;
  rowAction: (job: RecoveryJob) => ReactNode;
}) {
  return (
    <Panel title={props.title} flush actions={props.actions}>
      <QueryView state={props.state} empty={(data) => itemsOf(data).length === 0} emptyTitle="队列为空">
        {(data) => (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr><th>更新时间</th><th>任务</th><th>{props.idKind === "orderId" ? "订单" : "成交"}</th><th>市场</th><th>阶段</th><th>尝试</th><th>最近错误</th><th>状态</th><th className="num">操作</th></tr>
              </thead>
              <tbody>
                {itemsOf<RecoveryJob>(data).map((job) => (
                  <tr key={job.jobId}>
                    <td><Time value={job.updatedAt} /></td>
                    <td><IdLink id={job.jobId} /></td>
                    <td><IdLink id={props.idKind === "orderId" ? job.orderId : job.tradeId} kind={props.idKind} /></td>
                    <td>{job.market}</td>
                    <td className="muted">{job.stage}</td>
                    <td>{job.attemptCount ?? 0}</td>
                    <td className="muted small ellipsis" title={job.lastError}>{job.lastError ?? "--"}</td>
                    <td><StatusBadge status={job.status} /></td>
                    <td className="num">{props.rowAction(job)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function EventBusTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const { defaultMarket } = useMarketConfig();
  const [selected, setMarket] = useState("");
  const market = selected || defaultMarket;
  const report = useOpsQuery<Record<string, unknown>>(market ? `/spot/runtime-report${qs({ market })}` : null, { refreshMs: 15_000 });
  const data = report.data ?? {};
  const scalarSummary = Object.entries(data).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)) as Array<[string, string | number | boolean]>;
  const canExecute = can("ops.ledger.execute");

  return (
    <div className="page-stack">
      <div className="filters">
        <select value={market} onChange={(event) => setMarket(event.target.value)} aria-label="市场">
          <MarketOptions />
        </select>
        <RefreshButton onClick={report.reload} loading={report.loading} updatedAt={report.updatedAt} />
      </div>
      <Panel title="交易事件流运行报告">
        <p className="muted small">
          order-service 把每笔成交写入 Redis Stream（trade.executed），settlement-service 作为消费者按 checkpoint 顺序结算，market-data-service 与 api-gateway 订阅推送。消费滞后会表现为「已成交未结算」。
        </p>
        <QueryView state={report}>
          {() => (
            <>
              <KeyValue items={scalarSummary.map(([key, value]) => [key, String(value)])} />
              <JsonView value={data} label="完整报告" />
            </>
          )}
        </QueryView>
      </Panel>
      {canExecute ? (
        <Panel title="手动作业">
          <div className="button-grid">
            <Button loading={busy === "process"} onClick={async () => { await run("process", { path: "/spot/event-bus/process", body: { market, limit: 100 } }, { success: "已驱动一轮结算消费" }); report.reload(); }}>
              驱动结算消费一轮
            </Button>
            <Button loading={busy === "maintenance"} onClick={async () => { await run("maintenance", { path: "/spot/event-bus/maintenance", body: { market, dryRun: false } }, { success: "事件流维护完成" }); report.reload(); }}>
              事件流维护（裁剪）
            </Button>
            <Button variant="primary" loading={busy === "self-heal"} onClick={async () => { await run("self-heal", { path: "/spot/event-bus/self-heal", body: { market } }, { success: "自愈流程已执行" }); report.reload(); }}>
              自愈：检测滞后并回放
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function AutomationTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const { defaultMarket } = useMarketConfig();
  const [confirm, setConfirm] = useState<ExecutionTemplate | null>(null);
  const templates = useOpsQuery<ExecutionTemplate[]>("/execution-templates");
  const schedules = useOpsQuery<ExecutionSchedule[]>("/execution-schedules");
  const history = useOpsQuery<{ items: Array<Record<string, unknown>> }>("/execution-history?limit=15", { refreshMs: 15_000 });

  return (
    <div className="page-stack">
      <Panel title="作业模板" actions={<span className="muted small">每次执行都会写入操作审计</span>}>
        <QueryView state={templates} empty={(data) => itemsOf(data).length === 0}>
          {(data) => (
            <div className="template-grid">
              {itemsOf<ExecutionTemplate>(data).map((template) => (
                <div key={template.templateId} className="template-card">
                  <strong>{template.name}</strong>
                  <p className="muted small">{template.description}</p>
                  <code className="small">{template.action}</code>
                  <Button size="sm" disabled={!template.permission || !can(template.permission)} onClick={() => setConfirm(template)}>
                    执行
                  </Button>
                </div>
              ))}
            </div>
          )}
        </QueryView>
      </Panel>
      <div className="grid-2">
        <Panel
          title="定时计划"
          flush
          actions={
            can("ops.ledger.execute") ? (
              <Button size="sm" loading={busy === "schedules"} onClick={async () => { await run("schedules", { path: "/execution-schedules/run", body: { limit: 10 } }, { success: "到期计划已执行" }); schedules.reload(); history.reload(); }}>
                执行到期计划
              </Button>
            ) : null
          }
        >
          <QueryView state={schedules} empty={(data) => itemsOf(data).length === 0}>
            {(data) => (
              <table className="data-table compact">
                <thead><tr><th>计划</th><th>市场</th><th>间隔</th><th>下次到期</th></tr></thead>
                <tbody>
                  {itemsOf<ExecutionSchedule>(data).map((schedule) => (
                    <tr key={schedule.scheduleId}>
                      <td>{schedule.templateName ?? schedule.templateId}</td>
                      <td>{schedule.market ?? "--"}</td>
                      <td>{schedule.intervalMinutes} 分钟</td>
                      <td><Time value={schedule.dueAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryView>
        </Panel>
        <Panel title="最近执行" flush>
          <QueryView state={history} empty={(data) => itemsOf(data).length === 0} emptyTitle="暂无执行记录">
            {(data) => (
              <table className="data-table compact">
                <tbody>
                  {itemsOf<Record<string, unknown>>(data).map((item, index) => (
                    <tr key={String(item.auditLogId ?? index)}>
                      <td><code className="small">{String(item.action ?? "")}</code></td>
                      <td className="muted small">{String(item.targetId ?? "")}</td>
                      <td><StatusBadge status={String(item.status ?? "")} /></td>
                      <td><Time value={String(item.completedAt ?? item.startedAt ?? "")} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryView>
        </Panel>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={`执行「${confirm?.name ?? ""}」`}
        description={
          <>
            <p>{confirm?.description}</p>
            {confirm?.defaults ? <JsonView value={confirm.defaults} label="默认参数" open /> : null}
          </>
        }
        confirmLabel="确认执行"
        busy={busy === "template"}
        onConfirm={async () => {
          if (!confirm) {
            return;
          }
          const result = await run("template", { path: `/execution-templates/${encodeURIComponent(confirm.templateId)}/execute`, body: defaultMarket ? { market: defaultMarket } : {} }, { success: `已执行 ${confirm.name}` });
          if (result) {
            setConfirm(null);
            history.reload();
          }
        }}
        onClose={() => setConfirm(null)}
      />
      <p className="muted small">本地演示环境中这些作业通常处理 0 条记录，这说明交易链路是健康的。</p>
    </div>
  );
}
