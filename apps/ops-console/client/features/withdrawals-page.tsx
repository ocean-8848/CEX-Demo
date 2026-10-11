import { useMemo, useState } from "react";

import { Badge, Button, Empty, Panel, Steps, Tabs, formatAmount, href, toNumber } from "@web3-cex/web-ui";

import { itemsOf, qs, totalOf } from "../lib/api.js";
import type {
  BalanceRecord,
  NotificationRecord,
  Paged,
  UserRecord,
  WithdrawalAuditLog,
  WithdrawalRecord
} from "../lib/types.js";
import {
  Amount,
  ConfirmDialog,
  Drawer,
  IdLink,
  JsonView,
  KeyValue,
  PageHeader,
  Pager,
  QueryView,
  RefreshButton,
  StatusBadge,
  Time
} from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";
import { AssetOptions } from "../components/market-options.js";

const PAGE_SIZE = 20;

const STEPS = [
  { key: "requested", label: "申请" },
  { key: "approved", label: "审核通过" },
  { key: "broadcasted", label: "托管广播" },
  { key: "confirmed", label: "链上确认" }
];

function stepIndex(status: string | undefined): number {
  if (status === "confirmed") {
    return STEPS.length;
  }
  const index = STEPS.findIndex((step) => step.key === status);
  return index < 0 ? 0 : index;
}

type Review = { kind: "approve" | "reject"; ids: string[] } | null;

interface ApprovalProgress {
  required: number;
  approvals: Array<{ operatorId: string; approvedAt?: string; note?: string }>;
  threshold?: string;
}

/** M5-2: reads the dual-approval policy and approvals wallet-service stores in metadata. */
export function approvalProgress(row: WithdrawalRecord | undefined): ApprovalProgress {
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  const policy = (metadata.approvalPolicy ?? {}) as Record<string, unknown>;
  const approvals = Array.isArray(metadata.approvals)
    ? (metadata.approvals as Array<Record<string, unknown>>)
        .filter((item) => typeof item?.operatorId === "string")
        .map((item) => ({
          operatorId: String(item.operatorId),
          approvedAt: typeof item.approvedAt === "string" ? item.approvedAt : undefined,
          note: typeof item.note === "string" ? item.note : undefined
        }))
    : [];
  return {
    required: policy.requiredApprovals === 2 ? 2 : 1,
    approvals,
    threshold: typeof policy.threshold === "string" ? policy.threshold : undefined
  };
}

function ApprovalBadge(props: { row: WithdrawalRecord }) {
  const progress = approvalProgress(props.row);
  if (progress.required < 2) {
    return null;
  }
  const done = Math.min(progress.approvals.length, progress.required);
  return (
    <Badge tone={done >= progress.required ? "positive" : done > 0 ? "warning" : "neutral"}>
      {done}/{progress.required} 已批准
    </Badge>
  );
}

