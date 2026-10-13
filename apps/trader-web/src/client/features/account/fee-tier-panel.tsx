import { Badge, Empty, formatAmount, marketLabel, Panel, Progress } from "@web3-cex/web-ui";

import { FEE_TIER_SOURCE_LABEL, formatRate } from "../../lib/fee-tier.js";
import { useFeeTier } from "../../state/fee-tier.js";

/** A7: current VIP tier, rates, 30-day volume and progress to the next tier. */
export function FeeTierPanel() {
  const profile = useFeeTier();

  if (!profile) {
    return (
      <Panel title="手续费等级" id="fee-tier-panel">
        <Empty icon="％" title="正在读取手续费等级…" hint="由 order-service 按 30 日成交量计算" />
      </Panel>
    );
  }

  return (
    <Panel
      title="手续费等级"
      id="fee-tier-panel"
      actions={<span className="muted">order-service 在每笔成交时按等级定费率并记录在成交上</span>}
    >
      <dl className="kv">
        <div>
          <dt>当前等级</dt>
          <dd>
            <strong id="fee-tier-current">{profile.tier}</strong> <span className="muted">{profile.name}</span>{" "}
            <Badge tone={profile.source === "volume" ? "neutral" : "info"}>{FEE_TIER_SOURCE_LABEL[profile.source]}</Badge>
            {profile.marketMaker ? <Badge tone="info">{profile.marketMaker.label}</Badge> : null}
          </dd>
        </div>
        <div>
          <dt>Maker / Taker</dt>
          <dd id="fee-tier-rates">
            {formatRate(profile.makerFeeRate)} / {formatRate(profile.takerFeeRate)}
          </dd>
        </div>
        <div>
          <dt>{profile.volumeWindowDays} 日成交量</dt>
          <dd id="fee-tier-volume">
            {formatAmount(profile.volume, 2)} {profile.volumeAsset}
          </dd>
        </div>
        <div>
          <dt>距下一等级</dt>
          <dd>
            {profile.nextTier ? (
              <>
                还差 {formatAmount(profile.remainingVolume, 2)} {profile.volumeAsset} 升至 {profile.nextTier.tier}
                （{formatRate(profile.nextTier.makerFeeRate)} / {formatRate(profile.nextTier.takerFeeRate)}）
                <Progress value={profile.progressRatio} tone="positive" />
              </>
            ) : (
              <span className="muted">已是最高等级</span>
            )}
          </dd>
        </div>
      </dl>
      {profile.source !== "volume" ? (
        <p className="muted small">
          {profile.source === "override"
            ? "当前等级由运营指定（例如做市商计划），优先于按成交量计算的等级。"
            : "做市商计划账户固定在配置的等级，不随成交量变化。"}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="data-table" id="fee-tier-table">
          <thead>
            <tr>
              <th>等级</th>
              <th className="num">30 日成交量 ≥</th>
              <th className="num">Maker</th>
              <th className="num">Taker</th>
            </tr>
          </thead>
          <tbody>
            {profile.tiers.map((tier) => (
              <tr key={tier.tier} className={tier.tier === profile.tier ? "active-row" : undefined}>
                <td>
                  {tier.tier} {tier.tier === profile.tier ? <Badge tone="positive">当前</Badge> : null}
                </td>
                <td className="num">
                  {formatAmount(tier.minVolume, 0)} {profile.volumeAsset}
                </td>
                <td className="num">{formatRate(tier.makerFeeRate)}</td>
                <td className="num">{formatRate(tier.takerFeeRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        实际费率 = min(等级费率, 市场费率)：
        {profile.markets
          .map((market) => `${marketLabel(market.market)} ${formatRate(market.makerFeeRate)} / ${formatRate(market.takerFeeRate)}`)
          .join("；")}
      </p>
    </Panel>
  );
}
