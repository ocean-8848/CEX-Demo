import { useState } from "react";

import { Badge, Button, Empty, Panel, formatAmount, href, type Tone } from "@web3-cex/web-ui";

import { itemsOf, qs, totalOf } from "../lib/api.js";
import type {
  SurveillanceAlert,
  SurveillanceAlertDetail,
  SurveillanceAlertStatus,
  SurveillanceAlertType,
  SurveillanceOverview
} from "../lib/fees-surveillance-types.js";
import {
  ConfirmDialog,
  Drawer,
  IdLink,
  KeyValue,
  PageHeader,
  Pager,
  QueryView,
  RefreshButton,
  StatCard,
  Time
} from "../components/kit.js";
import { MarketOptions } from "../components/market-options.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

const PAGE_SIZE = 20;

export const ALERT_TYPE_LABEL: Record<SurveillanceAlertType, string> = {
  wash_trade: "对敲 / 自成交",
  concentrated_volume: "成交集中",
  spoofing: "幌骗（挂撤单）",
  price_move: "价格异动"
};

const ALERT_TYPE_HINT: Record<SurveillanceAlertType, string> = {
  wash_trade: "同一用户同时是买方和卖方：成交量是“刷”出来的",
  concentrated_volume: "单一账户占市场成交参与度过高，可能在操纵成交量或价格",
  spoofing: "反复挂出大额委托又在成交前快速撤单，制造虚假深度",
  price_move: "短时间内价格高低差超过阈值（市场级，不针对账户）"
};

const STATUS_LABEL: Record<SurveillanceAlertStatus, string> = {
  open: "待处理",
  acknowledged: "已确认",
  dismissed: "已忽略"
};

const STATUS_TONE: Record<SurveillanceAlertStatus, Tone> = {
  open: "negative",
  acknowledged: "warning",
  dismissed: "neutral"
};

const SEVERITY: Record<SurveillanceAlert["severity"], { label: string; tone: Tone }> = {
  high: { label: "高", tone: "negative" },
  medium: { label: "中", tone: "warning" },
  low: { label: "低", tone: "neutral" }
};

const STATUS_ACTIONS: Record<SurveillanceAlertStatus, Array<{ status: SurveillanceAlertStatus; label: string }>> = {
  open: [
    { status: "acknowledged", label: "确认（跟进中）" },
    { status: "dismissed", label: "忽略" }
  ],
  acknowledged: [
    { status: "dismissed", label: "忽略" },
    { status: "open", label: "重新打开" }
  ],
  dismissed: [{ status: "open", label: "重新打开" }]
};

/**
 * 市场监控: risk-service scans order-service trades / cancelled orders
 * every minute and keeps one alert per finding. Demo market makers are
 * labelled 「做市商」 and excluded from alerts by default.
 */
