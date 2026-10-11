import { Fragment, useState } from "react";

import { Panel, Tabs } from "@web3-cex/web-ui";

import { itemsOf, qs, totalOf } from "../lib/api.js";
import type { ActionAuditLog, Paged, WithdrawalAuditLog } from "../lib/types.js";
import { IdLink, JsonView, PageHeader, Pager, QueryView, RefreshButton, StatusBadge, Time } from "../components/kit.js";
import { useOpsQuery } from "../state/hooks.js";

const PAGE_SIZE = 25;

export function AuditPage() {
  const [tab, setTab] = useState<"actions" | "withdrawals">("actions");
  return (
    <div className="page">
      <PageHeader title="操作审计" subtitle="运营后台的每个写操作都记录操作人、权限、请求与结果；提现单的每次状态迁移单独留痕" />
      <Tabs
        className="page-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "actions", label: "后台操作" },
          { value: "withdrawals", label: "提现状态迁移" }
        ]}
      />
      {tab === "actions" ? <ActionAudit /> : <WithdrawalAudit />}
    </div>
  );
}

function ActionAudit() {
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useOpsQuery<Paged<ActionAuditLog>>(`/audit-logs/actions${qs({ action, status, limit: PAGE_SIZE, offset })}`, { refreshMs: 15_000 });
  const rows = itemsOf<ActionAuditLog>(query.data);
  return (
    <Panel
      flush
      title={
        <div className="filters">
          <input className="filter-input" placeholder="动作，如 withdrawal.approve" value={action} onChange={(event) => { setAction(event.target.value.trim()); setOffset(0); }} />
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="结果">
            <option value="">全部结果</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
          </select>
        </div>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="暂无审计记录">
        {() => (
          <div className="table-scroll">
            <table className="data-table clickable" id="action-audit-table">
              <thead>
                <tr><th>时间</th><th>操作人</th><th>动作</th><th>权限</th><th>对象</th><th>结果</th></tr>
              </thead>
              <tbody>
                {rows.map((log) => (
                  <Fragment key={log.auditLogId}>
                    <tr onClick={() => setExpanded(expanded === log.auditLogId ? null : log.auditLogId)}>
                      <td><Time value={log.startedAt} /></td>
                      <td>{log.operatorEmail ?? <IdLink id={log.operatorUserId} />}</td>
                      <td><code>{log.action}</code></td>
                      <td className="muted small">{log.permission}</td>
                      <td>
                        <span className="muted small">{log.targetType} </span>
                        <IdLink id={log.targetId} kind={log.targetType === "withdrawal" ? "withdrawalId" : log.targetType === "user" ? "userId" : undefined} />
                      </td>
                      <td><StatusBadge status={log.status} /></td>
                    </tr>
                    {expanded === log.auditLogId ? (
                      <tr className="detail-row">
                        <td colSpan={6}>
                          {log.errorMessage ? <div className="form-error">{log.errorMessage}</div> : null}
                          <div className="grid-2">
                            <JsonView value={log.requestPayload} label="请求" open />
                            <JsonView value={log.responsePayload} label="响应" />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(query.data)} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
    </Panel>
  );
}

function WithdrawalAudit() {
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<Paged<WithdrawalAuditLog>>(`/audit-logs/withdrawals${qs({ limit: PAGE_SIZE, offset })}`, { refreshMs: 15_000 });
  const rows = itemsOf<WithdrawalAuditLog>(query.data);
  return (
    <Panel flush title="提现单状态迁移" actions={<RefreshButton onClick={query.reload} loading={query.loading} />}>
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0}>
        {() => (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>时间</th><th>提现单</th><th>动作</th><th>操作方</th><th>状态变化</th></tr>
              </thead>
              <tbody>
                {rows.map((log) => (
                  <tr key={log.auditLogId}>
                    <td><Time value={log.createdAt} /></td>
                    <td><IdLink id={log.withdrawalId} kind="withdrawalId" /></td>
                    <td><code>{log.action}</code></td>
                    <td className="muted">{log.operatorRole} · <IdLink id={log.operatorId} /></td>
                    <td>
                      <StatusBadge status={String(log.beforeSnapshot?.status ?? "")} label={String(log.beforeSnapshot?.status ?? "—")} />
                      <span className="muted"> → </span>
                      <StatusBadge status={String(log.afterSnapshot?.status ?? "")} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(query.data)} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
    </Panel>
  );
}