/** Approve / reject dialogs shared by the review page and the dashboard. */
export function useWithdrawalReview(onDone: () => void) {
  const { can, session } = useSession();
  const { busy, run } = useOpsAction();
  const [review, setReview] = useState<Review>(null);

  const submit = async (note: string) => {
    if (!review) {
      return;
    }
    const single = review.ids.length === 1;
    const id = review.ids[0] ?? "";
    let ok: unknown;
    if (review.kind === "approve") {
      ok = single
        ? await run<WithdrawalRecord>(
            "review",
            { path: `/withdrawals/${encodeURIComponent(id)}/approve`, body: { note: note || undefined } },
            {
              success: "提现已批准",
              detail: (result) =>
                result.reviewStatus === "pending_second_approval"
                  ? "大额提现：已记录第 1 位批准，需另一名运营人员复核后才会广播"
                  : result.status === "broadcasted"
                    ? "custody-adapter 已广播，模拟链确认 12 个区块后完成"
                    : `当前状态：${result.status}`
            }
          )
        : await run<{ succeededCount: number; failedCount: number }>(
            "review",
            { path: "/withdrawal-batches/approve", body: { withdrawalIds: review.ids, note: note || undefined } },
            { success: "批量批准完成", detail: (result) => `成功 ${result.succeededCount} 笔，失败 ${result.failedCount} 笔` }
          );
    } else {
      ok = single
        ? await run<WithdrawalRecord>(
            "review",
            { path: `/withdrawals/${encodeURIComponent(id)}/reject`, body: { reason: note } },
            { success: "提现已拒绝", detail: () => "冻结资金已退回用户可用余额" }
          )
        : await run<{ succeededCount: number; failedCount: number }>(
            "review",
            { path: "/withdrawal-batches/reject", body: { withdrawalIds: review.ids, reason: note } },
            { success: "批量拒绝完成", detail: (result) => `成功 ${result.succeededCount} 笔，失败 ${result.failedCount} 笔` }
          );
    }
    if (ok) {
      setReview(null);
      onDone();
    }
  };

  const dialog = (
    <ConfirmDialog
      open={review !== null}
      title={
        review?.kind === "approve"
          ? `批准 ${review.ids.length} 笔提现`
          : `拒绝 ${review?.ids.length ?? 0} 笔提现`
      }
      description={
        review?.kind === "approve"
          ? "批准后 wallet-service 立即调用 custody-adapter 签名并广播交易，链上确认后从账本最终扣除冻结资金。此操作不可撤回。超过阈值的大额提现需要两名不同运营人员分别批准，第一次批准只记录复核进度。"
          : "拒绝后冻结的金额与手续费会退回用户可用余额，用户会收到通知。"
      }
      confirmLabel={review?.kind === "approve" ? "确认批准并广播" : "确认拒绝"}
      danger={review?.kind === "reject"}
      noteLabel={review?.kind === "approve" ? "审核备注" : "拒绝原因"}
      noteRequired={review?.kind === "reject"}
      busy={busy === "review"}
      onConfirm={(note) => void submit(note)}
      onClose={() => setReview(null)}
    />
  );

  return {
    /** The same operator can never give both approvals of a dual-approval withdrawal. */
    alreadyApprovedByMe: (row: WithdrawalRecord | undefined) =>
      Boolean(session?.userId && approvalProgress(row).approvals.some((item) => item.operatorId === session.userId)),
    canReview: can("ops.withdrawals.review"),
    canBatch: can("ops.withdrawals.batch_review"),
    approve: (ids: string[]) => setReview({ kind: "approve", ids }),
    reject: (ids: string[]) => setReview({ kind: "reject", ids }),
    dialog
  };
}

