import { useState } from "react";

import { Badge, Button, Empty, Panel, href } from "@web3-cex/web-ui";

import type { ControlSwitchEntry, ControlSwitchScope, ControlsReport } from "../lib/types.js";
import { ConfirmDialog, QueryView, RefreshButton, StatusBadge, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

const SCOPE_LABEL: Record<ControlSwitchScope, string> = {
  withdrawals_global: "全站提现",
  withdrawals_asset: "单币种提现",
  api_write: "API 写入"
};

interface PendingChange {
  scope: ControlSwitchScope;
  assetCode?: string;
  enabled: boolean;
  automatic?: boolean;
}

/**
 * 系统运维 → 紧急开关: global / per-asset withdrawal pause and the API write
 * freeze (read-only mode). risk-service stores the switches; wallet-service,
 * api-gateway and order validation enforce them within a few seconds.
 */
export function ControlsTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const report = useOpsQuery<ControlsReport>("/controls", { refreshMs: 10_000 });
  const [pending, setPending] = useState<PendingChange | null>(null);
  const canManage = can("ops.controls.manage");

  const apply = async (reason: string) => {
    if (!pending) {
      return;
    }
    const label = `${SCOPE_LABEL[pending.scope]}${pending.assetCode ? ` ${pending.assetCode}` : ""}`;
    const result = await run(
      "control",
      { path: "/controls", body: { scope: pending.scope, assetCode: pending.assetCode, enabled: pending.enabled, reason } },
      { success: pending.enabled ? `已开启：${label}` : `已恢复：${label}` }
    );
    if (result) {
      setPending(null);
      report.reload();
    }
  };

  return (
    <div className="page-stack" id="controls-tab">
      <p className="muted small">
        紧急开关用于止血：开启后数秒内在 wallet-service（提现申请、审批、广播）、api-gateway（下单、提现申请）和下单风控中生效。
        每次开关都必须填写原因，并写入操作审计；只有具备 <code>ops.controls.manage</code> 权限的运营（默认仅 ops_admin）可以操作。
      </p>
      <QueryView state={report}>
        {(data) => {
          const assetPauses = new Map(data.state.assetWithdrawalPauses.map((entry) => [entry.assetCode ?? "", entry]));
          return (
            <>
              <div className="control-grid">
                <SwitchCard
                  id="control-withdrawals_global"
                  title="全站提现暂停"
                  description="所有币种的提现申请被拒绝（WITHDRAWALS_PAUSED），审核队列中的提现也不能批准或广播；拒绝仍可操作。"
                  entry={data.state.withdrawalsPaused}
                  canManage={canManage}
                  onToggle={(enabled) => setPending({ scope: "withdrawals_global", enabled })}
                />
                <SwitchCard
                  id="control-api_write"
                  title="API 写入冻结（只读模式）"
                  description="新委托与提现申请被拒绝（API_WRITE_FROZEN）；撤单、查询和运营审核照常。"
                  entry={data.state.apiWriteFrozen}
                  canManage={canManage}
                  onToggle={(enabled) => setPending({ scope: "api_write", enabled })}
                />
              </div>
              <Panel
                title="单币种提现"
                flush
                actions={<RefreshButton onClick={report.reload} loading={report.loading} updatedAt={report.updatedAt} />}
              >
                <table className="data-table" id="asset-withdrawal-controls">
                  <thead>
                    <tr><th>币种</th><th>状态</th><th>来源</th><th>原因</th><th>操作人 / 时间</th>{canManage ? <th className="num">操作</th> : null}</tr>
                  </thead>
                  <tbody>
                    {data.assets.map((assetCode) => {
                      const entry = assetPauses.get(assetCode) ?? null;
                      return (
                        <tr key={assetCode} id={`asset-control-${assetCode}`} className={entry ? "row-alert" : ""}>
                          <td><b>{assetCode}</b></td>
                          <td>{entry ? <Badge tone="negative">提现已暂停</Badge> : <Badge tone="positive">正常</Badge>}</td>
                          <td>{entry ? <SourceBadge entry={entry} /> : <span className="muted">--</span>}</td>
                          <td className="small">{entry?.reason ?? <span className="muted">--</span>}</td>
                          <td className="small">{entry ? <>{entry.updatedBy} · <Time value={entry.updatedAt} /></> : <span className="muted">--</span>}</td>
                          {canManage ? (
                            <td className="num">
                              {entry ? (
                                <Button size="sm" variant="primary" id={`resume-asset-${assetCode}`} onClick={() => setPending({ scope: "withdrawals_asset", assetCode, enabled: false, automatic: entry.source === "automatic" })}>
                                  恢复提现
                                </Button>
                              ) : (
                                <Button size="sm" variant="sell" id={`pause-asset-${assetCode}`} onClick={() => setPending({ scope: "withdrawals_asset", assetCode, enabled: true })}>
                                  暂停提现
                                </Button>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
              <Panel title="对账熔断" actions={<a className="muted small" href={href("/ledger")}>账本对账 →</a>}>
                {data.reconciliation ? (
                  <p className="small">
                    定时对账 {data.reconciliation.job.enabled ? `每 ${data.reconciliation.job.intervalSeconds} 秒一次` : "未开启（可在账本对账页手动运行）"}；
                    熔断 {data.reconciliation.job.breakerEnabled ? "已开启" : "已关闭"}（余额对账不平立即触发，委托冻结对账需同一委托连续 {data.reconciliation.job.confirmations} 轮不一致）。
                    最近一次：{data.reconciliation.latestRun ? (
                      <>
                        <StatusBadge status={data.reconciliation.latestRun.status} /> <Time value={data.reconciliation.latestRun.startedAt} />
                      </>
                    ) : "暂无"}。
                    自动暂停的币种标记为「对账熔断」，必须在之后至少一轮对账恢复一致后才能人工恢复。
                  </p>
                ) : (
                  <p className="muted small">ledger-service 对账任务不可用。</p>
                )}
              </Panel>
              <Panel title="开关变更记录" flush actions={<a className="muted small" href={href("/audit")}>操作审计 →</a>}>
                {data.events.length === 0 ? (
                  <Empty title="还没有开关变更" />
                ) : (
                  <table className="data-table compact" id="control-events">
                    <thead><tr><th>时间</th><th>开关</th><th>动作</th><th>来源</th><th>原因</th><th>操作人</th></tr></thead>
                    <tbody>
                      {data.events.map((event) => (
                        <tr key={event.eventId}>
                          <td><Time value={event.createdAt} /></td>
                          <td>{SCOPE_LABEL[event.scope] ?? event.scope}{event.assetCode ? ` ${event.assetCode}` : ""}</td>
                          <td>{event.action === "enabled" ? <Badge tone="negative">开启</Badge> : <Badge tone="positive">恢复</Badge>}</td>
                          <td>{event.source === "automatic" ? <Badge tone="warning">对账熔断</Badge> : <span className="muted">人工</span>}</td>
                          <td className="small">{event.reason ?? "--"}</td>
                          <td className="small muted">{event.operator}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            </>
          );
        }}
      </QueryView>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${pending.enabled ? "开启" : "恢复"}：${SCOPE_LABEL[pending.scope]}${pending.assetCode ? ` ${pending.assetCode}` : ""}` : ""}
        description={
          pending?.enabled
            ? "开启后用户侧相关写操作会被立即拒绝。请确认这是止血需要，并写明原因（会写入操作审计）。"
            : pending?.automatic
              ? "该币种由对账熔断自动暂停：只有在之后至少一轮对账恢复一致后才能恢复，否则会被拒绝（RECONCILIATION_NOT_CLEAN）。"
              : "恢复后相关操作立即放开。请写明恢复依据（会写入操作审计）。"
        }
        confirmLabel={pending?.enabled ? "确认开启" : "确认恢复"}
        danger={pending?.enabled}
        noteLabel={pending?.enabled ? "开启原因" : "恢复依据"}
        noteRequired
        busy={busy === "control"}
        onConfirm={(note) => void apply(note)}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

function SourceBadge(props: { entry: ControlSwitchEntry }) {
  return props.entry.source === "automatic" ? <Badge tone="warning">对账熔断</Badge> : <Badge tone="neutral">人工</Badge>;
}

function SwitchCard(props: {
  id: string;
  title: string;
  description: string;
  entry: ControlSwitchEntry | null;
  canManage: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const on = Boolean(props.entry);
  return (
    <div className={`control-card${on ? " on" : ""}`} id={props.id}>
      <div className="control-card-head">
        <b>{props.title}</b>
        {on ? <Badge tone="negative">已开启</Badge> : <Badge tone="positive">关闭</Badge>}
      </div>
      <p className="muted small">{props.description}</p>
      {props.entry ? (
        <p className="small">
          原因：{props.entry.reason ?? "--"} · {props.entry.updatedBy} · <Time value={props.entry.updatedAt} />
        </p>
      ) : null}
      {props.canManage ? (
        <div>
          <Button size="sm" variant={on ? "primary" : "sell"} onClick={() => props.onToggle(!on)} id={`${props.id}-toggle`}>
            {on ? "恢复" : "开启"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
