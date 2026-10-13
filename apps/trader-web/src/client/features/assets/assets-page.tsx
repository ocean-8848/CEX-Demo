import { useEffect, useMemo, useState } from "react";

import {
  AssetIcon,
  Badge,
  Button,
  CopyButton,
  Empty,
  Field,
  formatAmount,
  formatDateTime,
  formatFixed,
  Panel,
  Progress,
  shortHash,
  Steps,
  Tabs,
  toNumber
} from "@web3-cex/web-ui";

import { formatWait, readErrorMessage } from "../../lib/api.js";
import {
  DEPOSIT_STEPS,
  WITHDRAWAL_STEPS,
  availableOf,
  describeFundingStatus,
  fundingStepIndex
} from "../../lib/records.js";
import { navigate } from "../../lib/router.js";
import type { FaucetReceipt, FaucetStatus } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";
import { BalancesTable } from "../trade/account-tables.js";

// Networks are code-level capabilities; which asset lives on which network
// comes from config/markets.json (runtime config `assets`).
const NETWORK_LABELS: Record<string, string> = {
  ethereum: "Ethereum（本地模拟链）",
  bsc: "BNB Smart Chain",
  base: "Base",
  solana: "Solana",
  bitcoin: "Bitcoin"
};

/** Asset metadata + the network deposits / withdrawals use (first configured one). */
function useAssetConfig(code: string) {
  const { state } = useExchange();
  const definition = state.config?.assets.find((item) => item.code === code);
  const network = definition?.networks[0] ?? "ethereum";
  return {
    definition,
    network,
    networkLabel: NETWORK_LABELS[network] ?? network,
    withdrawalFee: definition?.withdrawalFee ?? "0",
    faucetPresets: definition?.faucet?.presets ?? []
  };
}

function useAssetCodes(): string[] {
  const { state } = useExchange();
  return (state.config?.assets ?? []).map((asset) => asset.code);
}

/** Quote asset of the default market; asset values are shown in it. */
function useValuationAsset(): string {
  const { state } = useExchange();
  const config = state.config;
  return config?.markets.find((item) => item.market === config.defaultMarket)?.quoteAsset ?? config?.markets[0]?.quoteAsset ?? "";
}

/** Values every asset in the valuation asset using the last price of its `<ASSET>-<VALUATION>` market. */
function useValuation() {
  const { state, assets } = useExchange();
  const valuationAsset = useValuationAsset();
  return useMemo(() => {
    const priceOf = (asset: string) => {
      if (asset === valuationAsset) {
        return 1;
      }
      const market = state.config?.markets.find(
        (item) => item.baseAsset === asset && item.quoteAsset === valuationAsset
      );
      const ticker = market ? state.tickers[market.market] : undefined;
      const last = toNumber(ticker?.lastPrice);
      return Number.isFinite(last) && last > 0 ? last : 0;
    };
    const total = assets.reduce((sum, asset) => sum + asset.total * priceOf(asset.assetCode), 0);
    const locked = assets.reduce((sum, asset) => sum + asset.locked * priceOf(asset.assetCode), 0);
    return { total, locked, available: total - locked, valuationAsset };
  }, [assets, state.tickers, state.config, valuationAsset]);
}

