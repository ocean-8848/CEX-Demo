import { useState, type ReactNode } from "react";

import { Badge, Button, Panel, shortHash } from "@web3-cex/web-ui";

import { qs } from "../lib/api.js";
import { JsonView, QueryView, RefreshButton, StatCard, StatusBadge, Time } from "../components/kit.js";
import { useMarketConfig, useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

/** Same set the BFF requires (only ops_admin holds all three by default). */
const LAB_PERMISSIONS = ["ops.ledger.execute", "ops.providers.manage", "ops.indexer.execute"];

type Section<T> = { available: true; data: T } | { available: false; error: string };

interface SettlementLabState {
  pause?: { paused?: boolean; expiresAt?: string; pausedAt?: string; skippedCycleCount?: number; lastResumeTrigger?: string; lastResumedAt?: string };
  lag?: Array<{ market: string; lastExecutionSequence?: number; latestExecutionSequence?: number; executionSequenceLag?: number }>;
}

interface CustodyRouteState {
  providerName: string;
  network: string;
  priority: number;
  healthStatus?: string;
  circuitState?: string;
  consecutiveFailures?: number;
  broadcastSuccessCount?: number;
  broadcastFailureCount?: number;
  circuitOpenUntil?: string;
  lastErrorMessage?: string;
}

interface CustodyLabState {
  injections?: Array<{ providerName: string; expiresAt: string; failedCallCount?: number }>;
  injectableProviders?: string[];
  routes?: CustodyRouteState[];
}

interface ProbeResult {
  attempts?: Array<{ attempt: number; providerName?: string; outcome: string; errorMessage?: string; circuitStateAfter?: string; consecutiveFailuresAfter?: number }>;
}

interface ChainDepositRow {
  observationId: string;
  txHash: string;
  assetCode: string;
  amount: string;
  confirmations: number;
  blockNumber?: number;
  status: string;
  reorgDetectedAt?: string;
  reorgedFromBlockNumber?: number;
}

interface ChainLabState {
  blockHeight?: number;
  requiredConfirmations?: number;
  maxReorgDepth?: number;
  halted?: boolean;
  halt?: { until?: string } | null;
  reorgCount?: number;
  lastReorg?: {
    at: string;
    depth: number;
    orphanedBlocks: { from: number; to: number };
    replacementBlock: number;
    deposits: Array<{ txHash: string; before: { blockNumber: number; confirmations: number }; after: { blockNumber?: number; confirmations?: number; reorgedFromBlockNumber?: number } }>;
    withdrawalsReincluded: number;
  } | null;
  pendingDeposits?: ChainDepositRow[];
}

interface LabStatus {
  generatedAt: string;
  market: string;
  settlement: Section<SettlementLabState>;
  custody: Section<CustodyLabState>;
  chain: Section<ChainLabState>;
  engine: {
    anomalies: Section<{ items: Array<{ type: string; orderId?: string; detail?: string }> }>;
    overview: Section<{ openOrderCount?: number; engineBidCount?: number; engineAskCount?: number; tradeCount?: number }>;
  };
  activeFaults: Array<{ experiment: string; summary: string; expiresAt?: string }>;
}

export function FaultLabTab() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const marketConfig = useMarketConfig();
  const [selected, setSelected] = useState("");
  // Markets come from config/markets.json; default to its defaultMarket.
  const market = selected || marketConfig.defaultMarket;
  const [results, setResults] = useState<Record<string, unknown>>({});
  const status = useOpsQuery<LabStatus>(market ? `/lab/status${qs({ market })}` : null, { refreshMs: 3_000 });
  const canLab = LAB_PERMISSIONS.every((permission) => can(permission));
  const canReplay = can("ops.ledger.execute");

  const act = async (key: string, path: string, body: Record<string, unknown>, success: string) => {
    const result = await run<Record<string, unknown>>(key, { path, body }, { success });
    if (result) {
      setResults((previous) => ({ ...previous, [key.split(":")[0] ?? key]: result }));
    }
    status.reload();
    return result;
  };
  const labButton = (key: string, label: string, path: string, body: Record<string, unknown>, success: string, variant: "primary" | "secondary" | "ghost" | "danger" = "secondary") => (
    <Button size="sm" variant={variant} disabled={!canLab} loading={busy === key} onClick={() => void act(key, path, body, success)}>
      {label}
    </Button>
  );

  return (
    <div className="page-stack">
      <Panel
        title="故障注入实验室"
        actions={
          <span className="panel-actions">
            <select value={market} onChange={(event) => setSelected(event.target.value)} aria-label="撮合市场">
              {marketConfig.markets.map(({ market: item }) => (
                <option key={item} value={item}>
                  {item.replace("-", "/")}
                </option>
              ))}
            </select>
            <RefreshButton onClick={status.reload} loading={status.loading} updatedAt={status.updatedAt} />
            {labButton("recover-all", "一键恢复全部", "/lab/recover-all", {}, "已清除全部实验故障", "primary")}
          </span>
        }
      >
        <p className="muted small">
          在本地演示环境里制造真实故障，观察系统如何降级、告警和恢复。每个故障都会在到期后自动解除，也可以随时手动恢复；回退深度始终小于确认阈值，恢复后账本对账保持一致。所有触发与恢复操作都会写入操作审计。
        </p>
        {!canLab ? (
          <p className="small"><Badge tone="warning">只读</Badge> 触发实验需要 ops_admin（同时具备 {LAB_PERMISSIONS.join(" / ")}）。</p>
        ) : null}
        <QueryView state={status}>
          {(data) =>
            data.activeFaults.length === 0 ? (
              <p className="small"><Badge tone="positive">无活动故障</Badge> 系统处于正常状态。</p>
            ) : (
              <ul className="alert-list">
                {data.activeFaults.map((fault) => (
                  <li key={`${fault.experiment}:${fault.summary}`}>
                    <span>
                      <Badge tone="warning">{EXPERIMENT_LABEL[fault.experiment] ?? fault.experiment}</Badge> {fault.summary}
                      {fault.expiresAt ? <span className="muted small"> · 自动解除 <Countdown until={fault.expiresAt} /></span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
        {results["recover-all"] ? <JsonView value={results["recover-all"]} label="最近一次恢复结果" /> : null}
      </Panel>

      <div className="lab-grid">
        <Panel title="① 暂停结算消费者" actions={<SectionBadge section={status.data?.settlement} active={status.data?.settlement.available ? Boolean(status.data.settlement.data.pause?.paused) : false} />}>
          <LabGuide
            expected="撮合照常成交，但 settlement-service 不再消费 trade.executed，checkpoint 停止推进；「已成交未结算」随做市成交持续增长，用户成交后余额仍处于冻结状态。"
            where="本卡片的结算滞后；系统运维 → 事件总线（checkpointLag）；交易前台订单已成交但资产未变化。"
            recover="点「恢复消费」或等待到期自动恢复；消费者从 checkpoint 继续读取 Redis Stream 追平，滞后归零，账本对账一致。"
          />
          <SectionBody section={status.data?.settlement}>
            {(settlement) => {
              const lag = settlement.lag ?? [];
              const unsettled = lag.reduce((sum, item) => sum + (item.executionSequenceLag ?? 0), 0);
              return (
                <>
                  <div className="stat-grid">
                    <StatCard label="已成交未结算" value={unsettled} tone={unsettled > 0 ? "warning" : "positive"} hint={lag.map((item) => `${item.market}: ${item.executionSequenceLag ?? 0}`).join(" · ") || "暂无 checkpoint"} />
                    <StatCard label="消费者" value={settlement.pause?.paused ? "已暂停" : "运行中"} tone={settlement.pause?.paused ? "negative" : "positive"} hint={settlement.pause?.paused ? <>跳过 {settlement.pause.skippedCycleCount ?? 0} 轮 · 剩余 <Countdown until={settlement.pause.expiresAt} /></> : settlement.pause?.lastResumedAt ? <>上次恢复（{settlement.pause.lastResumeTrigger === "expired" ? "到期" : "手动"}）<Time value={settlement.pause.lastResumedAt} /></> : undefined} />
                  </div>
                </>
              );
            }}
          </SectionBody>
          <div className="button-grid">
            {labButton("settlement-pause", "暂停结算消费（2 分钟）", "/lab/settlement/pause", { durationSeconds: 120 }, "结算消费者已暂停", "danger")}
            {labButton("settlement-resume", "恢复消费", "/lab/settlement/resume", {}, "结算消费者已恢复")}
          </div>
        </Panel>

        <Panel title="② 托管广播连续失败" actions={<SectionBadge section={status.data?.custody} active={status.data?.custody.available ? (status.data.custody.data.injections ?? []).length > 0 : false} />}>
          <LabGuide
            expected="mock-custody 每次广播都失败且健康检查报告 unhealthy；连续失败达到阈值（默认 2 次）后熔断器打开，路由切到下一优先级的 mock-custody-backup，之后的广播（含真实提现）由备用通道完成。"
            where="本卡片路由表与探测结果；系统运维 → 托管通道；告警页的托管来源（open circuit / unhealthy route）。"
            recover="点「清除故障」会立即执行一次健康检查：连续失败清零、熔断闭合，路由回到主通道；不处理则故障到期后由下一次定时健康检查（30s）恢复。"
          />
          <SectionBody section={status.data?.custody}>
            {(custody) => (
              <>
                {(custody.injections ?? []).map((injection) => (
                  <p key={injection.providerName} className="small">
                    <Badge tone="negative">故障中</Badge> <code>{injection.providerName}</code> 已拦截 {injection.failedCallCount ?? 0} 次广播 · 剩余 <Countdown until={injection.expiresAt} />
                  </p>
                ))}
                <div className="table-scroll">
                  <table className="data-table compact">
                    <thead><tr><th>Provider</th><th>优先级</th><th>健康</th><th>熔断器</th><th className="num">连续失败</th><th className="num">成功 / 失败</th></tr></thead>
                    <tbody>
                      {(custody.routes ?? []).map((route) => (
                        <tr key={`${route.providerName}:${route.network}`}>
                          <td><code>{route.providerName}</code></td>
                          <td>{route.priority}</td>
                          <td><StatusBadge status={route.healthStatus} /></td>
                          <td><StatusBadge status={route.circuitState === "closed" ? "ok" : route.circuitState} label={route.circuitState === "closed" ? "闭合" : route.circuitState === "open" ? "熔断" : route.circuitState === "half_open" ? "半开" : route.circuitState} /></td>
                          <td className="num">{route.consecutiveFailures ?? 0}</td>
                          <td className="num">{route.broadcastSuccessCount ?? 0} / {route.broadcastFailureCount ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </SectionBody>
          {(results["custody-probe"] as ProbeResult | undefined)?.attempts?.length ? (
            <ol className="lab-steps small">
              {(results["custody-probe"] as ProbeResult).attempts?.map((attempt) => (
                <li key={attempt.attempt}>
                  <code>{attempt.providerName ?? "--"}</code> <StatusBadge status={attempt.outcome} label={PROBE_LABEL[attempt.outcome] ?? attempt.outcome} />
                  {attempt.circuitStateAfter ? <span className="muted"> 熔断器 {attempt.circuitStateAfter}，连续失败 {attempt.consecutiveFailuresAfter ?? 0}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          <div className="button-grid">
            {labButton("custody-inject", "注入 mock-custody 故障（3 分钟）", "/lab/custody/inject", { providerName: "mock-custody", durationSeconds: 180 }, "已注入托管广播故障", "danger")}
            {labButton("custody-probe", "发送 3 笔探测广播", "/lab/custody/probe", { count: 3 }, "探测广播已完成")}
            {labButton("custody-clear", "清除故障并健康检查", "/lab/custody/clear", {}, "托管故障已清除")}
          </div>
          <p className="muted small">探测广播只会发往 mock 通道（不落库、不产生提现），但会计入路由的成功 / 失败统计。</p>
        </Panel>

        <Panel title="③ 链重组（回退已推进确认数的区块）" actions={<SectionBadge section={status.data?.chain} active={status.data?.chain.available ? Boolean(status.data.chain.data.halted) : false} />}>
          <LabGuide
            expected="模拟链回退最近 N 个区块并在新分叉上重新出块：落在被回退区块里、尚未满确认的充值确认数跌回 1，indexer 记录 reorgDetectedAt / reorgedFromBlockNumber；随后重新累积确认并正常入账。已入账充值不受影响（回退深度 < 确认阈值）。"
            where="本卡片的待确认充值表与最近一次重组；充值页的确认进度；告警页 indexer 的 reorg_cursor_count。"
            recover="无需人工干预，重新确认后自动入账；核对无误后点「确认重组已处理」清除 indexer 游标上的重组标记（告警随之消失）。可先「暂停出块」放慢节奏便于观察。"
          />
          <SectionBody section={status.data?.chain}>
            {(chain) => (
              <>
                <div className="stat-grid">
                  <StatCard label="区块高度" value={chain.blockHeight ?? "--"} hint={chain.halted ? <>已暂停出块 · 剩余 <Countdown until={chain.halt?.until} /></> : `确认阈值 ${chain.requiredConfirmations ?? 12}`} tone={chain.halted ? "warning" : "neutral"} />
                  <StatCard label="重组次数" value={chain.reorgCount ?? 0} hint={chain.lastReorg ? <>最近：回退 #{chain.lastReorg.orphanedBlocks.from}–#{chain.lastReorg.orphanedBlocks.to}，替换块 #{chain.lastReorg.replacementBlock}</> : "尚未触发"} />
                </div>
                {chain.lastReorg?.deposits?.length ? (
                  <table className="data-table compact">
                    <thead><tr><th>重组影响的充值</th><th>重组前</th><th>重组后</th></tr></thead>
                    <tbody>
                      {chain.lastReorg.deposits.map((deposit) => (
                        <tr key={deposit.txHash}>
                          <td><code>{shortHash(deposit.txHash)}</code></td>
                          <td>#{deposit.before.blockNumber} · {deposit.before.confirmations} 确认</td>
                          <td>#{deposit.after.blockNumber ?? "--"} · {deposit.after.confirmations ?? "--"} 确认{deposit.after.reorgedFromBlockNumber !== undefined ? <span className="muted">（原 #{deposit.after.reorgedFromBlockNumber}）</span> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <div className="table-scroll">
                  <table className="data-table compact">
                    <thead><tr><th>待确认充值</th><th>资产</th><th>区块</th><th className="num">确认</th><th>重组</th><th>状态</th></tr></thead>
                    <tbody>
                      {(chain.pendingDeposits ?? []).length === 0 ? (
                        <tr><td colSpan={6} className="muted">当前没有确认中的充值；「触发重组」会自动为演示交易员制造一笔。</td></tr>
                      ) : (
                        (chain.pendingDeposits ?? []).map((deposit) => (
                          <tr key={deposit.observationId}>
                            <td><code>{shortHash(deposit.txHash)}</code></td>
                            <td>{deposit.amount} {deposit.assetCode}</td>
                            <td>#{deposit.blockNumber ?? "--"}</td>
                            <td className="num">{deposit.confirmations}/{chain.requiredConfirmations ?? 12}</td>
                            <td>{deposit.reorgDetectedAt ? <Badge tone="warning">原 #{deposit.reorgedFromBlockNumber ?? "?"}</Badge> : "--"}</td>
                            <td><StatusBadge status={deposit.status} /></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </SectionBody>
          <div className="button-grid">
            {labButton("chain-reorg", "触发重组（回退 6 块）", "/lab/chain/reorg", { depth: 6 }, "链重组已触发", "danger")}
            {labButton("chain-seed", "制造确认中充值", "/lab/chain/seed-deposit", { confirmations: 6 }, "已制造一笔 0.01 ETH 充值")}
            {status.data?.chain.available && status.data.chain.data.halted
              ? labButton("chain-resume", "恢复出块", "/lab/chain/resume", {}, "模拟链已恢复出块")
              : labButton("chain-halt", "暂停出块（3 分钟）", "/lab/chain/halt", { durationSeconds: 180 }, "模拟链已暂停出块")}
            {labButton("chain-ack", "确认重组已处理", "/lab/indexer/reorg-acknowledge", {}, "已清除 indexer 重组标记", "ghost")}
          </div>
        </Panel>

        <Panel title={`④ 撮合引擎重置（${market}）`} actions={<SectionBadge section={status.data?.engine.anomalies} active={status.data?.engine.anomalies.available ? status.data.engine.anomalies.data.items.length > 0 : false} />}>
          <LabGuide
            expected="引擎内存订单簿被清空而数据库仍有挂单，出现 engine_missing_open_order 异常，盘口变薄。仅清空订单簿时序号未回退，order-service 的自动同步不会察觉；模拟重启（序号归零）时，自动同步（默认每 2s）发现序号落后，自动恢复序号并回放挂单。"
            where="本卡片的异常数与引擎 / 数据库挂单对比；交易监控页的异常列表；交易前台盘口。"
            recover="点「从数据库重建订单簿」按数据库挂单回放进引擎，异常归零；模拟重启场景通常几秒内自愈。"
          />
          <EngineObservation status={status.data} />
          {results["engine-reset"] ? (
            <p className="small">
              最近一次重置：异常 {String((results["engine-reset"] as { anomalyCountBefore?: number }).anomalyCountBefore ?? "--")} → {String((results["engine-reset"] as { anomalyCountAfter?: number }).anomalyCountAfter ?? "--")}
            </p>
          ) : null}
          <div className="button-grid">
            {labButton("engine-reset:book", "清空订单簿（保留序号）", "/lab/engine/reset", { market, resetSequences: false }, "引擎订单簿已清空", "danger")}
            {labButton("engine-reset:restart", "模拟引擎重启（重置序号）", "/lab/engine/reset", { market, resetSequences: true }, "已模拟引擎重启", "danger")}
            <Button size="sm" variant="primary" disabled={!canReplay} loading={busy === "engine-replay"} onClick={() => void act("engine-replay", "/spot/ops/replay-engine", { market }, "已从数据库重建订单簿")}>
              从数据库重建订单簿
            </Button>
          </div>
        </Panel>
      </div>
      {Object.keys(results).length > 0 ? <JsonView value={results} label="最近操作返回" /> : null}
    </div>
  );
}

const EXPERIMENT_LABEL: Record<string, string> = {
  settlement: "结算",
  custody: "托管",
  chain: "链",
  engine: "撮合"
};

const PROBE_LABEL: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  no_route: "无可用通道",
  skipped_real_provider: "跳过真实通道"
};

function EngineObservation(props: { status: LabStatus | undefined }) {
  const anomalies = props.status?.engine.anomalies;
  const overview = props.status?.engine.overview;
  if (!anomalies || !overview) {
    return null;
  }
  if (!anomalies.available) {
    return <p className="small"><Badge tone="negative">不可用</Badge> {anomalies.error}</p>;
  }
  const items = anomalies.data.items;
  return (
    <>
      <div className="stat-grid">
        <StatCard label="引擎异常" value={items.length} tone={items.length > 0 ? "negative" : "positive"} />
        <StatCard
          label="数据库挂单 / 引擎挂单"
          value={overview.available ? `${overview.data.openOrderCount ?? 0} / ${(overview.data.engineBidCount ?? 0) + (overview.data.engineAskCount ?? 0)}` : "--"}
          hint={overview.available ? `买 ${overview.data.engineBidCount ?? 0} · 卖 ${overview.data.engineAskCount ?? 0}` : overview.error}
        />
      </div>
      {items.length > 0 ? (
        <ul className="alert-list small">
          {items.slice(0, 5).map((item, index) => (
            <li key={`${item.orderId ?? index}:${item.type}`}><span><code>{item.type}</code> {item.orderId ? shortHash(item.orderId, 8, 4) : ""}</span></li>
          ))}
          {items.length > 5 ? <li><span className="muted">另有 {items.length - 5} 条…</span></li> : null}
        </ul>
      ) : null}
    </>
  );
}

function LabGuide(props: { expected: string; where: string; recover: string }) {
  return (
    <dl className="lab-guide">
      <div><dt>预期现象</dt><dd>{props.expected}</dd></div>
      <div><dt>观察位置</dt><dd>{props.where}</dd></div>
      <div><dt>恢复方式</dt><dd>{props.recover}</dd></div>
    </dl>
  );
}

function SectionBody<T>(props: { section: Section<T> | undefined; children: (data: T) => ReactNode }) {
  if (!props.section) {
    return <p className="muted small">加载中…</p>;
  }
  if (!props.section.available) {
    return <p className="small"><Badge tone="negative">不可用</Badge> {props.section.error}</p>;
  }
  return <>{props.children(props.section.data)}</>;
}

function SectionBadge(props: { section: Section<unknown> | undefined; active: boolean }) {
  if (!props.section) {
    return null;
  }
  if (!props.section.available) {
    return <Badge tone="neutral">服务不可达</Badge>;
  }
  return props.active ? <Badge tone="negative">故障中</Badge> : <Badge tone="positive">正常</Badge>;
}

function Countdown(props: { until: string | undefined }) {
  if (!props.until) {
    return <span>--</span>;
  }
  const seconds = Math.max(Math.round((Date.parse(props.until) - Date.now()) / 1000), 0);
  return <span className="nowrap">{seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`}</span>;
}
