import { useMemo, useState, type FormEvent } from "react";

import { Badge, Button, CopyButton, Field, Modal, Panel, formatAmount, formatDateTime } from "@web3-cex/web-ui";

import { formatWait, readErrorMessage } from "../../lib/api.js";
import { encodeQr, qrToSvgPath } from "../../lib/qr.js";
import type { KycTier, TwoFactorEnrollment } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";

const TIER_LABEL: Record<string, string> = { unverified: "未认证", L1: "L1 基础认证", L2: "L2 高级认证" };

/** Renders an otpauth:// URI as an SVG QR code (encoder in lib/qr.ts, no dependency). */
export function QrCode(props: { value: string; size?: number; label?: string }) {
  const matrix = useMemo(() => encodeQr(props.value, "M"), [props.value]);
  const border = 4;
  const dimension = matrix.size + border * 2;
  return (
    <svg
      className="qr-code"
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={props.size ?? 192}
      height={props.size ?? 192}
      role="img"
      aria-label={props.label ?? "二维码"}
      shapeRendering="crispEdges"
    >
      <rect width={dimension} height={dimension} fill="#fff" />
      <path d={qrToSvgPath(matrix, border)} fill="#000" />
    </svg>
  );
}

function RecoveryCodesModal(props: { codes: string[] | null; onClose: () => void }) {
  const codes = props.codes ?? [];
  return (
    <Modal open={codes.length > 0} title="保存你的恢复码" onClose={props.onClose}>
      <div className="secret-box" id="recovery-codes">
        <p className="form-error">
          恢复码只显示这一次。手机丢失时，可以在登录或关闭 2FA 时用其中任意一个代替动态码，每个只能用一次。
        </p>
        <ol className="recovery-codes">
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ol>
        <CopyButton value={codes.join("\n")} label="复制全部恢复码" />
        <Button variant="primary" onClick={props.onClose}>
          我已妥善保存
        </Button>
      </div>
    </Modal>
  );
}

