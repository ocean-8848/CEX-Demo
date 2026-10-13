import { Button, Empty, Panel, formatAmount, formatCompact, href } from "@web3-cex/web-ui";

import { itemsOf } from "../lib/api.js";
import type {
  AlertsReport,
  DashboardReport,
  LedgerOverview,
  ModuleDescriptor,
  SettlementReport,
  WithdrawalRecord
} from "../lib/types.js";
import { Amount, IdLink, PageHeader, QueryView, RefreshButton, StatCard, StatusBadge, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";
import { useWithdrawalReview } from "./withdrawals-page.js";
import { AlertRow, SeverityCounts } from "../components/severity.js";

const MODULE_SOURCE: Record<string, string> = {
  "ledger-service": "ledger",
  "blockchain-indexer": "indexer",
  "custody-adapter": "custody",
  "risk-service": "controls"
};

export function DashboardPage() {
  const { can } = useSession();
  const dashboard = useOpsQuery<DashboardReport>("/dashboard?reviewQueueLimit=6&notificationsLimit=6", { refreshMs: 10_000 });
  const alerts = useOpsQuery<AlertsReport>(can("ops.alerts.read") ? "/alerts" : null, { refreshMs: 15_000 });
  const settlements = useOpsQuery<SettlementReport>(can("ops.assets.read") ? "/spot/settlements/report" : null, { refreshMs: 15_000 });
  const ledger = useOpsQuery<LedgerOverview>(can("ops.ledger.read") ? "/ledger/overview" : null, { refreshMs: 30_000 });
  const modules = useOpsQuery<ModuleDescriptor[]>("/modules");
  const review = useWithdrawalReview(() => dashboard.reload());
  const { busy, run } = useOpsAction();

  const queue = dashboard.data?.withdrawalReviewQueue;
  const notifications = dashboard.data?.pendingNotifications;
  const totals = settlements.data?.totals;
  const sourceStatus = new Map((alerts.data?.sources ?? []).map((source) => [source.source, source]));
  const reconcile = ledger.data?.reconciliation;

  return (
    <div className="page">
      <PageHeader
        title="运营总览"
        subtitle="资金、交易与链上三条主链的实时健康度"
        actions={<RefreshButton onClick={() => { dashboard.reload(); alerts.reload(); settlements.reload(); ledger.reload(); }} loading={dashboard.loading} updatedAt={dashboard.updatedAt} />}
      />

      <div className="stat-grid">
        <StatCard
          label="待审核提现"
          value={queue?.total ?? "--"}
          tone={queue?.total ? "warning" : "positive"}
          hint="点击进入审核队列"
          href={href("/withdrawals")}
        />
        <StatCard
          label="系统告警"
          value={alerts.data?.alertCount ?? "--"}
          tone={alerts.data?.countsBySeverity?.P1 ? "negative" : alerts.data?.alertCount ? "warning" : "positive"}
          hint={
            alerts.data?.countsBySeverity
              ? `P1 ${alerts.data.countsBySeverity.P1} · P2 ${alerts.data.countsBySeverity.P2} · P3 ${alerts.data.countsBySeverity.P3}`
              : alerts.data
                ? `${alerts.data.sources.length} 个数据源`
                : undefined
          }
          href={href("/system")}
        />
        <StatCard
          label="已结算成交"
          value={totals?.settledCount !== undefined ? formatCompact(totals.settledCount) : "--"}
          tone="positive"
          hint={totals ? `待恢复 ${totals.pendingRecoveryCount ?? 0} · 失败 ${totals.failedCount ?? 0}` : undefined}
          href={href("/trading")}
        />
        <StatCard
          label="累计手续费"
          value={totals?.feeAmount ? formatAmount(totals.feeAmount, 2) : "--"}
          hint="USDT · 卖方按成交额支付；买方手续费按币种计入各市场"
          href={href("/trading")}
        />
        <StatCard
          label="账本对账"
          value={reconcile ? (reconcile.mismatchCount ? `${reconcile.mismatchCount} 处不一致` : "一致") : "--"}
          tone={reconcile?.mismatchCount ? "negative" : "positive"}
          hint={reconcile ? `扫描 ${reconcile.scannedCount ?? 0} 个余额` : undefined}
          href={href("/ledger")}
        />
        <StatCard
          label="待投递通知"
          value={notifications?.total ?? "--"}
          tone={notifications?.total ? "warning" : "neutral"}
          hint="wallet-service 站内信"
        />
      </div>

      <div className="grid-2">
        <Panel
          title="待审核提现"
          actions={<a className="muted small" href={href("/withdrawals")}>全部 →</a>}
          flush
        >
          <QueryView state={dashboard} empty={() => !queue?.items.length} emptyTitle="审核队列已清空" emptyHint="用户发起提现后会出现在这里。">
            {() => (
              <table className="data-table" id="dashboard-review-queue">
                <tbody>
                  {(queue?.items ?? []).map((item: WithdrawalRecord) => (
                    <tr key={item.withdrawalId}>
                      <td>
                        <div><Amount value={item.amount} asset={item.assetCode} /></div>
                        <div className="muted small"><IdLink id={item.userId} kind="userId" /> · <Time value={item.requestedAt} /></div>
                      </td>
                      <td className="num actions">
                        <Button size="sm" variant="primary" disabled={!review.canReview} onClick={() => review.approve([item.withdrawalId])}>
                          批准
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!review.canReview} onClick={() => review.reject([item.withdrawalId])}>
                          拒绝
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </QueryView>
        </Panel>

        <Panel title="告警" actions={alerts.data ? (alerts.data.countsBySeverity ? <SeverityCounts counts={alerts.data.countsBySeverity} /> : <StatusBadge status={alerts.data.status} />) : null}>
          <QueryView state={alerts}>
            {(data) =>
              data.alertCount === 0 ? (
                <Empty icon="✓" title="一切正常" hint="账本、对账、链上观察、托管与交易都在阈值内，紧急开关全部关闭。" />
              ) : (
                <ul className="alert-list" id="dashboard-alerts">
                  {data.items
                    ? data.items.slice(0, 12).map((item, index) => (
                        <AlertRow key={`${item.source}:${item.code}:${index}`} item={item} showSource />
                      ))
                    : data.sources.flatMap((source) =>
                        source.alerts.map((alert) => (
                          <li key={`${source.source}:${alert}`}>
                            <span className="alert-source">{source.source}</span>
                            <span>{alert}</span>
                          </li>
                        ))
                      )}
                </ul>
              )
            }
          </QueryView>
        </Panel>
      </div>

      <Panel title="模块状态" actions={<span className="muted small">点击查看该模块相关的运维视图</span>}>
        <QueryView state={modules}>
          {(data) => (
            <div className="module-grid">
              {data.map((module) => {
                const source = sourceStatus.get(MODULE_SOURCE[module.moduleId] ?? "");
                const status = source ? source.status : "ok";
                return (
                  <a key={module.moduleId} className="module-card" href={href(moduleTarget(module.moduleId))}>
                    <div className="module-head">
                      <code>{module.moduleId}</code>
                      <StatusBadge status={status} label={source ? undefined : "运行中"} />
                    </div>
                    <span className="muted small">{module.domain}</span>
                    <p>{module.summary}</p>
                  </a>
                );
              })}
            </div>
          )}
        </QueryView>
      </Panel>

      <Panel
        title="待投递通知"
        actions={
          can("ops.notifications.manage") ? (
            <Button
              size="sm"
              loading={busy === "deliver"}
              onClick={async () => {
                await run<{ deliveredCount?: number }>(
                  "deliver",
                  { path: "/notifications/deliver", body: { limit: 100 } },
                  { success: "通知已投递", detail: (result) => (result.deliveredCount !== undefined ? `投递 ${result.deliveredCount} 条` : undefined) }
                );
                dashboard.reload();
              }}
            >
              立即投递
            </Button>
          ) : null
        }
        flush
      >
        {itemsOf(notifications).length === 0 ? (
          <Empty title="没有待投递的通知" />
        ) : (
          <table className="data-table">
            <tbody>
              {(notifications?.items ?? []).map((item) => (
                <tr key={item.notificationId}>
                  <td><code>{item.eventType}</code></td>
                  <td>{item.subject}</td>
                  <td><IdLink id={item.userId} kind="userId" /></td>
                  <td><Time value={item.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {review.dialog}
    </div>
  );
}

function moduleTarget(moduleId: string): string {
  switch (moduleId) {
    case "identity-service":
    case "api-gateway":
      return "/users";
    case "wallet-service":
      return "/withdrawals";
    case "blockchain-indexer":
      return "/deposits";
    case "custody-adapter":
    case "risk-service":
      return "/system";
    case "ledger-service":
      return "/ledger";
    default:
      return "/trading";
  }
}
