import { useState } from "react";

import { AssetIcon, Badge, Button, Empty, Panel, Tabs, formatAmount, href } from "@web3-cex/web-ui";

import { itemsOf, qs, totalOf } from "../lib/api.js";
import type {
  BalanceRecord,
  DepositRecord,
  KycProfile,
  KycRequestRecord,
  OrderRecord,
  Paged,
  UserRecord,
  WithdrawalRecord
} from "../lib/types.js";
import {
  Amount,
  ConfirmDialog,
  Drawer,
  IdLink,
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

interface AddressBookEntry {
  addressBookId: string;
  userId?: string;
  network?: string;
  address: string;
  label?: string;
  isWhitelisted?: boolean;
  createdAt?: string;
}

export function UsersPage(props: { initialUserId?: string }) {
  const [tab, setTab] = useState<"users" | "kyc" | "balances" | "addresses">("users");
  return (
    <div className="page">
      <PageHeader title="用户与资产" subtitle="身份来自 identity-service，余额来自 ledger-service 账本" />
      <Tabs
        className="page-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "users", label: "用户" },
          { value: "kyc", label: "KYC 审核" },
          { value: "balances", label: "余额" },
          { value: "addresses", label: "提现地址簿" }
        ]}
      />
      {tab === "users" ? <UsersTab initialUserId={props.initialUserId} /> : null}
      {tab === "kyc" ? <KycTab /> : null}
      {tab === "balances" ? <BalancesTab /> : null}
      {tab === "addresses" ? <AddressBookTab /> : null}
    </div>
  );
}