/** M4-1: bind / verify / unbind TOTP 2FA from the account page. */
export function TwoFactorPanel() {
  const { state, actions } = useExchange();
  const status = state.twoFactor;
  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"enroll" | "enable" | "disable" | "regenerate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const cooldownSeconds = state.withdrawalLimits?.cooldown?.cooldownSeconds ?? 0;

  async function run(kind: NonNullable<typeof busy>, task: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await task();
    } catch (taskError) {
      setError(readErrorMessage(taskError));
    } finally {
      setBusy(null);
    }
  }

  const startEnroll = () =>
    run("enroll", async () => {
      setEnrollment(await actions.enrollTwoFactor());
      setCode("");
    });

  const confirmEnable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("enable", async () => {
      const result = await actions.enableTwoFactor(code.trim());
      setEnrollment(null);
      setCode("");
      setRecoveryCodes(result.recoveryCodes ?? null);
    });
  };

  const confirmWithCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "disable") {
      void run("disable", async () => {
        await actions.disableTwoFactor(code.trim());
        setMode("idle");
        setCode("");
      });
    } else if (mode === "regenerate") {
      void run("regenerate", async () => {
        const result = await actions.regenerateRecoveryCodes(code.trim());
        setMode("idle");
        setCode("");
        setRecoveryCodes(result.recoveryCodes ?? null);
      });
    }
  };

  return (
    <Panel title="二次验证（TOTP 2FA）" actions={status?.enabled ? <Badge tone="positive">已开启</Badge> : <Badge tone="neutral">未开启</Badge>}>
      <div id="two-factor-panel">
        {!status ? (
          <p className="muted">正在读取 2FA 状态…</p>
        ) : status.enabled ? (
          <>
            <dl className="kv">
              <div>
                <dt>开启时间</dt>
                <dd>{formatDateTime(status.enabledAt)}</dd>
              </div>
              <div>
                <dt>剩余恢复码</dt>
                <dd>{status.recoveryCodesRemaining ?? 0} 个</dd>
              </div>
            </dl>
            <p className="form-note">登录与提现都需要输入身份验证器中的 6 位动态码。</p>
            {mode === "idle" ? (
              <div className="button-row">
                <Button size="sm" onClick={() => { setMode("regenerate"); setCode(""); setError(null); }}>
                  重新生成恢复码
                </Button>
                <Button size="sm" variant="sell" onClick={() => { setMode("disable"); setCode(""); setError(null); }} id="two-factor-disable">
                  关闭二次验证
                </Button>
              </div>
            ) : (
              <form className="inline-form" onSubmit={confirmWithCode}>
                <input
                  name="twoFactorCode"
                  value={code}
                  onChange={(event) => setCode(event.target.value.trim())}
                  placeholder={mode === "disable" ? "当前动态码或恢复码" : "当前 6 位动态码"}
                  autoComplete="one-time-code"
                  maxLength={9}
                />
                <Button type="submit" size="sm" variant={mode === "disable" ? "sell" : "primary"} loading={busy !== null} disabled={!code}>
                  {mode === "disable" ? "确认关闭" : "确认生成"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  取消
                </Button>
              </form>
            )}
          </>
        ) : enrollment ? (
          <form className="two-factor-enroll" onSubmit={confirmEnable}>
            <div className="qr-wrap">
              <QrCode value={enrollment.otpauthUri} label="2FA 绑定二维码" />
            </div>
            <div>
              <ol className="steps-list">
                <li>用 Google Authenticator / 1Password 等身份验证器扫描二维码</li>
                <li>
                  无法扫码时手动输入密钥：<code id="two-factor-secret">{enrollment.secret}</code>{" "}
                  <CopyButton value={enrollment.secret} label="复制密钥" />
                </li>
                <li>输入 App 中显示的 6 位动态码完成绑定</li>
              </ol>
              <Field label="动态码">
                <input
                  name="enableCode"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  autoComplete="one-time-code"
                  placeholder="000000"
                />
              </Field>
              <div className="button-row">
                <Button type="submit" variant="primary" loading={busy === "enable"} disabled={code.length !== 6} id="two-factor-enable">
                  验证并开启
                </Button>
                <Button variant="ghost" onClick={() => setEnrollment(null)}>
                  取消
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <>
            <p className="muted">开启后，登录和提现都需要额外输入身份验证器生成的动态码，账户被盗用密码也无法转走资产。</p>
            <Button variant="primary" onClick={() => void startEnroll()} loading={busy === "enroll"} id="two-factor-start">
              开启二次验证
            </Button>
          </>
        )}
        {cooldownSeconds > 0 ? (
          <p className="form-note">安全提示：开启或关闭 2FA 后 {formatWait(cooldownSeconds)} 内暂停提现（冷却期）。</p>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <RecoveryCodesModal codes={recoveryCodes} onClose={() => setRecoveryCodes(null)} />
    </Panel>
  );
}

/** M4-4: KYC tier, withdrawal limits with today's usage and the demo KYC form. */
export function KycPanel() {
  const { state, actions } = useExchange();
  const kyc = state.kyc;
  const limits = state.withdrawalLimits;
  const tier: KycTier = kyc?.tier ?? limits?.kycTier ?? "unverified";
  const nextTiers = (["L1", "L2"] as const).filter((candidate) => (tier === "unverified" ? true : tier === "L1" ? candidate === "L2" : false));
  const [requestedTier, setRequestedTier] = useState<"L1" | "L2">(nextTiers[0] ?? "L1");
  const [fullName, setFullName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTier = nextTiers.includes(requestedTier as never) ? requestedTier : (nextTiers[0] ?? "L1");
  const pending = kyc?.pendingRequest;
  const latest = kyc?.latestRequest;
  const cooldown = limits?.cooldown;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await actions.submitKyc({ requestedTier: selectedTier, fullName, idNumber });
      setFullName("");
      setIdNumber("");
    } catch (submitError) {
      setError(readErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="身份认证与提现限额"
      actions={<Badge tone={tier === "L2" ? "positive" : tier === "L1" ? "info" : "neutral"}>{TIER_LABEL[tier] ?? tier}</Badge>}
    >
      <div id="kyc-panel">
        {cooldown?.active ? (
          <div className="form-error" role="status" id="withdraw-cooldown">
            安全冷却期：{cooldown.reason === "two_factor_changed" ? "修改二次验证" : "新增提现地址"}后暂停提现，还需等待{" "}
            {formatWait(cooldown.remainingSeconds)}
          </div>
        ) : null}
        {limits && limits.assets.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table compact" id="withdrawal-limits-table">
              <thead>
                <tr>
                  <th>币种</th>
                  <th className="num">单笔限额</th>
                  <th className="num">每日限额</th>
                  <th className="num">今日已用</th>
                  <th className="num">今日剩余</th>
                </tr>
              </thead>
              <tbody>
                {limits.assets.map((asset) => (
                  <tr key={asset.assetCode}>
                    <td>{asset.assetCode}</td>
                    <td className="num">{asset.singleLimit ? formatAmount(asset.singleLimit) : "不限"}</td>
                    <td className="num">{asset.dailyLimit ? formatAmount(asset.dailyLimit) : "不限"}</td>
                    <td className="num">{formatAmount(asset.usedToday)}</td>
                    <td className="num">{asset.remainingToday !== undefined ? formatAmount(asset.remainingToday) : "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">暂无限额信息</p>
        )}
        <p className="form-note">
          限额按 UTC 自然日统计，取「平台限额」与「KYC 等级限额」中更严格的一个；由 wallet-service 在提现申请时校验。
          {limits?.assets.some((asset) => asset.dualApprovalThreshold)
            ? " 超过大额阈值的提现需要两名运营人员复核。"
            : ""}
        </p>

        {pending ? (
          <p className="muted" id="kyc-pending">
            已提交 {pending.requestedTier} 认证申请（{formatDateTime(pending.createdAt)}），等待运营审核。
          </p>
        ) : nextTiers.length === 0 ? (
          <p className="muted">已是最高认证等级。</p>
        ) : (
          <form className="kyc-form" onSubmit={submit} id="kyc-form">
            {latest?.status === "rejected" ? (
              <p className="form-error">上次申请未通过{latest.reviewNote ? `：${latest.reviewNote}` : ""}，可修改后重新提交。</p>
            ) : null}
            <p className="form-note">
              <Badge tone="warning">演示</Badge> 这是学习型 demo：不会做真实身份核验，请填写虚构信息；证件号只保存后 4 位。
            </p>
            <Field label="申请等级">
              <select value={selectedTier} onChange={(event) => setRequestedTier(event.target.value as "L1" | "L2")} name="requestedTier">
                {nextTiers.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {TIER_LABEL[candidate]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="姓名（演示）">
              <input name="fullName" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="例如：Demo Trader" maxLength={64} />
            </Field>
            <Field label="证件号（演示，虚构即可）" hint="6-32 位字母或数字">
              <input name="idNumber" value={idNumber} onChange={(event) => setIdNumber(event.target.value)} placeholder="例如：DEMO123456" maxLength={32} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={fullName.trim().length < 2 || idNumber.trim().length < 6}>
              提交认证申请
            </Button>
          </form>
        )}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