export function SurveillancePage(props: { initialAlertId?: string }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [type, setType] = useState("");
  const [status, setStatus] = useState("open");
  const [market, setMarket] = useState("");
  const [userId, setUserId] = useState("");
  const [includeMakers, setIncludeMakers] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(props.initialAlertId);
  const overview = useOpsQuery<SurveillanceOverview>("/surveillance/overview", { refreshMs: 30_000 });
  const alerts = useOpsQuery<{ items: SurveillanceAlert[]; total: number }>(
    `/surveillance/alerts${qs({
      type,
      status,
      market,
      userId,
      includeMarketMakers: includeMakers ? "true" : undefined,
      limit: PAGE_SIZE,
      offset
    })}`,
    { refreshMs: 30_000 }
  );
  const rows = itemsOf<SurveillanceAlert>(alerts.data);
  const makerLabels = new Map((overview.data?.marketMakers ?? []).map((maker) => [maker.userId, maker.label]));

  const scan = async () => {
    const result = await run<{ created: number; detected: number; error?: string }>(
      "scan",
      { path: "/surveillance/scan" },
      { success: "扫描完成", detail: (value) => (value.error ? `扫描失败：${value.error}` : `命中 ${value.detected} 条，新增 ${value.created} 条告警`) }
    );
    if (result) {
      overview.reload();
      alerts.reload();
    }
  };

  const lastScan = overview.data?.lastScan;
  return (
    <div className="page">
      <PageHeader
        title="市场监控"
        subtitle="risk-service 定时扫描 order-service 的成交与撤单，识别对敲、成交集中、幌骗与价格异动；做市商账户只标注不告警"
        actions={
          <>
            <RefreshButton
              onClick={() => {
                overview.reload();
                alerts.reload();
              }}
              loading={alerts.loading}
              updatedAt={alerts.updatedAt}
            />
            {can("ops.markets.manage") ? (
              <Button size="sm" variant="primary" loading={busy === "scan"} onClick={() => void scan()} id="surveillance-scan">
                立即扫描
              </Button>
            ) : null}
          </>
        }
      />

      <div className="stat-grid" id="surveillance-stats">
        {(Object.keys(ALERT_TYPE_LABEL) as SurveillanceAlertType[]).map((key) => (
          <StatCard
            key={key}
            label={`待处理 · ${ALERT_TYPE_LABEL[key]}`}
            value={overview.data?.openByType?.[key] ?? "--"}
            tone={(overview.data?.openByType?.[key] ?? 0) > 0 ? "negative" : "neutral"}
            hint={ALERT_TYPE_HINT[key]}
          />
        ))}
      </div>
      {lastScan ? (
        <p className="muted small" id="surveillance-last-scan">
          最近扫描 <Time value={lastScan.scannedAt} />（{lastScan.trigger === "manual" ? "手动" : "定时"}）：窗口{" "}
          <Time value={lastScan.since} /> ~ <Time value={lastScan.until} />，{lastScan.tradeCount} 笔成交、{lastScan.cancelledOrderCount} 笔大额快撤单，
          命中 {lastScan.detected}、新增 {lastScan.created}
          {lastScan.truncated ? "（数据量超过上限，窗口被截断）" : ""}
          {lastScan.error ? <span className="form-error"> 扫描失败：{lastScan.error}</span> : null}
        </p>
      ) : (
        <p className="muted small">risk-service 启动后约 10 秒完成首次扫描，之后每分钟一次。</p>
      )}

      <Panel
        flush
        id="surveillance-alerts"
        title={
          <div className="filters">
            <select value={type} onChange={(event) => { setType(event.target.value); setOffset(0); }} aria-label="类型" id="surveillance-type">
              <option value="">全部类型</option>
              {(Object.keys(ALERT_TYPE_LABEL) as SurveillanceAlertType[]).map((key) => (
                <option key={key} value={key}>
                  {ALERT_TYPE_LABEL[key]}
                </option>
              ))}
            </select>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="状态" id="surveillance-status">
              <option value="">全部状态</option>
              {(Object.keys(STATUS_LABEL) as SurveillanceAlertStatus[]).map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABEL[key]}
                </option>
              ))}
            </select>
            <select value={market} onChange={(event) => { setMarket(event.target.value); setOffset(0); }} aria-label="市场">
              <option value="">全部市场</option>
              <MarketOptions />
            </select>
            <input className="filter-input" placeholder="按 userId 过滤" value={userId} onChange={(event) => { setUserId(event.target.value.trim()); setOffset(0); }} />
            <label className="small">
              <input type="checkbox" checked={includeMakers} onChange={(event) => { setIncludeMakers(event.target.checked); setOffset(0); }} /> 显示做市商
            </label>
          </div>
        }
      >
        <QueryView state={alerts} empty={(data) => itemsOf(data).length === 0} emptyTitle="没有符合条件的告警" emptyHint="可以在交易前台自买自卖或反复挂撤大单来触发（见用户手册）">
          {() => (
            <div className="table-scroll">
              <table className="data-table" id="surveillance-table">
                <thead>
                  <tr>
                    <th>最近命中</th>
                    <th>类型</th>
                    <th>市场</th>
                    <th>账户</th>
                    <th>级别</th>
                    <th>摘要</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((alert) => (
                    <tr key={alert.alertId} className="clickable-row" data-alert-id={alert.alertId} onClick={() => setSelected(alert.alertId)}>
                      <td><Time value={alert.lastDetectedAt} /></td>
                      <td>{ALERT_TYPE_LABEL[alert.type] ?? alert.type}</td>
                      <td>{alert.market.replace("-", "/")}</td>
                      <td>
                        {alert.userId ? <IdLink id={alert.userId} kind="userId" /> : <span className="muted">市场级</span>}
                        {alert.marketMaker || alert.userLabel ? <Badge tone="info">{alert.userLabel ?? "做市商"}</Badge> : null}
                      </td>
                      <td><Badge tone={SEVERITY[alert.severity].tone}>{SEVERITY[alert.severity].label}</Badge></td>
                      <td className="small">{alert.summary}</td>
                      <td><Badge tone={STATUS_TONE[alert.status]}>{STATUS_LABEL[alert.status]}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
        <Pager offset={offset} limit={PAGE_SIZE} total={totalOf(alerts.data)} count={rows.length} onChange={setOffset} />
      </Panel>

      <Panel title="成交参与度（最近扫描窗口）" id="surveillance-participation">
        {(overview.data?.participation ?? []).length === 0 ? (
          <Empty title="窗口内没有成交" />
        ) : (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>市场</th>
                  <th className="num">成交笔数 / 成交额</th>
                  <th>参与度最高的账户（买卖双边合计 / 全部双边）</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.participation ?? []).map((item) => (
                  <tr key={item.market}>
                    <td>{item.market.replace("-", "/")}</td>
                    <td className="num">
                      {item.tradeCount} / {formatAmount(item.volume, 2)}
                    </td>
                    <td className="small">
                      {item.topAccounts.map((account) => (
                        <span key={account.userId} className="participant">
                          {account.marketMaker ? <Badge tone="info">{account.label ?? "做市商"}</Badge> : <IdLink id={account.userId} kind="userId" />}{" "}
                          {(account.share * 100).toFixed(1)}%{"  "}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          做市商账户来自 config/fee-tiers.json 的 marketMakers（
          {(overview.data?.marketMakers ?? []).map((maker) => maker.label).join("、") || "无"}
          ）：它们持续双边挂单、互相成交是正常业务，所以默认不参与告警，只在这里和证据中标注「做市商」。
        </p>
      </Panel>

      {overview.data ? (
        <Panel title="检测阈值（RISK_SURVEILLANCE_* 环境变量）">
          <KeyValue
            items={[
              ["扫描窗口", `${Math.round(Number(overview.data.thresholds.lookbackMs) / 60_000)} 分钟`],
              ["对敲", `同一用户自成交 ≥ ${overview.data.thresholds.washMinTrades} 笔`],
              [
                "成交集中",
                `单账户参与度 > ${(Number(overview.data.thresholds.concentrationRatio) * 100).toFixed(0)}%（近 ${Math.round(Number(overview.data.thresholds.concentrationWindowMs) / 60_000)} 分钟，市场成交额 ≥ ${overview.data.thresholds.concentrationMinVolume}、≥ ${overview.data.thresholds.concentrationMinTrades} 笔）`
              ],
              [
                "幌骗",
                `名义金额 ≥ ${overview.data.thresholds.spoofMinNotional} 的委托在 ${Math.round(Number(overview.data.thresholds.spoofMaxLifetimeMs) / 1000)} 秒内撤单且未成交，${Math.round(Number(overview.data.thresholds.spoofWindowMs) / 60_000)} 分钟内 ≥ ${overview.data.thresholds.spoofMinOrders} 笔`
              ],
              [
                "价格异动",
                `${Math.round(Number(overview.data.thresholds.priceMoveWindowMs) / 60_000)} 分钟内高低差 > ${(Number(overview.data.thresholds.priceMoveRatio) * 100).toFixed(1)}%`
              ],
              ["做市商", overview.data.thresholds.includeMarketMakers ? "参与告警（低级别）" : "只标注不告警"]
            ]}
          />
        </Panel>
      ) : null}

      <AlertDrawer
        alertId={selected}
        makerLabels={makerLabels}
        onClose={() => setSelected(undefined)}
        onChanged={() => {
          overview.reload();
          alerts.reload();
        }}
      />
    </div>
  );
}

function AlertDrawer(props: {
  alertId: string | undefined;
  makerLabels: Map<string, string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const detail = useOpsQuery<SurveillanceAlertDetail>(props.alertId ? `/surveillance/alerts/${encodeURIComponent(props.alertId)}` : null);
  const [target, setTarget] = useState<SurveillanceAlertStatus | null>(null);
  const data = detail.data;

  const userCell = (userId: string) => {
    const label = props.makerLabels.get(userId);
    return (
      <>
        <IdLink id={userId} kind="userId" />
        {label ? <Badge tone="info">{label}</Badge> : null}
      </>
    );
  };

  const apply = async (note: string) => {
    if (!props.alertId || !target) {
      return;
    }
    const result = await run(
      "alert-status",
      { path: `/surveillance/alerts/${encodeURIComponent(props.alertId)}/status`, body: { status: target, note } },
      { success: `告警已标记为${STATUS_LABEL[target]}` }
    );
    if (result) {
      setTarget(null);
      detail.reload();
      props.onChanged();
    }
  };

  const traceHref = data
    ? data.userId
      ? href(`/trace?userId=${encodeURIComponent(data.userId)}`)
      : data.evidence.tradeIds[0]
        ? href(`/trace?tradeId=${encodeURIComponent(data.evidence.tradeIds[0])}`)
        : undefined
    : undefined;

  return (
    <Drawer open={Boolean(props.alertId)} title="告警详情" onClose={props.onClose} width={680}>
      {data ? (
        <div className="drawer-stack" id="surveillance-alert-detail">
          <div className="drawer-hero">
            <div>
              <strong>{ALERT_TYPE_LABEL[data.type]}</strong> · {data.market.replace("-", "/")}
              <div className="muted small">{data.summary}</div>
            </div>
            <Badge tone={STATUS_TONE[data.status]}>{STATUS_LABEL[data.status]}</Badge>
          </div>
          {can("ops.markets.manage") ? (
            <div className="drawer-actions">
              {STATUS_ACTIONS[data.status].map((action) => (
                <Button
                  key={action.status}
                  size="sm"
                  variant={action.status === "dismissed" ? "ghost" : "primary"}
                  onClick={() => setTarget(action.status)}
                  id={`alert-${action.status}`}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
          <KeyValue
            items={[
              ["账户", data.userId ? userCell(data.userId) : "市场级"],
              ["级别", <Badge tone={SEVERITY[data.severity].tone}>{SEVERITY[data.severity].label}</Badge>],
              ["证据窗口", <span><Time value={data.windowStart} /> ~ <Time value={data.windowEnd} /></span>],
              ["首次 / 最近命中", <span><Time value={data.firstDetectedAt} /> / <Time value={data.lastDetectedAt} /></span>],
              ...Object.entries(data.metrics).map(([key, value]) => [key, String(value)] as [string, string]),
              ...(data.statusNote ? [["处理备注", `${data.statusNote} · ${data.statusUpdatedBy ?? ""}`] as [string, string]] : [])
            ]}
          />
          {data.evidence.trades.length > 0 ? (
            <section>
              <h4>证据：成交（{data.evidence.tradeIds.length} 笔{data.evidence.tradeIds.length > data.evidence.trades.length ? `，显示前 ${data.evidence.trades.length}` : ""}）</h4>
              <table className="data-table compact" id="surveillance-evidence-trades">
                <thead>
                  <tr><th>tradeId</th><th className="num">价格 × 数量</th><th>买方</th><th>卖方</th><th>时间</th></tr>
                </thead>
                <tbody>
                  {data.evidence.trades.map((trade) => (
                    <tr key={trade.tradeId}>
                      <td><IdLink id={trade.tradeId} kind="tradeId" /></td>
                      <td className="num">{formatAmount(trade.price, 2)} × {formatAmount(trade.quantity)}</td>
                      <td>{userCell(trade.buyerUserId)}</td>
                      <td>{userCell(trade.sellerUserId)}</td>
                      <td><Time value={trade.executedAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          {data.evidence.orders.length > 0 ? (
            <section>
              <h4>证据：撤单（{data.evidence.orderIds.length} 笔）</h4>
              <table className="data-table compact" id="surveillance-evidence-orders">
                <thead>
                  <tr><th>orderId</th><th>方向</th><th className="num">价格 × 数量</th><th className="num">存活</th><th>撤单时间</th></tr>
                </thead>
                <tbody>
                  {data.evidence.orders.map((order) => (
                    <tr key={order.orderId}>
                      <td><IdLink id={order.orderId} kind="orderId" /></td>
                      <td className={order.side === "sell" ? "down" : "up"}>{order.side === "sell" ? "卖" : "买"}</td>
                      <td className="num">{formatAmount(order.price, 2)} × {formatAmount(order.quantity)}</td>
                      <td className="num">{(order.lifetimeMs / 1000).toFixed(1)} 秒</td>
                      <td><Time value={order.cancelledAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          <section>
            <h4>处理记录</h4>
            <ol className="timeline">
              {data.events.map((event) => (
                <li key={event.eventId}>
                  <div className="timeline-head">
                    <strong>
                      {event.action === "detected" ? "检测命中" : `${event.fromStatus ? STATUS_LABEL[event.fromStatus] : ""} → ${STATUS_LABEL[event.toStatus]}`}
                    </strong>
                    <Time value={event.createdAt} />
                  </div>
                  <span className="muted small">
                    {event.actor}
                    {event.note ? ` · ${event.note}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {traceHref ? (
            <div className="drawer-links">
              <a href={traceHref} id="surveillance-trace-link">在业务追踪中查看 →</a>
            </div>
          ) : null}
        </div>
      ) : (
        <span className="muted">{detail.error ?? "加载中…"}</span>
      )}
      <ConfirmDialog
        open={target !== null}
        title={target ? `标记为${STATUS_LABEL[target]}` : ""}
        description="处理结果和备注会写入告警处理记录（risk-service）与操作审计（ops-console）。"
        confirmLabel="确认"
        danger={target === "dismissed"}
        noteLabel="处理备注"
        noteRequired
        busy={busy === "alert-status"}
        onConfirm={(note) => void apply(note)}
        onClose={() => setTarget(null)}
      />
    </Drawer>
  );
}
