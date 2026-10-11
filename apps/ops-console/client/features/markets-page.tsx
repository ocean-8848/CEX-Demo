import { useState } from "react";

import { Badge, Button, Panel } from "@web3-cex/web-ui";

import type { ManagedMarket, MarketsReport } from "../lib/types.js";
import { ConfirmDialog, PageHeader, QueryView, RefreshButton, StatusBadge, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

function percent(rate: string): string {
  const value = Number(rate) * 100;
  return Number.isFinite(value) ? `${Number(value.toFixed(4))}%` : rate;
}

/**
 * 市场管理: markets are defined in config/markets.json (the default status);
 * ops can halt / resume a market at runtime. risk-service stores the override
 * and rejects new orders on a halted market with MARKET_HALTED; cancels still work.
 */
export function MarketsPage() {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const query = useOpsQuery<MarketsReport>("/markets", { refreshMs: 10_000 });
  const [target, setTarget] = useState<{ market: ManagedMarket; next: "halted" | "listed" } | null>(null);
  const canManage = can("ops.markets.manage");

  const apply = async (reason: string) => {
    if (!target) {
      return;
    }
    const result = await run(
      "market-status",
      {
        path: `/markets/${encodeURIComponent(target.market.market)}/status`,
        body: { status: target.next, reason: reason || undefined }
      },
      { success: target.next === "halted" ? `${target.market.market} 已暂停交易` : `${target.market.market} 已恢复交易` }
    );
    if (result) {
      setTarget(null);
      query.reload();
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="市场管理"
        subtitle="市场与币种定义来自 config/markets.json；暂停 / 恢复是运行时覆盖，由 risk-service 持久化并在下单前校验"
        actions={<RefreshButton onClick={query.reload} loading={query.loading} updatedAt={query.updatedAt} />}
      />
      {query.data?.statusSource === "config" ? (
        <div className="form-error" id="markets-status-fallback">
          risk-service 不可用，下表显示的是配置文件中的默认状态：{query.data.statusError ?? "unknown error"}
        </div>
      ) : null}
      <Panel flush title="现货市场" id="markets-panel">
        <QueryView state={query} empty={(data) => data.markets.length === 0} emptyTitle="config/markets.json 中没有市场">
          {(data) => (
            <div className="table-scroll">
              <table className="data-table" id="markets-table">
                <thead>
                  <tr>
                    <th>市场</th>
                    <th>当前状态</th>
                    <th>配置默认</th>
                    <th className="num">价格 / 数量步长</th>
                    <th className="num">最小数量</th>
                    <th className="num">Maker / Taker</th>
                    <th className="num">参考价 / 偏离上限</th>
                    <th>运行时覆盖</th>
                    {canManage ? <th className="num">操作</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.markets.map((item) => (
                    <tr key={item.market} id={`market-row-${item.market}`}>
                      <td>
                        <b>{item.market.replace("-", "/")}</b>
                        {item.market === data.defaultMarket ? <Badge tone="neutral">默认</Badge> : null}
                        {item.simulatorEnabled ? <span className="muted small"> · 模拟做市</span> : null}
                      </td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                      <td>
                        <StatusBadge status={item.configuredStatus} />
                      </td>
                      <td className="num">
                        {item.priceStep} / {item.quantityStep}
                      </td>
                      <td className="num">
                        {item.minQuantity} {item.baseAsset}
                      </td>
                      <td className="num">
                        {percent(item.makerFeeRate)} / {percent(item.takerFeeRate)}
                      </td>
                      <td className="num">
                        {item.referencePrice} {item.quoteAsset} / ±{percent(item.maxPriceDeviationRatio)}
                      </td>
                      <td>
                        {item.override ? (
                          <span className="small">
                            {item.override.reason ? `${item.override.reason} · ` : ""}
                            {item.override.updatedBy} · <Time value={item.override.updatedAt} />
                          </span>
                        ) : (
                          <span className="muted small">无（使用配置）</span>
                        )}
                      </td>
                      {canManage ? (
                        <td className="num actions">
                          {item.configuredStatus === "delisted" ? (
                            <span className="muted small">已下架（仅可改配置）</span>
                          ) : item.status === "halted" ? (
                            <Button
                              size="sm"
                              variant="primary"
                              id={`resume-${item.market}`}
                              disabled={data.statusSource !== "risk-service"}
                              onClick={() => setTarget({ market: item, next: "listed" })}
                            >
                              恢复交易
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="sell"
                              id={`halt-${item.market}`}
                              disabled={data.statusSource !== "risk-service"}
                              onClick={() => setTarget({ market: item, next: "halted" })}
                            >
                              暂停交易
                            </Button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </Panel>
      <Panel title="怎么用">
        <ul className="small muted">
          <li>暂停后 risk-service 拒绝该市场所有新委托（错误码 MARKET_HALTED），用户仍可撤销已有挂单，撮合引擎里的挂单保持不动。</li>
          <li>恢复交易会删除运行时覆盖，市场回到 config/markets.json 中的默认状态。</li>
          <li>新增 / 下架市场、改步长或费率：编辑 config/markets.json 后重启服务（不需要改代码）。</li>
        </ul>
      </Panel>
      <ConfirmDialog
        open={Boolean(target)}
        title={target?.next === "halted" ? `暂停 ${target?.market.market} 交易` : `恢复 ${target?.market.market} 交易`}
        description={
          target?.next === "halted"
            ? "暂停后所有新委托都会被风控拒绝（撤单不受影响）。操作会写入操作审计。"
            : "恢复后市场回到配置文件中的默认状态。操作会写入操作审计。"
        }
        confirmLabel={target?.next === "halted" ? "确认暂停" : "确认恢复"}
        danger={target?.next === "halted"}
        noteLabel={target?.next === "halted" ? "暂停原因" : "备注"}
        noteRequired={target?.next === "halted"}
        busy={busy === "market-status"}
        onConfirm={(note) => void apply(note)}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