export function WithdrawalsPage(props: { initialId?: string }) {
  const [tab, setTab] = useState<"queue" | "all">("queue");
  const [status, setStatus] = useState("");
  const [assetCode, setAssetCode] = useState("");
  const [userId, setUserId] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | undefined>(props.initialId);

  const path =
    tab === "queue"
      ? `/withdrawals/review-queue${qs({ assetCode, userId, limit: PAGE_SIZE, offset })}`
      : `/withdrawals${qs({ status, assetCode, userId, limit: PAGE_SIZE, offset })}`;
  const query = useOpsQuery<Paged<WithdrawalRecord>>(path, { refreshMs: 10_000 });
  const review = useWithdrawalReview(() => {
    setSelected([]);
    query.reload();
  });

  const rows = itemsOf<WithdrawalRecord>(query.data);
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.withdrawalId));
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <div className="page">
      <PageHeader
        title="提现审核"
        subtitle="用户提现先冻结资金，经人工审核后由 custody-adapter 广播；审核动作全部写入审计日志"
        actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
      />

      <Panel
        flush
        title={
          <Tabs
            value={tab}
            onChange={(value) => {
              setTab(value);
              setOffset(0);
              setSelected([]);
            }}
            items={[
              { value: "queue", label: "待审核", count: tab === "queue" ? totalOf(query.data) : undefined },
              { value: "all", label: "全部提现" }
            ]}
          />
        }
        actions={
          <div className="filters">
            {tab === "all" ? (
              <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="状态">
                <option value="">全部状态</option>
                <option value="requested">待审核</option>
                <option value="broadcasted">已广播</option>
                <option value="confirmed">已确认</option>
                <option value="rejected">已拒绝</option>
                <option value="failed">失败</option>
              </select>
            ) : null}
            <select value={assetCode} onChange={(event) => { setAssetCode(event.target.value); setOffset(0); }} aria-label="币种">
              <option value="">全部币种</option>
              <AssetOptions />
            </select>
            <input
              placeholder="按 userId 过滤"
              value={userId}
              onChange={(event) => { setUserId(event.target.value.trim()); setOffset(0); }}
              className="filter-input"
            />
          </div>
        }
      >
        {tab === "queue" && selected.length > 0 ? (
          <div className="batch-bar">
            <span>已选择 {selected.length} 笔</span>
            <Button size="sm" variant="primary" disabled={!review.canBatch} onClick={() => review.approve(selected)} id="batch-approve">
              批量批准
            </Button>
            <Button size="sm" variant="sell" disabled={!review.canBatch} onClick={() => review.reject(selected)}>
              批量拒绝
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              取消选择
            </Button>
          </div>
        ) : null}
        <QueryView
          state={query}
          empty={(data) => itemsOf(data).length === 0}
          emptyTitle={tab === "queue" ? "没有待审核的提现" : "没有符合条件的提现"}
          emptyHint={tab === "queue" ? "在交易前台「资产 → 提现」发起一笔，就会出现在这里。" : undefined}
        >
          {() => (
            <div className="table-scroll">
              <table className="data-table clickable" id="withdrawals-table">
                <thead>
                  <tr>
                    {tab === "queue" ? (
                      <th className="check">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.withdrawalId))}
                          aria-label="全选"
                        />
                      </th>
                    ) : null}
                    <th>申请时间</th>
                    <th>提现单</th>
                    <th>用户</th>
                    <th className="num">数量</th>
                    <th className="num">手续费</th>
                    <th>目标地址</th>
                    <th>规则校验</th>
                    <th>状态</th>
                    {tab === "queue" ? <th className="num">操作</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const validation = (row.metadata?.validation ?? {}) as Record<string, unknown>;
                    return (
                      <tr key={row.withdrawalId} onClick={() => setDetailId(row.withdrawalId)} data-withdrawal-id={row.withdrawalId}>
                        {tab === "queue" ? (
                          <td className="check" onClick={(event) => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected.includes(row.withdrawalId)}
                              onChange={() => toggle(row.withdrawalId)}
                              aria-label="选择"
                            />
                          </td>
                        ) : null}
                        <td><Time value={row.requestedAt} /></td>
                        <td><IdLink id={row.withdrawalId} kind="withdrawalId" /></td>
                        <td><IdLink id={row.userId} kind="userId" /></td>
                        <td className="num"><Amount value={row.amount} asset={row.assetCode} /></td>
                        <td className="num muted">{formatAmount(row.fee)}</td>
                        <td><IdLink id={row.toAddress} head={8} tail={6} /></td>
                        <td>
                          <span className="rule-tags">
                            <span className={validation.requireTwoFactor ? "rule on" : "rule"}>2FA</span>
                            <span className={validation.requireWhitelist ? "rule on" : "rule"}>白名单</span>
                            {validation.kycTier ? <span className="rule on">KYC {String(validation.kycTier)}</span> : null}
                            {approvalProgress(row).required === 2 ? <span className="rule on">双人复核</span> : null}
                            <span className="muted small">
                              当日已用 {formatAmount(String(validation.dailyUsedAmount ?? "0"))}
                            </span>
                          </span>
                        </td>
                        <td>
                          <StatusBadge status={row.status} /> <ApprovalBadge row={row} />
                        </td>
                        {tab === "queue" ? (
                          <td className="num actions" onClick={(event) => event.stopPropagation()}>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!review.canReview || review.alreadyApprovedByMe(row)}
                              title={review.alreadyApprovedByMe(row) ? "你已批准过，需要另一名运营人员复核" : undefined}
                              onClick={() => review.approve([row.withdrawalId])}
                              data-approve={row.withdrawalId}
                            >
                              {row.reviewStatus === "pending_second_approval" ? "复核批准" : "批准"}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={!review.canReview} onClick={() => review.reject([row.withdrawalId])}>
                              拒绝
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(query.data)} count={rows.length} onChange={setOffset} />
            </div>
          )}
        </QueryView>
      </Panel>

      <WithdrawalDrawer
        withdrawalId={detailId}
        onClose={() => setDetailId(undefined)}
        onApprove={(id) => review.approve([id])}
        onReject={(id) => review.reject([id])}
        canReview={review.canReview}
        alreadyApprovedByMe={review.alreadyApprovedByMe}
      />
      {review.dialog}
    </div>
  );
}

