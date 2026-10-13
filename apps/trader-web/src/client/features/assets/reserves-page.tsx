import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, Button, CopyButton, Empty, Panel, Spinner, formatAmount, formatDateTime, shortHash } from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { formatReserveRatio, verifyProofOfReserves, type PorVerifyResult } from "../../lib/por-verify.js";
import { navigate } from "../../lib/router.js";
import type { ProofOfReservesAssetView, ProofOfReservesView } from "../../lib/types.js";
import { learnEvent } from "../../state/learn.js";
import { useExchange } from "../../state/store.js";

const STEP_DELAY_MS = 350;

/**
 * 储备金证明: the latest proof-of-reserves snapshot, the caller's own Merkle
 * leaf and path, and an inclusion check that runs entirely in the browser
 * (Web Crypto SHA-256). The server only ever returns the caller's leaf; the
 * path contains sibling hashes, never other users' balances.
 */
export function ReservesPage() {
  const { state, api, actions } = useExchange();
  const [data, setData] = useState<ProofOfReservesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PorVerifyResult | null>(null);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const timers = useRef<number[]>([]);

  const load = useCallback(async () => {
    if (!api || !state.token) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api.gateway<ProofOfReservesView>("/proof-of-reserves", { token: state.token }));
      setResult(null);
      setVisibleSteps(0);
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, state.token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  async function verify() {
    if (!data?.available || !data.leaf) {
      return;
    }
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setVerifying(true);
    setVisibleSteps(0);
    try {
      const outcome = await verifyProofOfReserves({
        userId: data.leaf.userId,
        nonce: data.leaf.nonce,
        balances: data.leaf.balances,
        userHash: data.leaf.userHash,
        leafHash: data.leaf.leafHash,
        proof: data.proof,
        merkleRoot: data.snapshot.merkleRoot
      });
      setResult(outcome);
      outcome.steps.forEach((_, index) => {
        timers.current.push(window.setTimeout(() => setVisibleSteps(index + 1), STEP_DELAY_MS * (index + 1)));
      });
      timers.current.push(
        window.setTimeout(() => setVerifying(false), STEP_DELAY_MS * (outcome.steps.length + 1))
      );
      actions.learn(
        learnEvent({
          service: "wallet-service",
          title: "GET /proof-of-reserves",
          detail: "网关只按当前登录用户向 wallet-service 取自己的叶子和兄弟哈希路径；快照由运营在后台生成，叶子来自 ledger-service 的用户负债。"
        }),
        learnEvent({
          service: "trader-web",
          title: outcome.valid ? "浏览器内验证通过：我的余额在 Merkle 树中" : "浏览器内验证失败",
          detail: `用 Web Crypto SHA-256 从叶子逐层算到根（${data.proof.length} 层），与公布的根 ${shortHash(data.snapshot.merkleRoot, 8, 6)} 比较；整个过程不依赖服务器。`,
          tone: outcome.valid ? "positive" : "negative"
        })
      );
    } catch (cause) {
      setVerifying(false);
      actions.toast("negative", "验证失败", readErrorMessage(cause));
    }
  }

  if (!state.token) {
    return (
      <div className="page narrow">
        <Empty
          icon="🔒"
          title="登录后查看储备金证明"
          action={
            <Button variant="primary" onClick={() => navigate("/login?redirect=/assets/reserves")}>
              登录 / 注册
            </Button>
          }
        />
      </div>
    );
  }

  const done = result !== null && visibleSteps >= result.steps.length;

  return (
    <div className="page reserves-page" id="reserves-page">
      <div className="page-head">
        <div>
          <h1>储备金证明</h1>
          <p className="muted">
            平台公布每个币种的链上储备与用户负债，并用 Merkle 树让你在浏览器里自己确认：你的余额被计入了负债总额
          </p>
        </div>
        <div className="button-row">
          <Button variant="ghost" size="sm" onClick={() => navigate("/assets")}>
            ← 资产总览
          </Button>
          <Button size="sm" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {error ? <div className="form-error">{error}</div> : null}
      {!data && loading ? (
        <div className="reserves-loading">
          <Spinner /> 加载中…
        </div>
      ) : null}

      {data && !data.available ? (
        <Empty
          icon="◇"
          title="平台还没有发布储备金快照"
          hint="运营在后台「钱包与储备金」页生成快照后，这里会显示你的叶子与验证路径。"
        />
      ) : null}

      {data?.available ? (
        <>
          <Panel title="储备与负债（快照时点）" flush>
            <div className="table-scroll">
              <table className="data-table" id="reserves-table">
                <thead>
                  <tr>
                    <th>币种</th>
                    <th className="num">平台链上储备</th>
                    <th className="num">用户负债</th>
                    <th className="num">储备率</th>
                    <th>储备分布（充值地址 / 热钱包 / 冷钱包）</th>
                  </tr>
                </thead>
                <tbody>
                  {data.snapshot.assets
                    .filter((asset) => asset.status !== "no_liabilities" || Number(asset.reserves) > 0)
                    .map((asset) => (
                      <tr key={asset.assetCode}>
                        <td>{asset.assetCode}</td>
                        <td className="num">{formatAmount(asset.reserves)}</td>
                        <td className="num">{formatAmount(asset.netLiabilities)}</td>
                        <td className="num">
                          <Badge tone={asset.status === "covered" ? "positive" : asset.status === "shortfall" ? "negative" : "neutral"}>
                            {formatReserveRatio(asset.reserveRatio)}
                          </Badge>
                        </td>
                        <td>
                          <ReserveBar asset={asset} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="muted small reserves-note">
              储备率 = 平台链上储备 ÷ 用户负债（已扣除已上链、待确认的提现）。≥ 100% 表示该币种 1:1 足额储备；超出部分是平台自有资金。
            </p>
          </Panel>

          <div className="reserves-grid">
            <Panel title="快照">
              <dl className="reserves-kv">
                <div>
                  <dt>生成时间</dt>
                  <dd>{formatDateTime(data.snapshot.createdAt)}</dd>
                </div>
                <div>
                  <dt>Merkle 根</dt>
                  <dd className="mono">
                    {shortHash(data.snapshot.merkleRoot, 12, 10)} <CopyButton value={data.snapshot.merkleRoot} />
                  </dd>
                </div>
                <div>
                  <dt>叶子数 / 树高</dt>
                  <dd>
                    {data.snapshot.leafCount} / {data.snapshot.treeDepth}
                  </dd>
                </div>
                <div>
                  <dt>哈希算法</dt>
                  <dd>{data.snapshot.format?.hashAlgorithm ?? "SHA-256"}</dd>
                </div>
              </dl>
            </Panel>

            <Panel title="我的叶子">
              {data.included && data.leaf ? (
                <dl className="reserves-kv">
                  <div>
                    <dt>计入的余额</dt>
                    <dd>
                      {Object.entries(data.leaf.balances).map(([asset, amount]) => (
                        <span key={asset} className="reserves-chip">
                          {formatAmount(amount)} {asset}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt>盐值 nonce</dt>
                    <dd className="mono">{shortHash(data.leaf.nonce, 8, 6)}</dd>
                  </div>
                  <div>
                    <dt>盐化用户哈希</dt>
                    <dd className="mono">{shortHash(data.leaf.userHash, 10, 8)}</dd>
                  </div>
                  <div>
                    <dt>叶子哈希 / 位置</dt>
                    <dd className="mono">
                      {shortHash(data.leaf.leafHash, 10, 8)} · #{data.leaf.leafIndex}
                    </dd>
                  </div>
                </dl>
              ) : (
                <Empty icon="?" title="你不在这期快照中" hint="快照生成之后才注册或首次入金的账户，会出现在下一期快照里。" />
              )}
            </Panel>
          </div>

          {data.included && data.leaf ? (
            <Panel
              title="在浏览器中验证"
              actions={
                <Button variant="primary" size="sm" onClick={() => void verify()} loading={verifying} id="reserves-verify">
                  {result ? "重新验证" : "开始验证"}
                </Button>
              }
            >
              {!result ? (
                <p className="muted">
                  点击「开始验证」：页面用 Web Crypto 依次计算盐化用户哈希 → 叶子哈希 → 每一层父节点，共 {data.proof.length} 层，最后与公布的 Merkle 根比较。
                </p>
              ) : (
                <ol className="por-steps" id="reserves-steps">
                  {result.steps.slice(0, visibleSteps).map((step, index) => (
                    <li key={`${step.kind}-${index}`} className={step.ok ? "por-step ok" : "por-step bad"}>
                      <div className="por-step-head">
                        <span className="por-step-mark">{step.ok ? "✓" : "✗"}</span>
                        <strong>{step.title}</strong>
                      </div>
                      {step.message ? (
                        <code className="por-step-message">SHA-256("{step.message}")</code>
                      ) : null}
                      <div className="por-step-hash mono">= {step.hash}</div>
                      {step.expected !== undefined ? (
                        <div className="por-step-expected mono">
                          {step.ok ? "与平台公布值一致" : "平台公布值"}：{step.expected}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {done ? (
                <div className={result.valid ? "por-verdict ok" : "por-verdict bad"} id="reserves-verdict">
                  {result.valid
                    ? "验证通过：你的叶子在这棵 Merkle 树里，你的余额被计入了平台公布的负债总额。"
                    : "验证失败：计算结果与公布值不一致，说明数据被篡改或你的余额没有被计入。"}
                </div>
              ) : null}
            </Panel>
          ) : null}

          <Panel title="它能证明什么、不能证明什么">
            <ul className="reserves-explain">
              <li>
                <b>能证明</b>：快照时点你的余额被计入负债；平台各币种的链上储备（充值地址 + 热钱包 + 冷钱包）不少于负债。
              </li>
              <li>
                <b>隐私</b>：叶子里只有「盐化后的用户哈希 + 余额」，路径上只是兄弟节点的哈希，看不到其他用户是谁、有多少钱。
              </li>
              <li>
                <b>不能证明</b>：快照之外的时刻；平台是否漏掉了没人验证的账户或塞入负余额账户（真实交易所用 zk-SNARK 补这一点）；储备是否是借来的。
              </li>
            </ul>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function ReserveBar(props: { asset: ProofOfReservesAssetView }) {
  const parts = [
    { key: "deposit", label: "充值地址", value: Number(props.asset.depositAddresses) + Number(props.asset.internalInTransit) },
    { key: "hot", label: "热钱包", value: Number(props.asset.hot) },
    { key: "cold", label: "冷钱包", value: Number(props.asset.cold) }
  ];
  const sum = parts.reduce((total, part) => total + Math.max(part.value, 0), 0);
  if (sum <= 0) {
    return <span className="muted">--</span>;
  }
  return (
    <div className="reserve-bar" title={parts.map((part) => `${part.label} ${formatAmount(part.value)}`).join(" / ")}>
      {parts.map((part) => (
        <span
          key={part.key}
          className={`reserve-bar-${part.key}`}
          style={{ width: `${(Math.max(part.value, 0) / sum) * 100}%` }}
        />
      ))}
    </div>
  );
}
