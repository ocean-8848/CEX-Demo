import { useState } from "react";

import { Badge, Button, formatAmount } from "@web3-cex/web-ui";

import type { UserFeeTierProfile } from "../lib/fees-surveillance-types.js";
import { ConfirmDialog, KeyValue, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

const SOURCE_LABEL: Record<UserFeeTierProfile["source"], string> = {
  volume: "按 30 日成交量",
  programme: "做市商计划（配置）",
  override: "运营指定"
};

function rate(value: string): string {
  const percent = Number(value) * 100;
  return Number.isFinite(percent) ? `${Number(percent.toFixed(4))}%` : value;
}

/** 用户详情 → 手续费等级: tier, rates, 30-day volume and the audited override control. */
export function UserFeeTierSection(props: { userId: string }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const query = useOpsQuery<UserFeeTierProfile>(`/users/${encodeURIComponent(props.userId)}/fee-tier`);
  const [target, setTarget] = useState<{ kind: "set"; tier: string } | { kind: "clear" } | null>(null);
  const data = query.data;

  const apply = async (note: string) => {
    if (!target) {
      return;
    }
    const base = `/users/${encodeURIComponent(props.userId)}/fee-tier/override`;
    const result =
      target.kind === "set"
        ? await run("fee-tier", { path: base, body: { tier: target.tier, note } }, { success: `已指定为 ${target.tier}` })
        : await run("fee-tier", { path: `${base}/clear`, body: { note } }, { success: "已取消运营指定，恢复按成交量计算" });
    if (result) {
      setTarget(null);
      query.reload();
    }
  };

  return (
    <section id="user-fee-tier">
      <h4>手续费等级</h4>
      {data ? (
        <>
          <KeyValue
            items={[
              [
                "当前等级",
                <span>
                  <b id="user-fee-tier-current">{data.tier}</b> <Badge tone={data.source === "volume" ? "neutral" : "info"}>{SOURCE_LABEL[data.source]}</Badge>
                  {data.marketMaker ? <Badge tone="info">{data.marketMaker.label}</Badge> : null}
                </span>
              ],
              ["Maker / Taker", `${rate(data.makerFeeRate)} / ${rate(data.takerFeeRate)}`],
              [`${data.volumeWindowDays} 日成交量`, `${formatAmount(data.volume, 2)} ${data.volumeAsset}`],
              [
                "下一等级",
                data.nextTier
                  ? `${data.nextTier.tier}（还差 ${formatAmount(data.remainingVolume, 2)} ${data.volumeAsset}）`
                  : "已是最高等级"
              ],
              [
                "运营指定",
                data.override ? (
                  <span className="small">
                    {data.override.tier} · {data.override.note} · {data.override.assignedBy} · <Time value={data.override.updatedAt} />
                  </span>
                ) : (
                  <span className="muted">无</span>
                )
              ]
            ]}
          />
          {can("ops.users.manage") ? (
            <div className="drawer-actions" id="user-fee-tier-actions">
              {data.tiers
                .filter((tier) => tier.tier !== data.override?.tier)
                .map((tier) => (
                  <Button key={tier.tier} size="sm" variant="ghost" onClick={() => setTarget({ kind: "set", tier: tier.tier })}>
                    指定为 {tier.tier}
                  </Button>
                ))}
              {data.override ? (
                <Button size="sm" variant="ghost" onClick={() => setTarget({ kind: "clear" })} id="user-fee-tier-clear">
                  取消指定
                </Button>
              ) : null}
            </div>
          ) : null}
          {data.audit.length > 0 ? (
            <ol className="timeline">
              {data.audit.map((entry) => (
                <li key={entry.auditId}>
                  <div className="timeline-head">
                    <strong>
                      {entry.action === "set" ? `指定 ${entry.previousTier ?? "无"} → ${entry.tier}` : `取消指定 ${entry.previousTier ?? ""}`}
                    </strong>
                    <Time value={entry.createdAt} />
                  </div>
                  <span className="muted small">
                    {entry.actor} · {entry.note}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : (
        <span className="muted">{query.error ?? "加载中…"}</span>
      )}
      <ConfirmDialog
        open={target !== null}
        title={target?.kind === "set" ? `指定手续费等级为 ${target.tier}` : "取消运营指定的手续费等级"}
        description={
          target?.kind === "set"
            ? "运营指定优先于做市商计划和按成交量计算的等级，从该用户的下一笔成交开始生效（已成交的费率不变）。操作写入等级审计与运营审计日志。"
            : "取消后恢复按 30 日成交量（或做市商计划）计算等级。操作写入等级审计与运营审计日志。"
        }
        confirmLabel="确认"
        noteLabel="备注（例如做市商计划编号）"
        noteRequired
        busy={busy === "fee-tier"}
        onConfirm={(note) => void apply(note)}
        onClose={() => setTarget(null)}
      />
    </section>
  );
}