export function AssetsPage(props: { action?: string; asset?: string; tab?: string; highlight?: string }) {
  const { state, actions } = useExchange();
  const valuation = useValuation();
  const [action, setAction] = useState<"deposit" | "withdraw">(
    props.action === "withdraw" ? "withdraw" : "deposit"
  );
  const [history, setHistory] = useState<"deposits" | "withdrawals">(
    props.tab === "withdrawals" || (props.tab !== "deposits" && props.action === "withdraw")
      ? "withdrawals"
      : "deposits"
  );

  // Deep links from the notification center / statement: open the right tab
  // and scroll the referenced record into view.
  useEffect(() => {
    if (props.tab === "deposits" || props.tab === "withdrawals") {
      setHistory(props.tab);
    }
  }, [props.tab, props.highlight]);
  useEffect(() => {
    if (!props.highlight) {
      return;
    }
    const timer = window.setTimeout(() => {
      document
        .querySelector(`[data-record-id="${CSS.escape(props.highlight ?? "")}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [props.highlight, history, state.deposits.length, state.withdrawals.length]);

  useEffect(() => {
    if (props.action === "withdraw" || props.action === "deposit") {
      setAction(props.action);
      setHistory(props.action === "withdraw" ? "withdrawals" : "deposits");
    }
  }, [props.action, props.asset]);

  if (!state.token) {
    return (
      <div className="page narrow">
        <Empty
          icon="🔒"
          title="登录后查看资产"
          action={
            <Button variant="primary" onClick={() => navigate("/login?redirect=/assets")}>
              登录 / 注册
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page assets-page">
      <div className="page-head">
        <div>
          <h1>资产总览</h1>
          <p className="muted">现货账户 · 余额由 ledger-service 双分录账本实时计算</p>
        </div>
        <div className="button-row">
          <Button variant="ghost" size="sm" onClick={() => navigate("/assets/ledger")} id="open-statement">
            资金流水 / 对账单
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/assets/reserves")} id="open-reserves">
            储备金证明
          </Button>
          <Button variant="ghost" size="sm" loading={state.accountLoading} onClick={() => void actions.refreshAccount()} id="refresh-account">
            刷新
          </Button>
        </div>
      </div>

      <div className="valuation panel">
        <div>
          <span className="muted">总资产估值</span>
          <strong id="total-valuation">
            {formatFixed(valuation.total, 2)} <small>{valuation.valuationAsset}</small>
          </strong>
        </div>
        <div>
          <span className="muted">可用</span>
          <b>{formatFixed(valuation.available, 2)} {valuation.valuationAsset}</b>
        </div>
        <div>
          <span className="muted" title="下单冻结 + 提现冻结">冻结</span>
          <b>{formatFixed(valuation.locked, 2)} {valuation.valuationAsset}</b>
        </div>
        <div className="valuation-actions">
          <Button variant="primary" onClick={() => setAction("deposit")}>
            充值
          </Button>
          <Button onClick={() => setAction("withdraw")}>提现</Button>
          <Button variant="ghost" onClick={() => navigate(`/trade/${state.market}`)}>
            去交易
          </Button>
        </div>
      </div>

      <div className="assets-grid">
        <Panel title="我的资产" flush>
          <BalancesTable />
        </Panel>
        <Panel
          title={
            <Tabs
              value={action}
              onChange={setAction}
              items={[
                { value: "deposit", label: "充值" },
                { value: "withdraw", label: "提现" }
              ]}
            />
          }
        >
          {action === "deposit" ? (
            <DepositPanel initialAsset={props.asset} />
          ) : (
            <WithdrawPanel initialAsset={props.asset} />
          )}
        </Panel>
      </div>

      <Panel
        flush
        title={
          <Tabs
            value={history}
            onChange={setHistory}
            items={[
              { value: "deposits", label: "充值记录", count: state.deposits.length },
              { value: "withdrawals", label: "提现记录", count: state.withdrawals.length }
            ]}
          />
        }
      >
        {history === "deposits" ? (
          <DepositHistory highlight={props.highlight} />
        ) : (
          <WithdrawalHistory highlight={props.highlight} />
        )}
      </Panel>
    </div>
  );
}

function AssetPicker(props: { value: string; onChange: (value: string) => void; id?: string }) {
  const codes = useAssetCodes();
  return (
    <div className="asset-picker" id={props.id}>
      {codes.map((code) => (
        <button
          key={code}
          type="button"
          className={props.value === code ? "active" : ""}
          onClick={() => props.onChange(code)}
        >
          <AssetIcon asset={code} size={18} />
          {code}
        </button>
      ))}
    </div>
  );
}

function DepositPanel(props: { initialAsset?: string }) {
  const { state, actions } = useExchange();
  const defaultAsset = useValuationAsset();
  const [asset, setAsset] = useState(props.initialAsset ?? defaultAsset);
  const { network, networkLabel, faucetPresets } = useAssetConfig(asset);
  const [creating, setCreating] = useState(false);
  const [amount, setAmount] = useState(faucetPresets[0] ?? "1");
  const [sending, setSending] = useState(false);
  const [receipts, setReceipts] = useState<Array<FaucetReceipt & { progress?: FaucetStatus }>>([]);
  const address = state.depositAddresses.find(
    (item) => item.assetCode === asset && item.network === network && item.status !== "disabled"
  );

  useEffect(() => {
    if (!asset && defaultAsset) {
      setAsset(defaultAsset);
    }
  }, [asset, defaultAsset]);

  useEffect(() => {
    setAmount(faucetPresets[0] ?? "1");
  }, [asset, faucetPresets.join(",")]);

  // Poll the simulator for confirmation progress of our pending faucet transfers.
  const pending = receipts.filter(
    (receipt) =>
      (receipt.progress?.confirmations ?? receipt.confirmations) < receipt.requiredConfirmations
  );
  useEffect(() => {
    if (pending.length === 0) {
      return;
    }
    const timer = window.setInterval(async () => {
      for (const receipt of pending) {
        try {
          const response = await fetch(`/api/demo/faucet/${encodeURIComponent(receipt.observationId)}`);
          if (!response.ok) {
            continue;
          }
          const progress = (await response.json()) as FaucetStatus;
          setReceipts((current) =>
            current.map((item) => (item.observationId === receipt.observationId ? { ...item, progress } : item))
          );
        } catch {
          // Ignore transient polling errors.
        }
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [pending.map((item) => item.observationId).join(",")]);

  async function createAddress() {
    setCreating(true);
    try {
      await actions.createDepositAddress(asset, network);
    } catch (error) {
      actions.toast("negative", "生成地址失败", readErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function sendFaucet() {
    setSending(true);
    try {
      const receipt = await actions.requestFaucet(asset, amount);
      setReceipts((current) => [receipt, ...current].slice(0, 5));
      if (!address) {
        void actions.refreshAccount();
      }
    } catch (error) {
      actions.toast("negative", "测试币领取失败", readErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="funding-panel" id="deposit-panel">
      <Field label="币种">
        <AssetPicker value={asset} onChange={setAsset} id="deposit-asset" />
      </Field>
      <Field label="网络">
        <div className="static-input">{networkLabel}</div>
      </Field>
      <Field label="充值地址" hint="只向该地址转入同一网络上的对应币种。">
        {address?.address ? (
          <div className="address-box" id="deposit-address">
            <code>{address.address}</code>
            <CopyButton value={address.address} />
          </div>
        ) : (
          <Button onClick={() => void createAddress()} loading={creating} id="create-deposit-address">
            生成 {asset} 充值地址
          </Button>
        )}
      </Field>

      {state.config?.demo.enabled ? (
        <div className="faucet">
          <div className="faucet-head">
            <strong>🚰 测试水龙头</strong>
            <span className="muted">模拟一笔链上转账到你的充值地址，观察确认数推进到入账</span>
          </div>
          <div className="faucet-row">
            <div className="chip-group">
              {(faucetPresets.length > 0 ? faucetPresets : ["1"]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={amount === preset ? "chip active" : "chip"}
                  onClick={() => setAmount(preset)}
                >
                  {formatAmount(preset)} {asset}
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={() => void sendFaucet()} loading={sending} id="faucet-submit">
              模拟转入
            </Button>
          </div>
          {receipts.length > 0 ? (
            <ul className="faucet-receipts">
              {receipts.map((receipt) => {
                const confirmations = Math.min(
                  receipt.progress?.confirmations ?? receipt.confirmations,
                  receipt.requiredConfirmations
                );
                const done = confirmations >= receipt.requiredConfirmations;
                return (
                  <li key={receipt.observationId}>
                    <div className="receipt-head">
                      <span>
                        {formatAmount(receipt.amount)} {receipt.assetCode}
                      </span>
                      <code title={receipt.txHash}>{shortHash(receipt.txHash, 10, 6)}</code>
                      <Badge tone={done ? "positive" : "info"}>
                        {done ? "已确认" : `${confirmations}/${receipt.requiredConfirmations} 确认`}
                      </Badge>
                    </div>
                    <Progress value={confirmations / receipt.requiredConfirmations} tone={done ? "positive" : "info"} />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WithdrawPanel(props: { initialAsset?: string }) {
  const { state, actions, assets } = useExchange();
  const defaultAsset = useValuationAsset();
  const [asset, setAsset] = useState(props.initialAsset ?? defaultAsset);
  const { network, withdrawalFee } = useAssetConfig(asset);
  useEffect(() => {
    if (!asset && defaultAsset) {
      setAsset(defaultAsset);
    }
  }, [asset, defaultAsset]);
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [busy, setBusy] = useState<"validate" | "request" | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const fee = withdrawalFee;
  const available = availableOf(assets, asset);
  const maxAmount = Math.max(available - toNumber(fee), 0);
  const addressBook = state.addressBook.filter((entry) => !entry.network || entry.network === network);
  // M4-1 / M4-4 / M5-2: the same rules wallet-service enforces, shown up front.
  const limits = state.withdrawalLimits;
  const assetLimit = limits?.assets.find((item) => item.assetCode === asset);
  const twoFactorEnabled = Boolean(state.twoFactor?.enabled ?? limits?.twoFactorEnabled);
  const twoFactorMissing = Boolean(limits?.requireTwoFactor) && !twoFactorEnabled;
  const cooldown = limits?.cooldown?.active ? limits.cooldown : null;
  const savedEntry = addressBook.find((entry) => entry.address.toLowerCase() === toAddress.toLowerCase());

  useEffect(() => {
    if (!toAddress && addressBook[0]) {
      setToAddress(addressBook[0].address);
    }
  }, [addressBook.length]);

  useEffect(() => setCheck(null), [asset, toAddress, amount]);

  const input = () => ({
    assetCode: asset,
    network,
    toAddress: toAddress.trim(),
    amount,
    fee,
    twoFactorCode: twoFactorCode || undefined
  });

  async function validate() {
    setBusy("validate");
    try {
      const result = await actions.validateWithdrawal(input());
      setCheck({
        ok: result.valid !== false,
        message:
          result.valid !== false
            ? `校验通过：将冻结 ${formatAmount(String(result.frozenAmount ?? ""))} ${asset}（金额 + 手续费）`
            : String(result.reason ?? "校验未通过")
      });
    } catch (error) {
      setCheck({ ok: false, message: readErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy("request");
    try {
      await actions.requestWithdrawal(input());
      setAmount("");
      setTwoFactorCode("");
      setCheck(null);
    } catch (error) {
      setCheck({ ok: false, message: readErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function saveAddress() {
    try {
      await actions.addAddressBookEntry({ network, address: toAddress.trim(), label: newLabel || "我的地址" });
      setNewLabel("");
    } catch (error) {
      actions.toast("negative", "保存地址失败", readErrorMessage(error));
    }
  }

  const amountValue = toNumber(amount);
  const canSubmit = /^0x[0-9a-fA-F]{40}$/.test(toAddress.trim()) && amountValue > 0 && amountValue <= maxAmount + 1e-12;

  return (
    <div className="funding-panel" id="withdraw-panel">
      <Field label="币种">
        <AssetPicker value={asset} onChange={setAsset} id="withdraw-asset" />
      </Field>
      <Field label="提现地址" hint={savedEntry ? `地址簿：${savedEntry.label ?? ""}${savedEntry.isWhitelisted ? " · 白名单" : ""}` : "EVM 地址（0x 开头 40 位十六进制）"}>
        <input
          name="toAddress"
          value={toAddress}
          onChange={(event) => setToAddress(event.target.value)}
          placeholder="0x…"
          list="address-book"
          autoComplete="off"
        />
        <datalist id="address-book">
          {addressBook.map((entry) => (
            <option key={entry.addressBookId} value={entry.address}>
              {entry.label}
            </option>
          ))}
        </datalist>
      </Field>
      {toAddress && !savedEntry && /^0x[0-9a-fA-F]{40}$/.test(toAddress.trim()) ? (
        <div className="inline-form">
          <input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="地址备注（可选）" />
          <Button size="sm" onClick={() => void saveAddress()}>
            保存到地址簿
          </Button>
        </div>
      ) : null}
      <Field
        label={
          <span className="field-label-row">
            数量
            <span className="muted">
              可用 {formatAmount(available, 8)} {asset}
            </span>
          </span>
        }
      >
        <div className="input-group">
          <input
            name="amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0.00"
          />
          <button type="button" className="ig-max" onClick={() => setAmount(formatAmount(maxAmount, 8).replace(/,/g, ""))}>
            最大
          </button>
          <span className="ig-suffix">{asset}</span>
        </div>
      </Field>
      {twoFactorMissing ? (
        <div className="form-error" role="status" id="withdraw-2fa-missing">
          平台要求提现前开启二次验证。
          <button type="button" className="link-button" onClick={() => navigate("/account")}>
            请先在账户页开启二次验证 →
          </button>
        </div>
      ) : null}
      {cooldown ? (
        <div className="form-error" role="status" id="withdraw-cooldown-notice">
          安全冷却期：{cooldown.reason === "two_factor_changed" ? "修改二次验证" : "新增提现地址"}后暂停提现，还需等待{" "}
          {formatWait(cooldown.remainingSeconds)}
        </div>
      ) : null}
      <Field label={twoFactorEnabled ? "二次验证码（必填）" : "二次验证码（未开启 2FA 可留空）"}>
        <input
          name="twoFactorCode"
          inputMode="numeric"
          maxLength={6}
          value={twoFactorCode}
          onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, ""))}
          placeholder={twoFactorEnabled ? "身份验证器中的 6 位动态码" : "可选"}
          autoComplete="one-time-code"
        />
      </Field>
      <dl className="order-summary">
        <div>
          <dt>网络手续费</dt>
          <dd>
            {formatAmount(fee)} {asset}
          </dd>
        </div>
        <div>
          <dt>到账数量</dt>
          <dd>{amountValue > 0 ? `${formatAmount(amountValue, 8)} ${asset}` : "--"}</dd>
        </div>
        <div>
          <dt>账本冻结</dt>
          <dd>{amountValue > 0 ? `${formatAmount(amountValue + toNumber(fee), 8)} ${asset}` : "--"}</dd>
        </div>
        {assetLimit ? (
          <div id="withdraw-limit-summary">
            <dt>限额（{limits?.kycTier ?? "--"}）</dt>
            <dd>
              单笔 {assetLimit.singleLimit ? formatAmount(assetLimit.singleLimit) : "不限"} · 今日剩余{" "}
              {assetLimit.remainingToday !== undefined ? formatAmount(assetLimit.remainingToday) : "不限"} {asset}
            </dd>
          </div>
        ) : null}
        {assetLimit?.dualApprovalThreshold && amountValue > toNumber(assetLimit.dualApprovalThreshold) ? (
          <div>
            <dt>审核</dt>
            <dd>大额提现，需两名运营人员复核</dd>
          </div>
        ) : null}
      </dl>
      {check ? (
        <div className={check.ok ? "form-ok" : "form-error"} role="status" id="withdraw-result">
          {check.message}
        </div>
      ) : null}
      <div className="button-row">
        <Button onClick={() => void validate()} loading={busy === "validate"} disabled={!canSubmit}>
          预校验
        </Button>
        <Button variant="primary" onClick={() => void submit()} loading={busy === "request"} disabled={!canSubmit} id="withdraw-submit">
          提交提现
        </Button>
      </div>
      <p className="form-note">
        提交后资金立即冻结，进入运营后台人工审核；审核通过后由 custody-adapter 广播，模拟链确认 12 个区块后完成。
      </p>
    </div>
  );
}

function DepositHistory(props: { highlight?: string }) {
  const { state } = useExchange();
  if (state.deposits.length === 0) {
    return <Empty icon="↓" title="暂无充值记录" hint="使用上方的测试水龙头模拟一笔链上充值。" />;
  }
  return (
    <div className="table-scroll">
      <table className="data-table" id="deposits-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>币种</th>
            <th className="num">数量</th>
            <th>交易哈希</th>
            <th>确认数</th>
            <th>进度</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {state.deposits.map((deposit) => {
            const status = describeFundingStatus(deposit.status, "deposit");
            return (
              <tr
                key={deposit.depositId}
                data-record-id={deposit.depositId}
                className={props.highlight && props.highlight === deposit.depositId ? "row-highlight" : undefined}
              >
                <td className="muted">{formatDateTime(deposit.creditedAt ?? deposit.detectedAt ?? deposit.createdAt)}</td>
                <td>{deposit.assetCode}</td>
                <td className="num">{formatAmount(deposit.amount, 8)}</td>
                <td>
                  <code title={deposit.txHash}>{shortHash(deposit.txHash, 10, 6)}</code>
                </td>
                <td>{deposit.confirmations ?? "--"}</td>
                <td>
                  <Steps steps={DEPOSIT_STEPS} current={fundingStepIndex(DEPOSIT_STEPS, deposit.status)} failed={deposit.status === "failed"} />
                </td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WithdrawalHistory(props: { highlight?: string }) {
  const { state } = useExchange();
  if (state.withdrawals.length === 0) {
    return <Empty icon="↑" title="暂无提现记录" />;
  }
  return (
    <div className="table-scroll">
      <table className="data-table" id="withdrawals-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>币种</th>
            <th className="num">数量</th>
            <th className="num">手续费</th>
            <th>地址</th>
            <th>进度</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {state.withdrawals.map((withdrawal) => {
            const status = describeFundingStatus(withdrawal.status, "withdrawal");
            const failed = withdrawal.status === "rejected" || withdrawal.status === "failed";
            const index = fundingStepIndex(WITHDRAWAL_STEPS, withdrawal.status);
            return (
              <tr
                key={withdrawal.withdrawalId}
                data-record-id={withdrawal.withdrawalId}
                className={props.highlight && props.highlight === withdrawal.withdrawalId ? "row-highlight" : undefined}
              >
                <td className="muted">{formatDateTime(withdrawal.requestedAt ?? withdrawal.createdAt)}</td>
                <td>{withdrawal.assetCode}</td>
                <td className="num">{formatAmount(withdrawal.amount, 8)}</td>
                <td className="num muted">{formatAmount(withdrawal.fee, 8)}</td>
                <td>
                  <code title={withdrawal.toAddress}>{shortHash(withdrawal.toAddress)}</code>
                </td>
                <td>
                  <Steps
                    steps={WITHDRAWAL_STEPS}
                    current={withdrawal.status === "confirmed" ? WITHDRAWAL_STEPS.length : index}
                    failed={failed}
                  />
                </td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
