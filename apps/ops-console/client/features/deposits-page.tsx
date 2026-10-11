import { useState } from "react";

import { Button, Panel, Progress, Tabs } from "@web3-cex/web-ui";

import { itemsOf, qs, totalOf } from "../lib/api.js";
import type { DepositObservation, DepositRecord, Paged } from "../lib/types.js";
import {
  Amount,
  ConfirmDialog,
  IdLink,
  PageHeader,
  Pager,
  QueryView,
  RefreshButton,
  StatCard,
  StatusBadge,
  Time
} from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";
import { AssetOptions } from "../components/market-options.js";

const PAGE_SIZE = 20;
const REQUIRED_CONFIRMATIONS = 12;

interface IndexerOverview {
  status?: string;
  alerts?: string[];
  backlog?: { pendingDepositCount?: number; pendingWithdrawalCount?: number };
  reorgCursorCount?: number;
  cursors?: Array<{ network?: string; observationType?: string; lastScannedBlock?: number; updatedAt?: string }>;
}

export function DepositsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<"deposits" | "pending">("deposits");
  const overview = useOpsQuery<IndexerOverview>(can("ops.indexer.read") ? "/indexer/overview" : null, { refreshMs: 10_000 });

  return (
    <div className="page">
      <PageHeader
        title="充值与链上观察"
        subtitle="blockchain-indexer 扫描区块并推进确认数，达到阈值后 wallet-service 通知账本入账"
      />
      <div className="stat-grid">
        <StatCard label="待确认充值观察" value={overview.data?.backlog?.pendingDepositCount ?? "--"} tone={overview.data?.backlog?.pendingDepositCount ? "warning" : "positive"} />
        <StatCard label="待确认提现观察" value={overview.data?.backlog?.pendingWithdrawalCount ?? "--"} tone={overview.data?.backlog?.pendingWithdrawalCount ? "warning" : "positive"} />
        <StatCard label="链重组游标" value={overview.data?.reorgCursorCount ?? "--"} tone={overview.data?.reorgCursorCount ? "negative" : "positive"} />
        <StatCard
          label="Indexer 状态"
          value={overview.data ? <StatusBadge status={overview.data.status} /> : "--"}
          hint={overview.data?.alerts?.[0]}
        />
      </div>
      <Tabs
        className="page-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "deposits", label: "充值记录" },
          { value: "pending", label: "待确认观察", count: overview.data?.backlog?.pendingDepositCount }
        ]}
      />
      {tab === "deposits" ? <DepositsTable /> : <PendingObservations onChanged={overview.reload} />}
    </div>
  );
}

