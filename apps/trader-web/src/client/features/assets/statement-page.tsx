import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Empty, formatAmount, formatDateTime, Panel, shortHash } from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { href, navigate } from "../../lib/router.js";
import {
  buildStatementQuery,
  formatSignedAmount,
  STATEMENT_CATEGORY_LABELS,
  statementRowsToCsv,
  toStatementRow,
  type StatementCategoryFilter,
  type StatementPage as StatementPageData,
  type StatementRow
} from "../../lib/statement.js";
import { useExchange } from "../../state/store.js";
import { TradeJournalModal } from "../trade/trade-journal-modal.js";

const PAGE_SIZE = 20;
const EXPORT_PAGE_SIZE = 200;
const EXPORT_MAX_ROWS = 10_000;

interface Filters {
  assetCode: string;
  category: "" | StatementCategoryFilter;
  includeLockEvents: boolean;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { assetCode: "", category: "", includeLockEvents: true, from: "", to: "" };

/** 资金流水: ledger entries + freeze / release events of the caller's spot account. */
export function StatementPage() {
  const { state, api, actions } = useExchange();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<StatementPageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [journalTradeId, setJournalTradeId] = useState<string | null>(null);

  const assetCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const market of state.config?.markets ?? []) {
      codes.add(market.quoteAsset);
      codes.add(market.baseAsset);
    }
    for (const balance of state.balances) {
      if (balance.assetCode) {
        codes.add(balance.assetCode);
      }
    }
    return [...codes].sort();
  }, [state.config, state.balances]);

  const fetchPage = useCallback(
    async (pageOffset: number, limit: number) => {
      if (!api) {
        throw new Error("应用尚未完成初始化");
      }
      const query = buildStatementQuery({
        assetCode: filters.assetCode || undefined,
        category: filters.category || undefined,
        includeLockEvents: filters.includeLockEvents,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit,
        offset: pageOffset
      });
      return api.gateway<StatementPageData>(`/ledger/entries?${query}`, { token: state.token });
    },
    [api, state.token, filters]
  );

  useEffect(() => {
    if (!state.token || !api) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(offset, PAGE_SIZE)
      .then((page) => {
        if (!cancelled) {
          setData(page);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(readErrorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, offset, state.token, api]);

  const rows = useMemo(() => (data?.items ?? []).map(toStatementRow), [data]);
  const hiddenBalances = Object.entries(data?.balanceDerivable ?? {})
    .filter(([, derivable]) => !derivable)
    .map(([asset]) => asset);

  const update = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  // Exports every row of the current filter (not just the visible page).
  async function exportCsv() {
    setExporting(true);
    try {
      const all: StatementRow[] = [];
      let pageOffset = 0;
      for (;;) {
        const page = await fetchPage(pageOffset, EXPORT_PAGE_SIZE);
        all.push(...page.items.map(toStatementRow));
        pageOffset += page.items.length;
        if (page.items.length === 0 || pageOffset >= page.total || all.length >= EXPORT_MAX_ROWS) {
          break;
        }
      }
      const blob = new Blob([statementRowsToCsv(all)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `statement-${filters.assetCode || "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      actions.toast("positive", "对账单已导出", `${all.length} 条流水`);
    } catch (cause) {
      actions.toast("negative", "导出失败", readErrorMessage(cause));
    } finally {
      setExporting(false);
    }
  }

  if (!state.token) {
    return (
      <div className="page narrow">
        <Empty
          icon="🔒"
          title="登录后查看资金流水"
          action={
            <Button variant="primary" onClick={() => navigate("/login?redirect=/assets/ledger")}>
              登录 / 注册
            </Button>
          }
        />
      </div>
    );
  }

  const total = data?.total ?? 0;
  const pageIndex = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <div className="page statement-page">
      <div className="page-head">
        <div>
          <h1>资金流水</h1>
          <p className="muted">
            每一行都来自 ledger-service 的双分录账本：分录记录资金进出，冻结 / 解冻只在可用与冻结之间移动
          </p>
        </div>
        <div className="button-row">
          <Button variant="ghost" size="sm" onClick={() => navigate("/assets")}>
            ← 资产总览
          </Button>
          <Button size="sm" onClick={() => void exportCsv()} loading={exporting} disabled={total === 0} id="statement-export">
            导出 CSV
          </Button>
        </div>
      </div>

      <Panel
        flush
        title="账户流水"
        actions={
          <div className="filters statement-filters" id="statement-filters">
            <select value={filters.assetCode} onChange={(event) => update({ assetCode: event.target.value })} aria-label="币种筛选">
              <option value="">全部币种</option>
              {assetCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <select
              value={filters.category}
              onChange={(event) => update({ category: event.target.value as Filters["category"] })}
              aria-label="类型筛选"
              id="statement-category"
            >
              <option value="">全部类型</option>
              {(Object.keys(STATEMENT_CATEGORY_LABELS) as StatementCategoryFilter[]).map((key) => (
                <option key={key} value={key}>
                  {STATEMENT_CATEGORY_LABELS[key]}
                </option>
              ))}
            </select>
            <input type="date" value={filters.from} onChange={(event) => update({ from: event.target.value })} aria-label="开始日期" />
            <span className="muted">至</span>
            <input type="date" value={filters.to} onChange={(event) => update({ to: event.target.value })} aria-label="结束日期" />
            <label className="statement-toggle">
              <input
                type="checkbox"
                checked={filters.includeLockEvents}
                onChange={(event) => update({ includeLockEvents: event.target.checked })}
              />
              显示冻结 / 解冻
            </label>
          </div>
        }
      >
        {hiddenBalances.length > 0 ? (
          <div className="statement-note">
            {hiddenBalances.join("、")} 的历史流水无法完整还原当前余额（存在账本分录之外写入的历史数据），已隐藏「变动后余额」。
          </div>
        ) : null}
        {error ? <div className="form-error statement-note">{error}</div> : null}
        {rows.length === 0 && !loading && !error ? (
          <Empty icon="≡" title="暂无流水" hint="充值、下单、成交和提现都会在这里留下账本记录。" />
        ) : (
          <div className="table-scroll">
            <table className="data-table statement-table" id="statement-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>币种</th>
                  <th className="num">变动</th>
                  <th className="num">手续费</th>
                  <th className="num" title="变动后的总额（可用 + 冻结）">变动后余额</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-line-id={row.id}>
                    <td className="muted">{formatDateTime(row.occurredAt)}</td>
                    <td>
                      <span className="statement-type">{row.typeLabel}</span>
                      <Badge tone="neutral">{row.categoryLabel}</Badge>
                    </td>
                    <td>{row.assetCode}</td>
                    <td
                      className={`num ${row.amountScope === "available" ? "muted" : row.amount.startsWith("-") ? "down" : "up"}`}
                      title={row.amountScope === "available" ? "仅在可用与冻结之间移动，总额不变" : "总额变动"}
                    >
                      {formatSignedAmount(row.amount)}
                      {row.amountScope === "available" ? <small> 可用</small> : null}
                    </td>
                    <td className="num muted">
                      {row.feeAmount ? `${formatAmount(row.feeAmount, 8)} ${row.feeAssetCode ?? ""}` : "--"}
                    </td>
                    <td
                      className="num"
                      title={
                        row.balanceAfter
                          ? `可用 ${row.balanceAfter.available} · 冻结 ${row.balanceAfter.locked}`
                          : "无法由历史流水还原"
                      }
                    >
                      {row.balanceAfter ? formatAmount(row.balanceAfter.total, 8) : "--"}
                      {row.balanceAfter && row.balanceAfter.locked !== "0" ? (
                        <small className="muted"> (冻结 {formatAmount(row.balanceAfter.locked, 8)})</small>
                      ) : null}
                    </td>
                    <td>
                      {row.link ? (
                        <a href={href(row.link)} title={row.sourceId}>
                          {row.sourceLabel} <code>{shortHash(row.sourceId, 8, 4)}</code>
                        </a>
                      ) : (
                        <span className="muted" title={row.sourceId}>
                          {row.sourceLabel}
                        </span>
                      )}
                      {row.tradeId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="查看这笔成交的账本分录（T 型账户）"
                          onClick={() => setJournalTradeId(row.tradeId ?? null)}
                        >
                          T 型账户
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="statement-pager">
          <span className="muted" id="statement-total">
            共 {total} 条 · 第 {pageIndex}/{pageCount} 页
          </span>
          <Button size="sm" variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}>
            上一页
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
          </Button>
        </div>
      </Panel>
      <TradeJournalModal tradeId={journalTradeId} onClose={() => setJournalTradeId(null)} />
    </div>
  );
}