function WithdrawalDrawer(props: {
  withdrawalId: string | undefined;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  canReview: boolean;
  alreadyApprovedByMe?: (row: WithdrawalRecord | undefined) => boolean;
}) {
  const id = props.withdrawalId;
  // The BFF joins wallet, audit and custody data for one withdrawal.
  const detail = useOpsQuery<{
    withdrawal: WithdrawalRecord;
    auditLogs?: Paged<WithdrawalAuditLog>;
    custodyTransfer?: Record<string, unknown> | null;
  }>(id ? `/withdrawals/${encodeURIComponent(id)}` : null, { refreshMs: 5_000 });
  const userId = detail.data?.withdrawal.userId;
  const user = useOpsQuery<Paged<UserRecord>>(userId ? `/users${qs({ userId, limit: 1 })}` : null);
  const balances = useOpsQuery<Paged<BalanceRecord>>(userId ? `/balances${qs({ userId, limit: 20 })}` : null);
  const notifications = useOpsQuery<Paged<NotificationRecord>>(id ? `/notifications${qs({ withdrawalId: id, limit: 10 })}` : null);

  const w = detail.data?.withdrawal;
  const owner = itemsOf<UserRecord>(user.data)[0];
  const assetBalance = itemsOf<BalanceRecord>(balances.data).find((item) => item.assetCode === w?.assetCode);
  const pending = w?.status === "requested" || w?.status === "under_review";
  const progress = approvalProgress(w);
  const approvedByMe = props.alreadyApprovedByMe?.(w) ?? false;
  const failed = w?.status === "rejected" || w?.status === "failed";

  const riskNotes = useMemo(() => {
    if (!w) {
      return [];
    }
    const notes: Array<{ tone: "ok" | "warn"; text: string }> = [];
    const validation = (w.metadata?.validation ?? {}) as Record<string, unknown>;
    notes.push(
      owner?.status === "active"
        ? { tone: "ok", text: "用户状态正常" }
        : { tone: "warn", text: `用户状态为 ${owner?.status ?? "未知"}` }
    );
    notes.push(
      validation.requireWhitelist
        ? { tone: "ok", text: "目标地址已通过白名单校验" }
        : { tone: "warn", text: "当前环境未强制白名单，请人工核对目标地址" }
    );
    notes.push(
      validation.requireTwoFactor
        ? { tone: "ok", text: "提交时已校验用户 2FA" }
        : { tone: "warn", text: "当前环境未要求提现 2FA" }
    );
    if (assetBalance && toNumber(assetBalance.locked) + 1e-12 < toNumber(w.frozenAmount)) {
      notes.push({ tone: "warn", text: "账本冻结余额小于该提现冻结金额，请先对账" });
    } else if (assetBalance) {
      notes.push({ tone: "ok", text: "账本冻结余额足以覆盖本次提现" });
    }
    return notes;
  }, [w, owner, assetBalance]);

  return (
    <Drawer open={Boolean(id)} title="提现详情" onClose={props.onClose} width={560}>
      <QueryView state={detail}>
        {({ withdrawal: data, auditLogs, custodyTransfer }) => (
          <div className="drawer-stack" id="withdrawal-detail">
            <div className="drawer-hero">
              <Amount value={data.amount} asset={data.assetCode} />
              <StatusBadge status={data.status} />
            </div>
            <Steps steps={STEPS} current={stepIndex(data.status)} failed={failed} />

            {progress.required === 2 ? (
              <section id="withdrawal-approvals">
                <h4>
                  双人复核 <ApprovalBadge row={data} />
                </h4>
                <p className="muted small">
                  金额超过 {progress.threshold ?? "--"} {data.assetCode ?? ""} 的提现需要两名不同运营人员批准。
                </p>
                {progress.approvals.length === 0 ? (
                  <span className="muted">尚无批准</span>
                ) : (
                  <ol className="timeline">
                    {progress.approvals.map((approval, index) => (
                      <li key={`${approval.operatorId}:${index}`}>
                        <div className="timeline-head">
                          <strong>第 {index + 1} 位批准</strong>
                          <Time value={approval.approvedAt} />
                        </div>
                        <span className="muted small">
                          <IdLink id={approval.operatorId} />
                          {approval.note ? ` · ${approval.note}` : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ) : null}

            {pending && props.canReview ? (
              <div className="drawer-actions">
                <Button
                  variant="primary"
                  disabled={approvedByMe}
                  title={approvedByMe ? "你已批准过，需要另一名运营人员复核" : undefined}
                  onClick={() => props.onApprove(data.withdrawalId)}
                >
                  {progress.required === 2 && progress.approvals.length === 0
                    ? "第 1 位批准"
                    : progress.required === 2
                      ? approvedByMe
                        ? "等待另一名运营复核"
                        : "复核批准并广播"
                      : "批准并广播"}
                </Button>
                <Button variant="sell" onClick={() => props.onReject(data.withdrawalId)}>
                  拒绝
                </Button>
              </div>
            ) : null}

            {pending ? (
              <section>
                <h4>审核要点</h4>
                <ul className="risk-list">
                  {riskNotes.map((note) => (
                    <li key={note.text} className={note.tone}>
                      {note.tone === "ok" ? "✓" : "!"} {note.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h4>基本信息</h4>
              <KeyValue
                items={[
                  ["提现单号", <IdLink id={data.withdrawalId} kind="withdrawalId" head={12} />],
                  ["用户", <span>{owner?.email ?? "--"} · <IdLink id={data.userId} kind="userId" /></span>],
                  ["网络", data.network],
                  ["目标地址", <code className="wrap">{data.toAddress}</code>],
                  ["数量 / 手续费", `${formatAmount(data.amount)} / ${formatAmount(data.fee)} ${data.assetCode ?? ""}`],
                  ["账本冻结", `${formatAmount(data.frozenAmount)} ${data.assetCode ?? ""}`],
                  ["用户该币种余额", assetBalance ? `可用 ${formatAmount(assetBalance.available)} · 冻结 ${formatAmount(assetBalance.locked)}` : "--"],
                  ["交易哈希", data.txHash ? <IdLink id={data.txHash} kind="txHash" head={12} tail={8} /> : "--"],
                  ["申请时间", <Time value={data.requestedAt} />],
                  ["广播 / 确认", <span><Time value={data.broadcastedAt} /> / <Time value={data.confirmedAt} /></span>]
                ]}
              />
            </section>

            <section>
              <h4>审计轨迹</h4>
              {itemsOf<WithdrawalAuditLog>(auditLogs).length === 0 ? (
                <Empty title="暂无审计记录" />
              ) : (
                  <ol className="timeline">
                    {itemsOf<WithdrawalAuditLog>(auditLogs)
                      .slice()
                      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
                      .map((log) => (
                        <li key={log.auditLogId}>
                          <div className="timeline-head">
                            <strong>{log.action}</strong>
                            <Time value={log.createdAt} />
                          </div>
                          <span className="muted small">
                            {log.operatorRole ?? "system"} · <IdLink id={log.operatorId} />
                            {log.reason || log.note ? ` · ${log.reason ?? log.note}` : ""}
                          </span>
                        </li>
                      ))}
                  </ol>
              )}
            </section>

            {custodyTransfer ? (
              <section>
                <h4>托管广播</h4>
                <KeyValue
                  items={[
                    ["Provider", String(custodyTransfer.providerName ?? custodyTransfer.provider ?? "--")],
                    ["状态", <StatusBadge status={String(custodyTransfer.status ?? "")} />],
                    ["尝试次数", String(custodyTransfer.attemptCount ?? custodyTransfer.broadcastAttempts ?? "--")],
                    ["交易哈希", <IdLink id={String(custodyTransfer.txHash ?? "") || undefined} kind="txHash" head={12} tail={8} />]
                  ]}
                />
              </section>
            ) : null}

            <section>
              <h4>用户通知</h4>
              {itemsOf<NotificationRecord>(notifications.data).length === 0 ? (
                <Empty title="暂无通知" />
              ) : (
                <ul className="plain-list">
                  {itemsOf<NotificationRecord>(notifications.data).map((item) => (
                    <li key={item.notificationId}>
                      <StatusBadge status={item.status} /> <strong>{item.eventType}</strong>
                      <div className="muted small">{item.body}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="drawer-links">
              <a href={href(`/trace?withdrawalId=${encodeURIComponent(data.withdrawalId)}`)}>在业务追踪中查看 →</a>
            </div>
            <JsonView value={detail.data} />
          </div>
        )}
      </QueryView>
    </Drawer>
  );
}
