import { useEffect, useState } from "react";

import {
  AssetIcon,
  Button,
  changeRatio,
  decimalsOf,
  formatCompact,
  formatFixed,
  formatPercent,
  toNumber,
  trendClass
} from "@web3-cex/web-ui";

import { href, navigate } from "../../lib/router.js";
import type { Kline, MarketDefinition } from "../../lib/types.js";
import { SERVICES, type ServiceKey } from "../../state/learn.js";
import { useExchange } from "../../state/store.js";

export function HomePage() {
  const { state } = useExchange();
  const loggedIn = Boolean(state.token);
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">学习型中心化交易所 · 现货 MVP</span>
          <h1>
            亲手跑一遍<span className="accent">交易所的完整链路</span>
          </h1>
          <p>
            注册、充值、下单、撮合、结算、提现——每一步都由真实的微服务完成。打开「学习模式」，
            就能看到你的每个操作在 13 个服务之间如何流转。
          </p>
          <div className="hero-actions">
            <Button variant="primary" size="lg" onClick={() => navigate(`/trade/${state.market}`)}>
              开始交易
            </Button>
            {loggedIn ? (
              <Button size="lg" onClick={() => navigate("/assets")}>
                查看资产
              </Button>
            ) : (
              <Button size="lg" onClick={() => navigate("/login")} id="hero-login">
                登录 / 体验演示账户
              </Button>
            )}
          </div>
        </div>
        <div className="hero-markets">
          {(state.config?.markets ?? []).map((definition) => (
            <MarketCard key={definition.market} definition={definition} />
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="section-head">
          <h2>一笔订单的旅程</h2>
          <p className="muted">点击任意服务查看它的职责与代码位置</p>
        </div>
        <FlowDiagram />
      </section>

      <section className="home-section">
        <div className="section-head">
          <h2>上手三步</h2>
        </div>
        <div className="steps-grid">
          <a className="step-card" href={href("/login")}>
            <span className="step-no">1</span>
            <strong>登录演示账户</strong>
            <p>一键登录预置 25,000 USDT 与 5 ETH 的演示账户，或注册一个新账户。</p>
          </a>
          <a className="step-card" href={href("/assets?action=deposit")}>
            <span className="step-no">2</span>
            <strong>模拟充值</strong>
            <p>用测试水龙头向自己的充值地址「转账」，看确认数一块块推进直到入账。</p>
          </a>
          <a className="step-card" href={href(`/trade/${state.market}`)}>
            <span className="step-no">3</span>
            <strong>下单并观察</strong>
            <p>打开学习模式后下一笔单：风控 → 冻结 → 撮合 → 结算 → 推送，全程可见。</p>
          </a>
        </div>
      </section>

      <section className="home-section">
        <div className="feature-grid">
          <Feature title="双分录账本" body="每一笔资金变动都是借贷平衡的分录；可用、冻结余额分层，支持对账与重放。" />
          <Feature title="Rust 撮合引擎" body="价格优先、时间优先；支持限价 / 市价与 GTC、IOC、FOK。" />
          <Feature title="幂等与恢复" body="Idempotency-Key 防重复下单；撮合或结算异常进入可重试的恢复队列。" />
          <Feature title="实时推送与续传" body="公共行情与私有账户双 WebSocket，断线后按序号续传或重新同步。" />
          <Feature title="链上充提" body="区块扫描、确认数推进、链重组回滚；提现经人工审核后由托管广播。" />
          <Feature title="运营后台" body="ops-console 提供提现审核、对账、告警与单笔业务全链路追踪。" />
        </div>
      </section>

      <footer className="home-footer muted">
        仅用于学习与演示，所有资产均为测试数据。源码结构见仓库 README 与 docs/architecture.md。
      </footer>
    </div>
  );
}

function Feature(props: { title: string; body: string }) {
  return (
    <div className="feature">
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function MarketCard(props: { definition: MarketDefinition }) {
  const { state, api } = useExchange();
  const [points, setPoints] = useState<number[]>([]);
  const ticker = state.tickers[props.definition.market];
  const change = changeRatio(ticker?.lastPrice, ticker?.openPrice24h);
  const decimals = decimalsOf(props.definition.priceStep, 2);

  useEffect(() => {
    if (!api) {
      return;
    }
    const load = () =>
      api
        .market<Kline[]>(`/klines?market=${encodeURIComponent(props.definition.market)}&interval=1m&limit=60`)
        .then((items) =>
          setPoints(
            (Array.isArray(items) ? items : [])
              .slice()
              .sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime))
              .map((item) => Number(item.closePrice))
              .filter((value) => value > 0)
          )
        )
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [api, props.definition.market]);

  return (
    <a className="market-card" href={href(`/trade/${props.definition.market}`)}>
      <div className="mc-head">
        <AssetIcon asset={props.definition.baseAsset} size={30} />
        <div>
          <strong>{props.definition.baseAsset}</strong>
          <span className="muted">/{props.definition.quoteAsset}</span>
        </div>
        <span className={`mc-change ${trendClass(change)}`}>{formatPercent(change)}</span>
      </div>
      <div className="mc-price">
        {toNumber(ticker?.lastPrice) > 0 ? formatFixed(ticker?.lastPrice, decimals) : "--"}
      </div>
      <Sparkline points={points} trend={trendClass(change)} />
      <div className="mc-foot muted">24h 成交额 {formatCompact(ticker?.quoteVolume24h)} {props.definition.quoteAsset}</div>
    </a>
  );
}

function Sparkline(props: { points: number[]; trend: string }) {
  if (props.points.length < 2) {
    return <div className="sparkline empty">等待成交…</div>;
  }
  const min = Math.min(...props.points);
  const max = Math.max(...props.points);
  const range = max - min || 1;
  const width = 240;
  const height = 56;
  const path = props.points
    .map((value, index) => {
      const x = (index / (props.points.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className={`sparkline ${props.trend}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={`${path} L${width},${height} L0,${height} Z`} className="spark-fill" />
      <path d={path} className="spark-line" />
    </svg>
  );
}

// Layered architecture diagram: user -> access layer -> trading core -> funds.
const FLOW_ROWS: Array<{ title: string; services: ServiceKey[] }> = [
  { title: "接入层", services: ["trader-web", "api-gateway"] },
  { title: "交易层", services: ["risk-service", "order-service", "matching-engine", "settlement-service", "market-data-service"] },
  { title: "资金层", services: ["identity-service", "ledger-service", "wallet-service", "blockchain-indexer", "custody-adapter"] },
  { title: "演示环境", services: ["demo-simulator"] }
];

const ORDER_PATH: ServiceKey[] = [
  "trader-web",
  "api-gateway",
  "order-service",
  "risk-service",
  "ledger-service",
  "matching-engine",
  "settlement-service",
  "market-data-service"
];

function FlowDiagram() {
  const [active, setActive] = useState<ServiceKey>("order-service");
  const info = SERVICES[active];
  return (
    <div className="flow">
      <div className="flow-rows">
        {FLOW_ROWS.map((row) => (
          <div className="flow-row" key={row.title}>
            <span className="flow-layer">{row.title}</span>
            <div className="flow-nodes">
              {row.services.map((key) => {
                const step = ORDER_PATH.indexOf(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`flow-node ${active === key ? "active" : ""} ${step >= 0 ? "on-path" : ""}`}
                    onClick={() => setActive(key)}
                  >
                    {step >= 0 ? <span className="flow-step">{step + 1}</span> : null}
                    <b>{SERVICES[key].name}</b>
                    <span>{SERVICES[key].summary}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flow-detail">
        <span className="eyebrow">{info.layer}</span>
        <h3>{info.name}</h3>
        <strong>{info.summary}</strong>
        <p>{info.detail}</p>
        <code>{info.code}</code>
        <p className="muted small">带编号的服务构成「下单」主链：编号即请求经过的顺序。</p>
      </div>
    </div>
  );
}