function DepositsTable() {
  const [status, setStatus] = useState("");
  const [assetCode, setAssetCode] = useState("");
  const [txHash, setTxHash] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useOpsQuery<Paged<DepositRecord>>(`/deposits${qs({ status, assetCode, txHash, limit: PAGE_SIZE, offset })}`, { refreshMs: 10_000 });
  const rows = itemsOf<DepositRecord>(query.data);
  return (
    <Panel
      flush
      title={
        <div className="filters">
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="状态">
            <option value="">全部状态</option>
            <option value="credited">已入账</option>
            <option value="confirmed">已确认</option>
            <option value="failed">失败</option>
          </select>
          <select value={assetCode} onChange={(event) => { setAssetCode(event.target.value); setOffset(0); }} aria-label="币种">
            <option value="">全部币种</option>
            <AssetOptions />
          </select>
          <input className="filter-input wide" placeholder="txHash" value={txHash} onChange={(event) => { setTxHash(event.target.value.trim()); setOffset(0); }} />
        </div>
      }
      actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
    >
      <QueryView state={query} empty={(data) => itemsOf(data).length === 0} emptyTitle="暂无充值" emptyHint="在交易前台的测试水龙头模拟一笔充值。">
        {() => (
          <div className="table-scroll">
            <table className="data-table" id="deposits-table">
              <thead>
                <tr><th>时间</th><th>充值单</th><th>用户</th><th className="num">数量</th><th>交易哈希</th><th>确认数</th><th>状态</th></tr>
              </thead>
              <tbody>
                {rows.map((deposit) => (
                  <tr key={deposit.depositId}>
                    <td><Time value={deposit.creditedAt ?? deposit.detectedAt} /></td>
                    <td><IdLink id={deposit.depositId} kind="depositId" /></td>
                    <td><IdLink id={deposit.userId} kind="userId" /></td>
                    <td className="num"><Amount value={deposit.amount} asset={deposit.assetCode} /></td>
                    <td><IdLink id={deposit.txHash} kind="txHash" head={10} tail={6} /></td>
                    <td>{deposit.confirmations ?? "--"}</td>
                    <td><StatusBadge status={deposit.status} /></td>
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

function PendingObservations(props: { onChanged: () => void }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<{ kind: "replay" | "close"; ids: string[] } | null>(null);
  const query = useOpsQuery<Paged<DepositObservation>>("/indexer/pending-deposits?limit=100", { refreshMs: 5_000 });
  const rows = itemsOf<DepositObservation>(query.data);
  const canManage = can("ops.indexer.pending.manage");

  const submit = async (note: string) => {
    if (!action) {
      return;
    }
    const single = action.ids.length === 1;
    const id = action.ids[0] ?? "";
    const path = single
      ? `/indexer/pending-deposits/${encodeURIComponent(id)}/${action.kind}`
      : `/indexer/pending-deposit-batches/${action.kind}`;
    const body = single ? { note: note || undefined } : { observationIds: action.ids, note: note || undefined };
    const result = await run(
      "pending",
      { path, body: action.kind === "replay" ? { ...body, confirmations: REQUIRED_CONFIRMATIONS } : body },
      { success: action.kind === "replay" ? "已按确认数重放，等待入账" : "观察记录已关闭" }
    );
    if (result) {
      setAction(null);
      setSelected([]);
      query.reload();
      props.onChanged();
    }
  };

  return (
    <Panel
      flush
      title="尚未达到确认阈值的充值观察"
      actions={
        <span className="panel-actions">
          {selected.length > 0 && canManage ? (
            <>
              <Button size="sm" variant="primary" onClick={() => setAction({ kind: "replay", ids: selected })}>批量重放</Button>
              <Button size="sm" variant="ghost" onClick={() => setAction({ kind: "close", ids: selected })}>批量关闭</Button>
            </>
          ) : null}
          <RefreshButton onClick={query.reload} loading={query.loading} />
        </span>
      }
    >
      <QueryView
        state={query}
        empty={(data) => itemsOf(data).length === 0}
        emptyTitle="没有待确认的充值"
        emptyHint="模拟链每 1.5 秒出块，水龙头充值通常 20 秒内达到 12 个确认。卡住的观察可以在这里人工重放或关闭。"
      >
        {() => (
          <table className="data-table">
            <thead>
              <tr>
                <th className="check">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selected.length === rows.length}
                    onChange={() => setSelected(selected.length === rows.length ? [] : rows.map((row) => row.observationId))}
                    aria-label="全选"
                  />
                </th>
                <th>检测时间</th><th>地址</th><th className="num">数量</th><th>交易哈希</th><th>区块</th><th>确认进度</th><th className="num">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const confirmations = row.confirmations ?? 0;
                return (
                  <tr key={row.observationId}>
                    <td className="check">
                      <input
                        type="checkbox"
                        checked={selected.includes(row.observationId)}
                        onChange={() => setSelected((current) => current.includes(row.observationId) ? current.filter((item) => item !== row.observationId) : [...current, row.observationId])}
                        aria-label="选择"
                      />
                    </td>
                    <td><Time value={row.createdAt} /></td>
                    <td><IdLink id={row.address} head={8} tail={6} /></td>
                    <td className="num"><Amount value={row.amount} asset={row.assetCode} /></td>
                    <td><IdLink id={row.txHash} kind="txHash" head={10} tail={6} /></td>
                    <td className="muted">{row.blockNumber ?? "--"}</td>
                    <td className="progress-cell">
                      <Progress value={confirmations / REQUIRED_CONFIRMATIONS} />
                      <span className="muted small">{confirmations}/{REQUIRED_CONFIRMATIONS}</span>
                    </td>
                    <td className="num actions">
                      <Button size="sm" variant="ghost" disabled={!canManage} onClick={() => setAction({ kind: "replay", ids: [row.observationId] })}>重放</Button>
                      <Button size="sm" variant="ghost" disabled={!canManage} onClick={() => setAction({ kind: "close", ids: [row.observationId] })}>关闭</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </QueryView>
      <ConfirmDialog
        open={action !== null}
        title={action?.kind === "replay" ? `重放 ${action.ids.length} 条充值观察` : `关闭 ${action?.ids.length ?? 0} 条充值观察`}
        description={
          action?.kind === "replay"
            ? `以 ${REQUIRED_CONFIRMATIONS} 个确认重新提交给 wallet-service，满足阈值后立即入账。仅在确认链上交易确实存在时使用。`
            : "关闭后这笔观察不再入账（例如链重组后交易已不存在）。"
        }
        confirmLabel={action?.kind === "replay" ? "确认重放" : "确认关闭"}
        danger={action?.kind === "close"}
        noteLabel="处置说明"
        noteRequired
        busy={busy === "pending"}
        onConfirm={(note) => void submit(note)}
        onClose={() => setAction(null)}
      />
    </Panel>
  );
}