function UsersTab(props: { initialUserId?: string }) {
  const [search, setSearch] = useState("");
  const [userType, setUserType] = useState("customer");
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | undefined>(props.initialUserId);
  const query = useOpsQuery<Paged<UserRecord>>(`/users${qs({ search, userType, limit: PAGE_SIZE, offset })}`);
  const rows = itemsOf<UserRecord>(query.data);

  return (
    <Panel
      flush
      title={
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(String(new FormData(event.currentTarget).get("search") ?? "").trim());
            setOffset(0);
          }}
        >
          <input name="search" placeholder="邮箱 / 昵称 / userId" defaultValue={search} className="filter-input wide" id="user-search" />
          <select value={userType} onChange={(event) => { setUserType(event.target.value); setOffset(0); }} aria-label="用户类型">
            <option value="">全部类型</option>
            <option value="customer">客户</option>
            <option value="ops">运营</option>
          </select>
          <Button size="sm" type="submit">搜索</Button>
        </form>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="没有匹配的用户">
        {() => (
          <div className="table-scroll">
            <table className="data-table clickable" id="users-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>userId</th>
                  <th>类型</th>
                  <th>角色</th>
                  <th>2FA</th>
                  <th>KYC</th>
                  <th>注册时间</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => (
                  <tr key={user.userId} onClick={() => setDetailId(user.userId)}>
                    <td>
                      <strong>{user.displayName ?? "--"}</strong>
                      <div className="muted small">{user.email}</div>
                    </td>
                    <td><IdLink id={user.userId} kind="userId" /></td>
                    <td>{user.userType === "ops" ? "运营" : "客户"}</td>
                    <td className="muted">{user.roles?.join(", ") || "--"}</td>
                    <td>{user.twoFactorEnabled ? <Badge tone="positive">已开启</Badge> : <Badge tone="neutral">未开启</Badge>}</td>
                    <td>{user.userType === "ops" ? <span className="muted">--</span> : <KycTierBadge tier={user.kycTier} />}</td>
                    <td><Time value={user.createdAt} /></td>
                    <td><StatusBadge status={user.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(query.data)} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
      <UserDrawer userId={detailId} onClose={() => setDetailId(undefined)} onChanged={query.reload} />
    </Panel>
  );
}

function UserDrawer(props: { userId: string | undefined; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [confirm, setConfirm] = useState<"freeze" | "unfreeze" | null>(null);
  const id = props.userId;
  const user = useOpsQuery<Paged<UserRecord>>(id ? `/users${qs({ userId: id, limit: 1 })}` : null);
  const balances = useOpsQuery<Paged<BalanceRecord>>(id ? `/balances${qs({ userId: id, limit: 50 })}` : null);
  const orders = useOpsQuery<OrderRecord[]>(id ? `/spot/orders${qs({ userId: id, limit: 8 })}` : null);
  const deposits = useOpsQuery<Paged<DepositRecord>>(id ? `/deposits${qs({ userId: id, limit: 5 })}` : null);
  const withdrawals = useOpsQuery<Paged<WithdrawalRecord>>(id ? `/withdrawals${qs({ userId: id, limit: 5 })}` : null);
  const record = itemsOf<UserRecord>(user.data)[0];
  const frozen = record?.status === "frozen" || record?.status === "suspended";

  const toggleFreeze = async (reason: string) => {
    if (!id || !confirm) {
      return;
    }
    const result = await run(
      "freeze",
      { path: `/users/${encodeURIComponent(id)}/${confirm}`, body: { reason: reason || undefined } },
      { success: confirm === "freeze" ? "用户已冻结" : "用户已解冻" }
    );
    if (result) {
      setConfirm(null);
      user.reload();
      props.onChanged();
    }
  };

  return (
    <Drawer open={Boolean(id)} title="用户详情" onClose={props.onClose} width={600}>
      <QueryView state={user} empty={(data) => itemsOf(data).length === 0} emptyTitle="用户不存在">
        {() =>
          record ? (
            <div className="drawer-stack" id="user-detail">
              <div className="drawer-hero">
                <div>
                  <strong>{record.displayName}</strong>
                  <div className="muted">{record.email}</div>
                </div>
                <StatusBadge status={record.status} />
              </div>
              {can("ops.users.freeze") && record.userType !== "ops" ? (
                <div className="drawer-actions">
                  {frozen ? (
                    <Button variant="primary" onClick={() => setConfirm("unfreeze")}>解冻用户</Button>
                  ) : (
                    <Button variant="sell" onClick={() => setConfirm("freeze")} id="freeze-user">冻结用户</Button>
                  )}
                </div>
              ) : null}
              <KeyValue
                items={[
                  ["userId", <IdLink id={record.userId} kind="userId" head={12} />],
                  ["类型 / 角色", `${record.userType ?? "--"} / ${record.roles?.join(", ") || "--"}`],
                  ["二次验证", record.twoFactorEnabled ? "已开启" : "未开启"],
                  ["注册时间", <Time value={record.createdAt} />]
                ]}
              />

              {record.userType !== "ops" ? (
                <UserKycSection userId={record.userId} onChanged={() => { user.reload(); props.onChanged(); }} />
              ) : null}

              <section>
                <h4>资产（账本）</h4>
                {itemsOf<BalanceRecord>(balances.data).length === 0 ? (
                  <Empty title="暂无余额" />
                ) : (
                  <table className="data-table compact">
                    <thead>
                      <tr><th>币种</th><th className="num">可用</th><th className="num">冻结</th><th>账户</th></tr>
                    </thead>
                    <tbody>
                      {itemsOf<BalanceRecord>(balances.data).map((balance) => (
                        <tr key={`${balance.accountId}:${balance.assetCode}`}>
                          <td><span className="pair"><AssetIcon asset={balance.assetCode} size={18} />{balance.assetCode}</span></td>
                          <td className="num">{formatAmount(balance.available)}</td>
                          <td className="num muted">{formatAmount(balance.locked)}</td>
                          <td><IdLink id={balance.accountId} kind="accountId" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section>
                <h4>最近委托</h4>
                {itemsOf<OrderRecord>(orders.data).length === 0 ? (
                  <Empty title="暂无委托" />
                ) : (
                  <table className="data-table compact">
                    <tbody>
                      {itemsOf<OrderRecord>(orders.data).map((order) => (
                        <tr key={order.orderId}>
                          <td><IdLink id={order.orderId} kind="orderId" /></td>
                          <td>{order.market}</td>
                          <td className={order.side === "sell" ? "down" : "up"}>{order.side === "sell" ? "卖" : "买"}</td>
                          <td className="num">{formatAmount(order.quantity)} @ {formatAmount(order.price, 2)}</td>
                          <td><StatusBadge status={order.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section>
                <h4>充提记录</h4>
                <table className="data-table compact">
                  <tbody>
                    {itemsOf<DepositRecord>(deposits.data).map((deposit) => (
                      <tr key={deposit.depositId}>
                        <td><Badge tone="positive">充值</Badge></td>
                        <td><Amount value={deposit.amount} asset={deposit.assetCode} /></td>
                        <td><StatusBadge status={deposit.status} /></td>
                        <td><Time value={deposit.creditedAt ?? deposit.detectedAt} /></td>
                      </tr>
                    ))}
                    {itemsOf<WithdrawalRecord>(withdrawals.data).map((withdrawal) => (
                      <tr key={withdrawal.withdrawalId}>
                        <td><Badge tone="warning">提现</Badge></td>
                        <td><Amount value={withdrawal.amount} asset={withdrawal.assetCode} /></td>
                        <td><StatusBadge status={withdrawal.status} /></td>
                        <td><Time value={withdrawal.requestedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <div className="drawer-links">
                <a href={href(`/trace?userId=${encodeURIComponent(record.userId)}`)}>在业务追踪中查看 →</a>
              </div>
            </div>
          ) : null
        }
      </QueryView>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "freeze" ? "冻结用户" : "解冻用户"}
        description={
          confirm === "freeze"
            ? "冻结后该用户的会话与 API Key 鉴权会被拒绝，无法下单或提现。"
            : "解冻后用户可以重新登录并交易。"
        }
        confirmLabel={confirm === "freeze" ? "确认冻结" : "确认解冻"}
        danger={confirm === "freeze"}
        noteLabel="原因"
        noteRequired={confirm === "freeze"}
        busy={busy === "freeze"}
        onConfirm={(reason) => void toggleFreeze(reason)}
        onClose={() => setConfirm(null)}
      />
    </Drawer>
  );
}

function BalancesTab() {
  const [assetCode, setAssetCode] = useState("");
  const [accountType, setAccountType] = useState("spot");
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<Paged<BalanceRecord>>(`/balances${qs({ assetCode, accountType, limit: PAGE_SIZE, offset })}`);
  const rows = itemsOf<BalanceRecord>(query.data);
  return (
    <Panel
      flush
      title={
        <div className="filters">
          <select value={assetCode} onChange={(event) => { setAssetCode(event.target.value); setOffset(0); }} aria-label="币种">
            <option value="">全部币种</option>
            <AssetOptions />
          </select>
          <select value={accountType} onChange={(event) => { setAccountType(event.target.value); setOffset(0); }} aria-label="账户类型">
            <option value="">全部账户类型</option>
            <option value="spot">用户现货</option>
            <option value="treasury">平台国库</option>
            <option value="fee">手续费</option>
            <option value="opening_balance">期初权益</option>
          </select>
        </div>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0}>
        {() => (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>币种</th><th>账户</th><th>类型</th><th>用户</th><th className="num">可用</th><th className="num">冻结</th><th className="num">合计</th><th>更新</th></tr>
              </thead>
              <tbody>
                {rows.map((balance) => (
                  <tr key={`${balance.accountId}:${balance.assetCode}`}>
                    <td><span className="pair"><AssetIcon asset={balance.assetCode} size={18} />{balance.assetCode}</span></td>
                    <td><IdLink id={balance.accountId} kind="accountId" /></td>
                    <td className="muted">{balance.accountType}</td>
                    <td><IdLink id={balance.userId} kind="userId" /></td>
                    <td className="num">{formatAmount(balance.available)}</td>
                    <td className="num muted">{formatAmount(balance.locked)}</td>
                    <td className="num">{formatAmount(balance.total)}</td>
                    <td><Time value={balance.updatedAt} /></td>
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

function AddressBookTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const query = useOpsQuery<Paged<AddressBookEntry>>("/withdrawal-address-book?limit=100");
  const rows = itemsOf<AddressBookEntry>(query.data);
  const toggle = async (entry: AddressBookEntry) => {
    const action = entry.isWhitelisted ? "unwhitelist" : "whitelist";
    await run(
      entry.addressBookId,
      { path: `/withdrawal-address-book/${encodeURIComponent(entry.addressBookId)}/${action}` },
      { success: entry.isWhitelisted ? "已移出白名单" : "已加入白名单" }
    );
    query.reload();
  };
  return (
    <Panel flush title="用户提现地址簿" actions={<RefreshButton onClick={query.reload} loading={query.loading} />}>
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="暂无地址">
        {() => (
          <table className="data-table">
            <thead>
              <tr><th>备注</th><th>地址</th><th>网络</th><th>用户</th><th>添加时间</th><th>白名单</th><th className="num">操作</th></tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.addressBookId}>
                  <td>{entry.label ?? "--"}</td>
                  <td><code>{entry.address}</code></td>
                  <td>{entry.network}</td>
                  <td><IdLink id={entry.userId} kind="userId" /></td>
                  <td><Time value={entry.createdAt} /></td>
                  <td>{entry.isWhitelisted ? <Badge tone="positive">已加入</Badge> : <Badge tone="neutral">未加入</Badge>}</td>
                  <td className="num">
                    <Button size="sm" variant="ghost" disabled={!can("ops.address_book.manage")} loading={busy === entry.addressBookId} onClick={() => void toggle(entry)}>
                      {entry.isWhitelisted ? "移出" : "加入"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
    </Panel>
  );
}

const KYC_TIER_LABEL: Record<string, string> = { unverified: "未认证", L1: "L1", L2: "L2" };

function KycTierBadge(props: { tier: string | undefined }) {
  const tier = props.tier ?? "unverified";
  return (
    <Badge tone={tier === "L2" ? "positive" : tier === "L1" ? "info" : "neutral"}>
      {KYC_TIER_LABEL[tier] ?? tier}
    </Badge>
  );
}

const KYC_EVENT_LABEL: Record<string, string> = {
  request_approved: "审核通过",
  request_rejected: "审核拒绝",
  tier_adjusted: "手动调整"
};

/** M4-4: current tier, pending request and manual adjustment in the user drawer. */
function UserKycSection(props: { userId: string; onChanged: () => void }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const profile = useOpsQuery<KycProfile>(`/users/${encodeURIComponent(props.userId)}/kyc`);
  const [targetTier, setTargetTier] = useState<string | null>(null);
  const data = profile.data;

  const adjust = async (reason: string) => {
    if (!targetTier) {
      return;
    }
    const result = await run(
      "kyc-tier",
      { path: `/users/${encodeURIComponent(props.userId)}/kyc-tier`, body: { tier: targetTier, reason: reason || undefined } },
      { success: `KYC 等级已调整为 ${KYC_TIER_LABEL[targetTier] ?? targetTier}` }
    );
    if (result) {
      setTargetTier(null);
      profile.reload();
      props.onChanged();
    }
  };

  return (
    <section id="user-kyc">
      <h4>KYC 等级</h4>
      {data ? (
        <>
          <KeyValue
            items={[
              ["当前等级", <KycTierBadge tier={data.tier} />],
              ["更新时间", <Time value={data.tierUpdatedAt} />],
              [
                "待审核申请",
                data.pendingRequest
                  ? `${data.pendingRequest.requestedTier} · ${data.pendingRequest.fullName ?? ""} · ${data.pendingRequest.idNumberMasked ?? ""}`
                  : "无"
              ]
            ]}
          />
          {can("ops.users.manage") ? (
            <div className="drawer-actions">
              {["unverified", "L1", "L2"]
                .filter((tier) => tier !== data.tier)
                .map((tier) => (
                  <Button key={tier} size="sm" variant="ghost" onClick={() => setTargetTier(tier)}>
                    调整为 {KYC_TIER_LABEL[tier]}
                  </Button>
                ))}
            </div>
          ) : null}
          {(data.events ?? []).length > 0 ? (
            <ol className="timeline">
              {(data.events ?? []).map((event) => (
                <li key={event.eventId}>
                  <div className="timeline-head">
                    <strong>
                      {KYC_EVENT_LABEL[event.action] ?? event.action} · {KYC_TIER_LABEL[event.fromTier] ?? event.fromTier} → {KYC_TIER_LABEL[event.toTier] ?? event.toTier}
                    </strong>
                    <Time value={event.createdAt} />
                  </div>
                  <span className="muted small">
                    <IdLink id={event.actorId} />
                    {event.reason ? ` · ${event.reason}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : (
        <span className="muted">{profile.error ?? "加载中…"}</span>
      )}
      <ConfirmDialog
        open={targetTier !== null}
        title={`调整 KYC 等级为 ${targetTier ? KYC_TIER_LABEL[targetTier] ?? targetTier : ""}`}
        description="等级决定该用户的单笔与每日提现限额（wallet-service 在提现申请时校验）。调整会写入 KYC 事件与运营审计日志。"
        confirmLabel="确认调整"
        noteLabel="调整原因"
        noteRequired
        busy={busy === "kyc-tier"}
        onConfirm={(reason) => void adjust(reason)}
        onClose={() => setTargetTier(null)}
      />
    </section>
  );
}

/** M4-4: KYC review queue (demo data only — no real documents are collected). */
function KycTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [status, setStatus] = useState("pending");
  const [offset, setOffset] = useState(0);
  const [review, setReview] = useState<{ kind: "approve" | "reject"; request: KycRequestRecord; tier?: string } | null>(null);
  const query = useOpsQuery<Paged<KycRequestRecord>>(`/kyc/requests${qs({ status, limit: PAGE_SIZE, offset })}`, { refreshMs: 15_000 });
  const rows = itemsOf<KycRequestRecord>(query.data);

  const submit = async (note: string) => {
    if (!review) {
      return;
    }
    const id = encodeURIComponent(review.request.requestId);
    const result =
      review.kind === "approve"
        ? await run("kyc-review", { path: `/kyc/requests/${id}/approve`, body: { tier: review.tier, note: note || undefined } }, { success: `已批准为 ${review.tier}` })
        : await run("kyc-review", { path: `/kyc/requests/${id}/reject`, body: { reason: note } }, { success: "已拒绝 KYC 申请" });
    if (result) {
      setReview(null);
      query.reload();
    }
  };

  return (
    <Panel
      flush
      title={
        <div className="filters">
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="KYC 状态">
            <option value="pending">待审核</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
            <option value="">全部</option>
          </select>
          <span className="muted small">演示数据：姓名与证件号均为虚构，证件号只保存后 4 位</span>
        </div>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="没有 KYC 申请" emptyHint="用户在交易前台「账户」页提交认证申请后会出现在这里。">
        {() => (
          <div className="table-scroll">
            <table className="data-table" id="kyc-requests-table">
              <thead>
                <tr><th>提交时间</th><th>用户</th><th>当前</th><th>申请</th><th>姓名 / 证件</th><th>状态</th><th className="num">操作</th></tr>
              </thead>
              <tbody>
                {rows.map((request) => (
                  <tr key={request.requestId} data-kyc-request={request.requestId}>
                    <td><Time value={request.createdAt} /></td>
                    <td>
                      <strong>{request.displayName ?? "--"}</strong>
                      <div className="muted small">{request.email} · <IdLink id={request.userId} kind="userId" /></div>
                    </td>
                    <td><KycTierBadge tier={request.currentTier} /></td>
                    <td><Badge tone="info">{request.requestedTier}</Badge></td>
                    <td>{request.fullName ?? "--"}<div className="muted small"><code>{request.idNumberMasked}</code></div></td>
                    <td>
                      <StatusBadge status={request.status} />
                      {request.status !== "pending" ? (
                        <div className="muted small">{request.approvedTier ? `授予 ${request.approvedTier} · ` : ""}<IdLink id={request.reviewedBy} />{request.reviewNote ? ` · ${request.reviewNote}` : ""}</div>
                      ) : null}
                    </td>
                    <td className="num actions">
                      {request.status === "pending" && can("ops.users.manage") ? (
                        <>
                          <Button size="sm" variant="primary" onClick={() => setReview({ kind: "approve", request, tier: "L1" })}>批准 L1</Button>
                          <Button size="sm" variant="primary" onClick={() => setReview({ kind: "approve", request, tier: "L2" })}>批准 L2</Button>
                          <Button size="sm" variant="ghost" onClick={() => setReview({ kind: "reject", request })}>拒绝</Button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(query.data)} count={rows.length} onChange={setOffset} />
          </div>
        )}
      </QueryView>
      <ConfirmDialog
        open={review !== null}
        title={review?.kind === "approve" ? `批准 KYC 为 ${review.tier}` : "拒绝 KYC 申请"}
        description={
          review?.kind === "approve"
            ? "批准后用户立即获得对应等级的提现限额。审核人与备注写入 KYC 事件和运营审计日志。"
            : "拒绝后用户等级不变，可重新提交。"
        }
        confirmLabel={review?.kind === "approve" ? "确认批准" : "确认拒绝"}
        danger={review?.kind === "reject"}
        noteLabel={review?.kind === "approve" ? "审核备注" : "拒绝原因"}
        noteRequired={review?.kind === "reject"}
        busy={busy === "kyc-review"}
        onConfirm={(note) => void submit(note)}
        onClose={() => setReview(null)}
      />
    </Panel>
  );
}
