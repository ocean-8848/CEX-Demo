import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  formatAmount,
  formatDateTime,
  marketLabel,
  Modal,
  Spinner
} from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import {
  buildTAccounts,
  verifyJournalBalance,
  type TAccount,
  type TradeJournalView
} from "../../lib/journals.js";
import { useExchange } from "../../state/store.js";

const ROLE_CLASS: Record<TAccount["accountRole"], string> = {
  self: "is-self",
  counterparty: "is-counterparty",
  platform_settlement: "is-platform",
  platform_fee: "is-fee",
  platform: "is-platform",
  unknown: "is-platform"
};

// M3-3: every ledger journal a trade produced, laid out as T-accounts
// (借 debit on the left, 贷 credit on the right) with a per-asset balance check.
export function TradeJournalModal(props: { tradeId: string | null; onClose: () => void }) {
  const { actions } = useExchange();
  const [view, setView] = useState<TradeJournalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!props.tradeId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setView(await actions.loadTradeJournals(props.tradeId));
    } catch (loadError) {
      setError(readErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [actions, props.tradeId]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  const tAccounts = useMemo(() => (view ? buildTAccounts(view.journals) : []), [view]);
  const checks = useMemo(() => (view ? verifyJournalBalance(view.journals) : []), [view]);
  const balanced = checks.length > 0 && checks.every((check) => check.balanced);

  return (
    <Modal open={Boolean(props.tradeId)} title="成交分录 · T 型账户" onClose={props.onClose} width={860}>
      <div className="journal-modal" id="trade-journal-modal">
        {loading && !view ? (
          <div className="journal-loading">
            <Spinner /> 正在读取账本分录…
          </div>
        ) : error ? (
          <Empty
            icon="⚠"
            title="分录读取失败"
            hint={error}
            action={
              <Button size="sm" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        ) : view ? (
          <>
            <div className="journal-summary">
              <div>
                <strong>
                  {view.viewerSide === "sell" ? "卖出" : view.viewerSide === "both" ? "自成交" : "买入"}{" "}
                  {formatAmount(view.quantity)} {marketLabel(view.market)} @ {formatAmount(view.price, 2)}
                </strong>
                <span className="muted">
                  {formatDateTime(view.executedAt)} · {view.viewerLiquidity === "maker" ? "Maker 挂单方" : view.viewerLiquidity === "taker" ? "Taker 吃单方" : "Maker + Taker"}
                </span>
              </div>
              {view.journals.length === 0 ? (
                <Badge tone="warning">结算中</Badge>
              ) : (
                <Badge tone={balanced && view.balanced ? "positive" : "negative"}>
                  {balanced && view.balanced ? "✓ 借贷平衡" : "✗ 借贷不平衡"}
                </Badge>
              )}
            </div>

            {view.journals.length === 0 ? (
              <Empty
                icon="⏳"
                title="这笔成交还没有入账"
                hint="异步结算模式下 settlement-service 稍后才会写分录，可以稍后刷新。"
                action={
                  <Button size="sm" loading={loading} onClick={() => void load()}>
                    刷新
                  </Button>
                }
              />
            ) : (
              <>
                <p className="journal-hint muted">
                  本账本以「平台对用户的负债」记账：用户账户<b>贷方</b>表示余额增加，<b>借方</b>表示余额减少。
                  每笔分录同一币种的借方合计必须等于贷方合计。对手方只显示角色，不展示其账户信息。
                </p>

                <div className="t-accounts">
                  {tAccounts.map((account) => (
                    <TAccountCard key={account.key} account={account} />
                  ))}
                </div>

                <h4 className="journal-section-title">分录明细（按结算顺序）</h4>
                <ol className="journal-list">
                  {view.journals.map((journal, index) => (
                    <li key={journal.journalId} className="journal-item">
                      <div className="journal-item-head">
                        <span className="journal-step">{index + 1}</span>
                        <strong>{journal.stageLabel}</strong>
                        <Badge tone={journal.balanced ? "positive" : "negative"}>
                          {journal.balanced ? "平衡" : "不平衡"}
                        </Badge>
                      </div>
                      <table className="data-table journal-table">
                        <thead>
                          <tr>
                            <th>账户</th>
                            <th>币种</th>
                            <th className="num">借（Debit）</th>
                            <th className="num">贷（Credit）</th>
                          </tr>
                        </thead>
                        <tbody>
                          {journal.entries.map((entry, entryIndex) => (
                            <tr key={entryIndex} className={ROLE_CLASS[entry.accountRole]}>
                              <td>
                                {entry.accountLabel}
                                {entry.referenceType === "spot_trade_fee" ? <span className="muted"> · 手续费</span> : null}
                              </td>
                              <td>{entry.assetCode}</td>
                              <td className="num">{entry.direction === "debit" ? formatAmount(entry.amount, 8) : ""}</td>
                              <td className="num">{entry.direction === "credit" ? formatAmount(entry.amount, 8) : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          {journal.totals.map((total) => (
                            <tr key={total.assetCode}>
                              <td>合计</td>
                              <td>{total.assetCode}</td>
                              <td className="num">{formatAmount(total.debitTotal, 8)}</td>
                              <td className="num">{formatAmount(total.creditTotal, 8)}</td>
                            </tr>
                          ))}
                        </tfoot>
                      </table>
                    </li>
                  ))}
                </ol>

                <div className="journal-check" id="journal-balance-check">
                  {checks.map((check) => (
                    <div key={check.assetCode} className={check.balanced ? "ok" : "bad"}>
                      <b>{check.assetCode}</b>
                      <span>借方合计 {formatAmount(check.debitTotal, 8)}</span>
                      <span>贷方合计 {formatAmount(check.creditTotal, 8)}</span>
                      <span>{check.balanced ? "✓ 相等" : "✗ 不相等"}</span>
                    </div>
                  ))}
                  {view.viewerChanges.length > 0 ? (
                    <div className="journal-net">
                      我的净变动：
                      {view.viewerChanges.map((change) => (
                        <span key={change.assetCode} className={change.netChange.startsWith("-") ? "down" : "up"}>
                          {change.netChange.startsWith("-") ? "" : "+"}
                          {formatAmount(change.netChange, 8)} {change.assetCode}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function TAccountCard(props: { account: TAccount }) {
  const { account } = props;
  const rows = Math.max(account.debits.length, account.credits.length);
  return (
    <div className={`t-account ${ROLE_CLASS[account.accountRole]}`}>
      <div className="t-account-title">
        <span>{account.accountLabel}</span>
        <b>{account.assetCode}</b>
      </div>
      <div className="t-account-grid">
        <div className="t-col-head">借</div>
        <div className="t-col-head">贷</div>
        {Array.from({ length: rows }, (_, index) => {
          const debit = account.debits[index];
          const credit = account.credits[index];
          return [
            <div key={`d${index}`} className="t-cell" title={debit?.stageLabel}>
              {debit ? formatAmount(debit.amount, 8) : ""}
            </div>,
            <div key={`c${index}`} className="t-cell" title={credit?.stageLabel}>
              {credit ? formatAmount(credit.amount, 8) : ""}
            </div>
          ];
        })}
        <div className="t-cell t-total">{formatAmount(account.debitTotal, 8)}</div>
        <div className="t-cell t-total">{formatAmount(account.creditTotal, 8)}</div>
      </div>
    </div>
  );
}
