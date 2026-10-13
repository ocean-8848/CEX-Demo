import { useState } from "react";

import { Badge, Button, Modal, Panel, Tabs, formatAmount, shortHash } from "@web3-cex/web-ui";

import { qs } from "../lib/api.js";
import { AssetOptions } from "../components/market-options.js";
import {
  ConfirmDialog,
  Copyable,
  Drawer,
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
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

// --- wallet-service treasury payloads (see docs/api-contracts.md) -----------

interface Watermark {
  low: string;
  high: string;
  target: string;
}

interface HoldingRow {
  assetCode: string;
  network: string;
  depositAddresses: string;
  hot: string;
  cold: string;
  internalInTransit: string;
  total: string;
  withdrawalsInFlight: string;
  genesis: string;
  watermark?: Watermark;
  watermarkState: "unconfigured" | "below_low" | "within" | "above_high";
}

interface TreasuryOverview {
  generatedAt: string;
  confirmationThreshold: number;
  wallets: Array<{ network: string; hotAddress: string; coldAddress: string }>;
  holdings: HoldingRow[];
  openTransferCount: number;
  pendingApprovalCount: number;
}

interface ReconciliationRow {
  assetCode: string;
  depositAddresses: string;
  hot: string;
  cold: string;
  internalInTransit: string;
  reserves: string;
  ledgerLiabilities: string;
  withdrawalsInFlight: string;
  netLiabilities: string;
  surplus: string;
  reserveRatio?: string;
  hotCoverage?: string;
  status: "covered" | "shortfall" | "no_liabilities";
}

interface ReconciliationReport {
  generatedAt: string;
  ledgerGeneratedAt: string;
  status: "covered" | "shortfall";
  shortfallCount: number;
  userCount: number;
  items: ReconciliationRow[];
}

interface TransferEvent {
  at: string;
  action: string;
  actor?: string;
  note?: string;
  status: string;
}

interface TreasuryTransfer {
  transferId: string;
  kind: "genesis" | "sweep" | "rebalance_to_cold" | "rebalance_to_hot";
  status: string;
  trigger: string;
  assetCode: string;
  network: string;
  amount: string;
  fromWallet: string;
  toWallet: string;
  fromAddress?: string;
  toAddress: string;
  reason?: string;
  requestedBy: string;
  reviewedBy?: string;
  reviewNote?: string;
  txHash?: string;
  confirmations: number;
  custodyTransferId?: string;
  providerName?: string;
  lastError?: string;
  events: TransferEvent[];
  createdAt: string;
  sweptDepositIds?: string[];
}

interface PorAsset {
  assetCode: string;
  liabilities: string;
  netLiabilities: string;
  reserves: string;
  reserveRatio?: string;
  status: string;
}

interface PorSnapshot {
  snapshotId: string;
  merkleRoot: string;
  leafCount: number;
  treeDepth: number;
  assets: PorAsset[];
  generatedBy: string;
  createdAt: string;
}

const KIND_LABEL: Record<TreasuryTransfer["kind"], string> = {
  genesis: "注资上链",
  sweep: "归集",
  rebalance_to_cold: "热 → 冷",
  rebalance_to_hot: "冷 → 热"
};

const WALLET_LABEL: Record<string, string> = {
  external: "外部",
  deposit: "充值地址",
  hot: "热钱包",
  cold: "冷钱包"
};

const STATUS_LABEL: Record<string, string> = {
  proposed: "待审批",
  approved: "已批准",
  broadcasted: "已广播",
  confirmed: "已到账",
  rejected: "已拒绝",
  failed: "失败"
};

const WATERMARK_LABEL: Record<HoldingRow["watermarkState"], { label: string; tone: "positive" | "warning" | "negative" | "neutral" }> = {
  within: { label: "水位正常", tone: "positive" },
  above_high: { label: "高于上限", tone: "warning" },
  below_low: { label: "低于下限", tone: "negative" },
  unconfigured: { label: "未配置", tone: "neutral" }
};

type TransferTab = "pending" | "all" | "sweep" | "rebalance";

function ratioText(ratio: string | undefined): string {
  return ratio ? `${(Number(ratio) * 100).toFixed(2)}%` : "--";
}

/** 风控与运维 → 钱包与储备金: custody layering, watermarks, wallet-vs-ledger reconciliation, PoR. */
export function TreasuryPage() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [tab, setTab] = useState<TransferTab>("pending");
  const [proposing, setProposing] = useState(false);
  const [review, setReview] = useState<{ kind: "approve" | "reject"; transfer: TreasuryTransfer } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const overview = useOpsQuery<TreasuryOverview>("/treasury/overview", { refreshMs: 10_000 });
  const reconciliation = useOpsQuery<ReconciliationReport>("/treasury/reconciliation", { refreshMs: 15_000 });
  const transferQuery =
    tab === "pending"
      ? qs({ statuses: "proposed,approved,broadcasted,failed", limit: 50 })
      : tab === "sweep"
        ? qs({ kind: "sweep", limit: 50 })
        : tab === "rebalance"
          ? qs({ statuses: "proposed,approved,broadcasted,confirmed,rejected,failed", limit: 50 })
          : qs({ limit: 50 });
  const transfers = useOpsQuery<{ items: TreasuryTransfer[]; total: number }>(`/treasury/transfers${transferQuery}`, {
    refreshMs: 5_000
  });
  const snapshots = useOpsQuery<{ items: PorSnapshot[] }>("/treasury/proof-of-reserves/snapshots?limit=10");

  const canExecute = can("ops.ledger.execute");
  const canReview = can("ops.withdrawals.review");
  const reloadAll = () => {
    overview.reload();
    reconciliation.reload();
    transfers.reload();
    snapshots.reload();
  };

  const transferRows = (transfers.data?.items ?? []).filter((item) =>
    tab === "rebalance" ? item.kind === "rebalance_to_cold" || item.kind === "rebalance_to_hot" : true
  );
  const latest = snapshots.data?.items?.[0];

  return (
    <div className="page">
      <PageHeader
        title="钱包与储备金"
        subtitle="平台链上持仓按 充值地址 → 热钱包 ⇄ 冷钱包 分层；与账本用户负债逐币种对账，并生成储备金证明（PoR）"
        actions={<RefreshButton onClick={reloadAll} loading={overview.loading || reconciliation.loading} updatedAt={overview.updatedAt} />}
      />

      <div className="stat-grid">
        <StatCard
          label="钱包 vs 账本"
          value={
            reconciliation.data
              ? reconciliation.data.shortfallCount
                ? `${reconciliation.data.shortfallCount} 个币种储备不足`
                : "全部足额储备"
              : "--"
          }
          tone={reconciliation.data ? (reconciliation.data.shortfallCount ? "negative" : "positive") : "neutral"}
          hint={`账本负债来自 ${reconciliation.data?.userCount ?? "--"} 个用户`}
        />
        <StatCard
          label="待审批调拨"
          value={overview.data?.pendingApprovalCount ?? "--"}
          tone={overview.data?.pendingApprovalCount ? "warning" : "neutral"}
          hint="热钱包水位触发或运营手动发起"
        />
        <StatCard label="未完成内部转账" value={overview.data?.openTransferCount ?? "--"} hint={`到账需 ${overview.data?.confirmationThreshold ?? 12} 个确认`} />
        <StatCard
          label="最新储备金证明"
          value={latest ? <Time value={latest.createdAt} /> : "尚未生成"}
          hint={latest ? `${latest.leafCount} 个叶子 · 根 ${shortHash(latest.merkleRoot, 6, 4)}` : "在下方生成快照"}
        />
      </div>

      <Panel
        title="冷热分层（平台链上持仓）"
        flush
        actions={
          canExecute ? (
            <span className="panel-actions">
              <Button
                size="sm"
                loading={busy === "sweep"}
                id="treasury-sweep"
                onClick={async () => {
                  await run<{ plannedCount: number; broadcastedCount: number; failedCount: number }>(
                    "sweep",
                    { path: "/treasury/sweeps/run" },
                    { success: "归集任务已执行", detail: (result) => `计划 ${result.plannedCount} 笔，广播 ${result.broadcastedCount} 笔，失败 ${result.failedCount} 笔` }
                  );
                  reloadAll();
                }}
              >
                立即归集
              </Button>
              <Button
                size="sm"
                loading={busy === "watermark"}
                id="treasury-watermark"
                onClick={async () => {
                  await run<{ created: TreasuryTransfer[] }>(
                    "watermark",
                    { path: "/treasury/watermarks/evaluate" },
                    { success: "水位检查完成", detail: (result) => (result.created.length ? `新增 ${result.created.length} 笔调拨提案，等待审批` : "没有需要调拨的币种") }
                  );
                  reloadAll();
                }}
              >
                检查水位
              </Button>
              <Button size="sm" variant="primary" onClick={() => setProposing(true)} id="treasury-propose">
                发起调拨
              </Button>
            </span>
          ) : null
        }
      >
        <QueryView state={overview} empty={(data) => data.holdings.length === 0} emptyTitle="暂无持仓">
          {(data) => (
            <>
              <div className="table-scroll">
                <table className="data-table" id="treasury-holdings">
                  <thead>
                    <tr>
                      <th>币种</th>
                      <th className="num">充值地址</th>
                      <th className="num">热钱包</th>
                      <th className="num">冷钱包</th>
                      <th className="num">在途（内部）</th>
                      <th className="num">合计</th>
                      <th>热钱包水位（下限 / 目标 / 上限）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holdings.map((row) => {
                      const state = WATERMARK_LABEL[row.watermarkState];
                      return (
                        <tr key={`${row.assetCode}:${row.network}`}>
                          <td>
                            {row.assetCode} <span className="muted small">{row.network}</span>
                          </td>
                          <td className="num">{formatAmount(row.depositAddresses)}</td>
                          <td className={`num ${row.hot.startsWith("-") ? "down" : ""}`}>{formatAmount(row.hot)}</td>
                          <td className="num">{formatAmount(row.cold)}</td>
                          <td className="num muted">{formatAmount(row.internalInTransit)}</td>
                          <td className="num">{formatAmount(row.total)}</td>
                          <td>
                            <Badge tone={state.tone}>{state.label}</Badge>{" "}
                            {row.watermark ? (
                              <span className="muted small">
                                {formatAmount(row.watermark.low)} / {formatAmount(row.watermark.target)} / {formatAmount(row.watermark.high)}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="panel-footer">
                {data.wallets.map((wallet) => (
                  <span key={wallet.network} className="muted small">
                    {wallet.network} 热钱包 <code>{shortHash(wallet.hotAddress, 8, 6)}</code> · 冷钱包 <code>{shortHash(wallet.coldAddress, 8, 6)}</code>
                  </span>
                ))}
              </div>
            </>
          )}
        </QueryView>
      </Panel>

      <Panel title="钱包 vs 账本对账" flush>
        <QueryView state={reconciliation} empty={(data) => data.items.length === 0} emptyTitle="暂无数据">
          {(data) => (
            <div className="table-scroll">
              <table className="data-table" id="treasury-reconciliation">
                <thead>
                  <tr>
                    <th>币种</th>
                    <th className="num">链上储备</th>
                    <th className="num">账本用户负债</th>
                    <th className="num">在途提现</th>
                    <th className="num">净负债</th>
                    <th className="num">盈余（平台自有）</th>
                    <th className="num">储备率</th>
                    <th className="num">热钱包覆盖率</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.assetCode} className={row.status === "shortfall" ? "row-alert" : ""}>
                      <td>{row.assetCode}</td>
                      <td className="num">{formatAmount(row.reserves)}</td>
                      <td className="num">{formatAmount(row.ledgerLiabilities)}</td>
                      <td className="num muted">{formatAmount(row.withdrawalsInFlight)}</td>
                      <td className="num">{formatAmount(row.netLiabilities)}</td>
                      <td className={`num ${row.surplus.startsWith("-") ? "down" : "up"}`}>{formatAmount(row.surplus)}</td>
                      <td className="num">{ratioText(row.reserveRatio)}</td>
                      <td className="num muted">{ratioText(row.hotCoverage)}</td>
                      <td>
                        {row.status === "covered" ? (
                          <Badge tone="positive">足额</Badge>
                        ) : row.status === "shortfall" ? (
                          <Badge tone="negative">储备不足</Badge>
                        ) : (
                          <Badge tone="neutral">无负债</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
        <ol className="explain-steps treasury-explain">
          <li><b>链上储备</b> = 充值地址（已入账未归集）+ 热钱包 + 冷钱包 + 在途内部转账，来自 wallet-service 的链上持仓记录。</li>
          <li><b>账本用户负债</b> = ledger-service 中属于用户的账户（可用 + 冻结）合计；平台账户（期初权益、入金国库、手续费、结算）不计入。</li>
          <li><b>在途提现</b>：已从热钱包广播但账本冻结尚未在确认后消耗的提现金额，从负债侧扣除后两边才可比。</li>
          <li>这是覆盖率检查，不是相等检查：盈余是平台放在链上的自有资金（演示注资、保留在热钱包的提现手续费、交易手续费）。账本自身的分录对账见「账本对账」页，两者互不影响。</li>
        </ol>
      </Panel>

      <Panel
        title="调拨与归集记录"
        flush
        actions={
          <Tabs
            size="sm"
            value={tab}
            onChange={setTab}
            items={[
              { value: "pending", label: "进行中", count: overview.data?.openTransferCount },
              { value: "rebalance", label: "冷热调拨" },
              { value: "sweep", label: "归集" },
              { value: "all", label: "全部" }
            ]}
          />
        }
      >
        <QueryView
          state={transfers}
          empty={() => transferRows.length === 0}
          emptyTitle="暂无记录"
          emptyHint="充值入账后模拟器每 10 个区块自动归集一次；热钱包越过水位会生成待审批的调拨提案。"
        >
          {() => (
            <div className="table-scroll">
              <table className="data-table clickable" id="treasury-transfers">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th className="num">金额</th>
                    <th>方向</th>
                    <th>状态</th>
                    <th>发起 / 审批</th>
                    <th>交易</th>
                    <th className="num">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {transferRows.map((item) => (
                    <tr key={item.transferId} onClick={() => setDetailId(item.transferId)}>
                      <td><Time value={item.createdAt} /></td>
                      <td>{KIND_LABEL[item.kind]}</td>
                      <td className="num">
                        {formatAmount(item.amount)} <span className="muted">{item.assetCode}</span>
                      </td>
                      <td className="muted small">
                        {WALLET_LABEL[item.fromWallet] ?? item.fromWallet} → {WALLET_LABEL[item.toWallet] ?? item.toWallet}
                      </td>
                      <td>
                        <StatusBadge status={item.status === "proposed" ? "pending" : item.status} label={STATUS_LABEL[item.status] ?? item.status} />
                      </td>
                      <td className="muted small">
                        {item.requestedBy}
                        {item.reviewedBy ? ` / ${item.reviewedBy}` : ""}
                      </td>
                      <td className="muted small">
                        {item.txHash ? (
                          <>
                            <IdLink id={item.txHash} /> · {item.confirmations}/{overview.data?.confirmationThreshold ?? 12}
                          </>
                        ) : (
                          "--"
                        )}
                      </td>
                      <td className="num" onClick={(event) => event.stopPropagation()}>
                        {item.status === "proposed" && canReview ? (
                          <span className="button-row">
                            <Button size="sm" variant="primary" onClick={() => setReview({ kind: "approve", transfer: item })}>
                              批准
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setReview({ kind: "reject", transfer: item })}>
                              拒绝
                            </Button>
                          </span>
                        ) : item.status === "failed" && item.kind !== "sweep" && canExecute ? (
                          <Button
                            size="sm"
                            loading={busy === `retry:${item.transferId}`}
                            onClick={async () => {
                              await run(`retry:${item.transferId}`, { path: `/treasury/transfers/${item.transferId}/retry` }, { success: "已重新广播" });
                              reloadAll();
                            }}
                          >
                            重新广播
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

      <Panel
        title="储备金证明（PoR）"
        actions={
          canExecute ? (
            <Button
              size="sm"
              variant="primary"
              loading={busy === "por"}
              id="treasury-por-generate"
              onClick={async () => {
                await run<PorSnapshot>(
                  "por",
                  { path: "/treasury/proof-of-reserves/snapshots" },
                  { success: "已生成储备金快照", detail: (result) => `${result.leafCount} 个用户叶子，Merkle 根 ${shortHash(result.merkleRoot, 8, 6)}` }
                );
                snapshots.reload();
              }}
            >
              生成快照
            </Button>
          ) : null
        }
      >
        <QueryView
          state={snapshots}
          empty={(data) => data.items.length === 0}
          emptyTitle="还没有储备金快照"
          emptyHint="生成后，用户可以在交易前台「资产 → 储备金证明」用浏览器自行验证自己的余额被计入。"
        >
          {(data) => {
            const head = data.items[0]!;
            return (
              <>
                <KeyValue
                  items={[
                    ["Merkle 根", <Copyable value={head.merkleRoot} />],
                    ["叶子数 / 树高", `${head.leafCount} / ${head.treeDepth}`],
                    ["生成时间", <Time value={head.createdAt} />],
                    ["生成人", head.generatedBy]
                  ]}
                />
                <div className="table-scroll">
                  <table className="data-table compact" id="treasury-por-assets">
                    <thead>
                      <tr>
                        <th>币种</th>
                        <th className="num">储备</th>
                        <th className="num">负债（叶子合计）</th>
                        <th className="num">净负债</th>
                        <th className="num">储备率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {head.assets
                        .filter((asset) => asset.status !== "no_liabilities")
                        .map((asset) => (
                          <tr key={asset.assetCode}>
                            <td>{asset.assetCode}</td>
                            <td className="num">{formatAmount(asset.reserves)}</td>
                            <td className="num">{formatAmount(asset.liabilities)}</td>
                            <td className="num">{formatAmount(asset.netLiabilities)}</td>
                            <td className="num">
                              <Badge tone={asset.status === "covered" ? "positive" : "negative"}>{ratioText(asset.reserveRatio)}</Badge>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {data.items.length > 1 ? (
                  <p className="muted small">
                    历史快照：
                    {data.items.slice(1).map((item) => (
                      <span key={item.snapshotId}>
                        {" "}
                        <Time value={item.createdAt} />（{shortHash(item.merkleRoot, 6, 4)}）
                      </span>
                    ))}
                  </p>
                ) : null}
                <p className="muted small">
                  叶子 = SHA-256("por-leaf:v1|" + 盐化用户哈希 + "|" + 各币种余额)，盐化用户哈希 = SHA-256("por-user:v1|" + userId + "|" + 随机 nonce)。后台只保存每个用户自己的路径，用户之间互相看不到余额。
                </p>
              </>
            );
          }}
        </QueryView>
      </Panel>

      <ProposeDialog
        open={proposing}
        busy={busy === "propose"}
        onClose={() => setProposing(false)}
        onSubmit={async (body) => {
          const created = await run<TreasuryTransfer>(
            "propose",
            { path: "/treasury/transfers", body },
            { success: "调拨提案已创建", detail: () => "需要另一名有提现审核权限的运营人员批准" }
          );
          if (created) {
            setProposing(false);
            setTab("pending");
            reloadAll();
          }
        }}
      />

      <ConfirmDialog
        open={review !== null}
        title={review?.kind === "approve" ? "批准调拨并广播" : "拒绝调拨"}
        description={
          review ? (
            <span>
              {KIND_LABEL[review.transfer.kind]} {formatAmount(review.transfer.amount)} {review.transfer.assetCode}（发起人 {review.transfer.requestedBy}）。
              {review.kind === "approve"
                ? " 批准后 wallet-service 校验来源钱包余额，并通过 custody-adapter 签名广播；模拟链确认后计入目标钱包。发起人不能批准自己的提案。"
                : " 拒绝后提案关闭，下次水位检查会重新评估。"}
              {review.transfer.reason ? <><br />原因：{review.transfer.reason}</> : null}
            </span>
          ) : null
        }
        confirmLabel={review?.kind === "approve" ? "确认批准" : "确认拒绝"}
        danger={review?.kind === "reject"}
        noteLabel={review?.kind === "approve" ? "审批备注" : "拒绝原因"}
        noteRequired={review?.kind === "reject"}
        busy={busy === "review"}
        onConfirm={async (note) => {
          if (!review) {
            return;
          }
          const ok = await run(
            "review",
            {
              path: `/treasury/transfers/${review.transfer.transferId}/${review.kind}`,
              body: review.kind === "approve" ? { note: note || undefined } : { reason: note }
            },
            { success: review.kind === "approve" ? "调拨已批准并广播" : "调拨已拒绝" }
          );
          if (ok) {
            setReview(null);
            reloadAll();
          }
        }}
        onClose={() => setReview(null)}
      />

      <TransferDrawer transferId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function ProposeDialog(props: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { kind: string; assetCode: string; amount: string; reason: string }) => void;
}) {
  const [kind, setKind] = useState("rebalance_to_cold");
  const [assetCode, setAssetCode] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Modal open={props.open} title="发起冷热调拨" onClose={props.onClose}>
      <form
        className="confirm"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit({ kind, assetCode, amount: amount.trim(), reason: reason.trim() });
        }}
      >
        <label className="field">
          <span className="field-label">方向</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)} id="treasury-propose-kind">
            <option value="rebalance_to_cold">热钱包 → 冷钱包（降低被盗风险暴露）</option>
            <option value="rebalance_to_hot">冷钱包 → 热钱包（补充提现流动性）</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">币种</span>
          <select value={assetCode} onChange={(event) => setAssetCode(event.target.value)} id="treasury-propose-asset">
            <AssetOptions />
          </select>
        </label>
        <label className="field">
          <span className="field-label">金额</span>
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="例如 1000" id="treasury-propose-amount" />
        </label>
        <label className="field">
          <span className="field-label">原因</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="可选" />
        </label>
        <p className="muted small">提案需要另一名拥有提现审核权限的运营人员批准（职责分离）。</p>
        <div className="confirm-actions">
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit" loading={props.busy} disabled={!amount.trim()} id="treasury-propose-submit">
            提交提案
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TransferDrawer(props: { transferId: string | null; onClose: () => void }) {
  const detail = useOpsQuery<TreasuryTransfer>(props.transferId ? `/treasury/transfers/${props.transferId}` : null);
  return (
    <Drawer open={props.transferId !== null} title="内部转账详情" onClose={props.onClose} width={560}>
      <QueryView state={detail}>
        {(data) => (
          <>
            <KeyValue
              items={[
                ["类型", KIND_LABEL[data.kind]],
                ["金额", `${formatAmount(data.amount)} ${data.assetCode}`],
                ["方向", `${WALLET_LABEL[data.fromWallet] ?? data.fromWallet} → ${WALLET_LABEL[data.toWallet] ?? data.toWallet}`],
                ["来源地址", data.fromAddress ? <Copyable value={data.fromAddress} /> : "--"],
                ["目标地址", <Copyable value={data.toAddress} />],
                ["状态", <StatusBadge status={data.status} label={STATUS_LABEL[data.status] ?? data.status} />],
                ["触发", data.trigger],
                ["原因", data.reason ?? "--"],
                ["txHash", data.txHash ? <Copyable value={data.txHash} /> : "--"],
                ["确认数", String(data.confirmations)],
                ["托管", data.custodyTransferId ? `${data.providerName ?? ""} · ${shortHash(data.custodyTransferId, 8, 4)}` : "--"],
                ["错误", data.lastError ?? "--"]
              ]}
            />
            {data.sweptDepositIds?.length ? (
              <p className="muted small">
                归集的充值：
                {data.sweptDepositIds.map((id) => (
                  <span key={id}> <IdLink id={id} kind="depositId" /></span>
                ))}
              </p>
            ) : null}
            <h4>状态历史</h4>
            <ul className="timeline">
              {data.events.map((event, index) => (
                <li key={`${event.at}:${index}`}>
                  <Time value={event.at} /> <b>{event.action}</b> {event.actor ? <span className="muted">· {event.actor}</span> : null}
                  {event.note ? <div className="muted small">{event.note}</div> : null}
                </li>
              ))}
            </ul>
            <JsonView value={data} />
          </>
        )}
      </QueryView>
    </Drawer>
  );
}
