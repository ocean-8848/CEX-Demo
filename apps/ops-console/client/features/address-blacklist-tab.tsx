import { useState, type FormEvent } from "react";

import { Badge, Button, Panel } from "@web3-cex/web-ui";

import { itemsOf, qs } from "../lib/api.js";
import type { Paged } from "../lib/types.js";
import { ConfirmDialog, PageHeader, QueryView, RefreshButton, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

interface BlacklistEntry {
  entryId: string;
  network: string;
  address: string;
  category: string;
  reason: string;
  source: "seed" | "ops";
  status: "active" | "removed";
  createdBy?: string;
  createdAt: string;
  removedBy?: string;
  removedAt?: string;
  removalReason?: string;
}

interface RiskLabel {
  address: string;
  label: string;
  description: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  sanctioned: "制裁名单",
  mixer: "混币器",
  scam: "诈骗",
  hack: "被盗资金",
  other: "其他"
};

/**
 * 用户与资产 → 地址黑名单: simplified KYT. A blacklisted destination is
 * refused at request time; adding an address also auto-rejects pending
 * withdrawals to it (funds released, user notified). Writes need
 * ops.risk.manage and land in the ops action audit.
 */
export function AddressBlacklistTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [status, setStatus] = useState("active");
  const [removing, setRemoving] = useState<BlacklistEntry | null>(null);
  const canRead = can("ops.risk.read");
  const canManage = can("ops.risk.manage");
  const query = useOpsQuery<Paged<BlacklistEntry>>(canRead ? `/risk/address-blacklist${qs({ status, limit: 100 })}` : null);
  const labels = useOpsQuery<{ items: RiskLabel[] }>(canRead ? "/risk/address-labels" : null);
  const rows = itemsOf<BlacklistEntry>(query.data);

  if (!canRead) {
    return <Panel title="地址黑名单"><p className="muted">当前角色没有 ops.risk.read 权限。</p></Panel>;
  }

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await run<{ autoRejectedWithdrawalIds?: string[] }>(
      "add",
      {
        path: "/risk/address-blacklist",
        body: {
          network: String(data.get("network") ?? "ethereum"),
          address: String(data.get("address") ?? "").trim(),
          category: String(data.get("category") ?? "other"),
          reason: String(data.get("reason") ?? "").trim()
        }
      },
      {
        success: "已加入黑名单",
        detail: (value) =>
          value.autoRejectedWithdrawalIds?.length
            ? `自动拒绝了 ${value.autoRejectedWithdrawalIds.length} 笔待审核提现，冻结资金已解冻`
            : "之后向该地址的提现会被直接拦截"
      }
    );
    if (result) {
      form.reset();
      query.reload();
    }
  };

  const remove = async (reason: string) => {
    if (!removing) {
      return;
    }
    const result = await run(
      "remove",
      { path: `/risk/address-blacklist/${encodeURIComponent(removing.entryId)}/remove`, body: { reason } },
      { success: "已移出黑名单" }
    );
    if (result) {
      setRemoving(null);
      query.reload();
    }
  };

  return (
    <div className="drawer-stack" id="address-blacklist">
      <PageHeader
        title="地址黑名单（简化 KYT）"
        subtitle="命中黑名单的地址禁止提现；混币 / 高风险标签地址评为高风险，需双人复核"
      />
      {canManage ? (
        <Panel title="加入黑名单">
          <form className="filters" onSubmit={(event) => void add(event)} id="blacklist-form">
            <select name="network" defaultValue="ethereum" aria-label="网络">
              <option value="ethereum">ethereum</option>
              <option value="bsc">bsc</option>
              <option value="base">base</option>
            </select>
            <input name="address" required placeholder="0x 开头的 EVM 地址" className="filter-input wide" />
            <select name="category" defaultValue="sanctioned" aria-label="类别">
              {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <input name="reason" required placeholder="原因（必填，写入审计）" className="filter-input wide" />
            <Button size="sm" variant="sell" type="submit" loading={busy === "add"}>加入黑名单</Button>
          </form>
        </Panel>
      ) : null}

      <Panel
        flush
        title={
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状态">
            <option value="active">生效中</option>
            <option value="removed">已移除</option>
            <option value="">全部</option>
          </select>
        }
        actions={<RefreshButton onClick={query.reload} loading={query.loading} />}
      >
        <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="黑名单为空">
          {() => (
            <div className="table-scroll">
              <table className="data-table" id="blacklist-table">
                <thead>
                  <tr>
                    <th>地址</th>
                    <th>网络</th>
                    <th>类别</th>
                    <th>原因</th>
                    <th>来源 / 操作人</th>
                    <th>加入时间</th>
                    <th>状态</th>
                    <th className="num">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.entryId}>
                      <td><code>{entry.address}</code></td>
                      <td>{entry.network}</td>
                      <td><Badge tone="negative">{CATEGORY_LABEL[entry.category] ?? entry.category}</Badge></td>
                      <td>{entry.reason}</td>
                      <td className="muted">{entry.source === "seed" ? "演示种子" : entry.createdBy ?? "--"}</td>
                      <td><Time value={entry.createdAt} /></td>
                      <td>
                        {entry.status === "active" ? (
                          <Badge tone="negative">生效中</Badge>
                        ) : (
                          <span title={entry.removalReason}>
                            <Badge tone="neutral">已移除</Badge>
                            <span className="muted small"> {entry.removedBy ?? ""} · {entry.removalReason ?? ""}</span>
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {entry.status === "active" ? (
                          <Button size="sm" variant="ghost" disabled={!canManage} onClick={() => setRemoving(entry)}>
                            移出
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Panel>

      <Panel title="演示地址标签（模拟 KYT 情报）">
        <p className="muted small">
          这些地址不在黑名单里，但带高风险标签：向它们提现会被评为高风险，进入审核队列并需要两名运营批准。
        </p>
        <table className="data-table compact">
          <tbody>
            {(labels.data?.items ?? []).map((label) => (
              <tr key={label.address}>
                <td><code>{label.address}</code></td>
                <td><Badge tone="warning">{label.label}</Badge></td>
                <td className="muted">{label.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <ConfirmDialog
        open={removing !== null}
        title="移出黑名单"
        description={removing ? `移出后可以再次向 ${removing.address} 提现（仍会按其他规则评分）。` : undefined}
        confirmLabel="确认移出"
        noteLabel="移出原因"
        noteRequired
        busy={busy === "remove"}
        onConfirm={(reason) => void remove(reason)}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
