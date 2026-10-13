import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  Button,
  decimalsOf,
  floorToStep,
  formatAmount,
  formatFixed,
  splitMarket,
  toNumber
} from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { effectiveRateFor } from "../../lib/fee-tier.js";
import { availableOf } from "../../lib/records.js";
import { navigate } from "../../lib/router.js";
import { stopTriggerHint } from "../../lib/order-options.js";
import type { OrderSide, OrderType, StpMode, TimeInForce } from "../../lib/types.js";
import { useFeeTier } from "../../state/fee-tier.js";
import { useExchange } from "../../state/store.js";
import { useSystemControls } from "../../state/system-controls.js";
import { useDisplayPrice } from "./market-header.js";

const TIF_HELP: Record<TimeInForce, string> = {
  gtc: "GTC 一直有效：未成交部分挂在订单簿直到成交或撤单",
  ioc: "IOC 立即成交或取消：能成交多少成交多少，剩余立即撤销",
  fok: "FOK 全部成交或取消：不能一次全部成交就整单撤销"
};

const PERCENTS = [25, 50, 75, 100];

const STP_HELP: Record<StpMode, string> = {
  expire_taker: "自成交保护（默认）：会碰到自己的挂单时，保留挂单，新订单剩余部分过期",
  expire_maker: "自成交保护：撤掉自己的挂单，新订单继续和别人撮合",
  expire_both: "自成交保护：撤掉自己的挂单，新订单剩余部分也过期"
};

type FormMode = "limit" | "market" | "stop";

export function OrderForm(props: { pickedPrice?: { price: string; nonce: number } }) {
  const { state, actions, marketDefinition, assets } = useExchange();
  const { base, quote } = splitMarket(state.market);
  const priceDecimals = decimalsOf(marketDefinition?.priceStep, 2);
  const quantityStep = marketDefinition?.quantityStep ?? "0.001";
  const quantityDecimals = decimalsOf(quantityStep, 3);
  const minQuantity = toNumber(marketDefinition?.minQuantity ?? "0");
  const displayPrice = useDisplayPrice(state.market);
  const loggedIn = Boolean(state.token);
  const writeFrozen = Boolean(useSystemControls()?.apiWriteFrozen);

  const [side, setSide] = useState<OrderSide>("buy");
  const [mode, setMode] = useState<FormMode>("limit");
  const [stopKind, setStopKind] = useState<"stop_limit" | "stop_market">("stop_limit");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("gtc");
  const [postOnly, setPostOnly] = useState(false);
  const [stpMode, setStpMode] = useState<StpMode>("expire_taker");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [price, setPrice] = useState("");
  const type: OrderType = mode === "stop" ? stopKind : mode;
  // limit and stop_limit carry a limit price; market and stop_market do not.
  const limitPriced = type === "limit" || type === "stop_limit";
  const [quantity, setQuantity] = useState("");
  const [percent, setPercent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when switching markets; seed the price from the current market price.
  useEffect(() => {
    setPrice("");
    setTriggerPrice("");
    setQuantity("");
    setPercent(0);
    setError(null);
  }, [state.market]);

  useEffect(() => {
    if (!price && displayPrice) {
      setPrice(displayPrice.toFixed(priceDecimals));
    }
  }, [displayPrice, price, priceDecimals]);

  useEffect(() => {
    if (props.pickedPrice) {
      setMode("limit");
      setPrice(props.pickedPrice.price);
    }
  }, [props.pickedPrice]);

  const bestAsk = toNumber(state.depth.asks[0]?.price);
  const bestBid = toNumber(state.depth.bids[0]?.price);
  const triggerValue = toNumber(triggerPrice);
  const effectivePrice = limitPriced
    ? toNumber(price)
    : type === "stop_market"
      ? triggerValue
      : (side === "buy" ? bestAsk : bestBid) || displayPrice || 0;
  const quantityValue = toNumber(quantity);
  const total = effectivePrice > 0 && quantityValue > 0 ? effectivePrice * quantityValue : 0;
  const availableQuote = availableOf(assets, quote);
  const availableBase = availableOf(assets, base);
  const available = side === "buy" ? availableQuote : availableBase;

  const crosses =
    !limitPriced ||
    (side === "buy" ? bestAsk > 0 && toNumber(price) >= bestAsk : bestBid > 0 && toNumber(price) <= bestBid);
  const postOnlyActive = postOnly && type === "limit";
  // A post-only order that would cross is rejected by the engine, never a taker.
  const postOnlyWouldTake = postOnlyActive && crosses;
  // The user's own VIP rate for this market (min(tier, market)); market defaults when logged out.
  const feeTier = useFeeTier();
  const feeRate = effectiveRateFor(feeTier, state.market, crosses && !postOnlyActive ? "taker" : "maker", marketDefinition);
  const triggerHint = mode === "stop" ? stopTriggerHint(side, triggerValue, displayPrice || 0) : null;
  // Buyers pay the fee in the base asset they receive, sellers in quote.
  const estimatedFee = side === "sell" ? total * feeRate : quantityValue * feeRate;

  const validation = useMemo(() => {
    if (!quantity) {
      return null;
    }
    if (!(quantityValue > 0)) {
      return "请输入有效数量";
    }
    if (quantityValue < minQuantity) {
      return `最小下单量 ${formatAmount(minQuantity)} ${base}`;
    }
    if (mode === "stop" && !(triggerValue > 0)) {
      return "请输入有效触发价";
    }
    if (limitPriced && !(toNumber(price) > 0)) {
      return "请输入有效价格";
    }
    if (loggedIn && side === "buy" && limitPriced && total > availableQuote + 1e-9) {
      return `可用 ${quote} 不足`;
    }
    if (loggedIn && side === "sell" && quantityValue > availableBase + 1e-12) {
      return `可用 ${base} 不足`;
    }
    return null;
  }, [quantity, quantityValue, minQuantity, base, mode, triggerValue, limitPriced, price, loggedIn, side, total, availableQuote, availableBase, quote]);

  function applyPercent(value: number) {
    setPercent(value);
    const reference = effectivePrice;
    const maxQuantity = side === "buy" ? (reference > 0 ? availableQuote / reference : 0) : availableBase;
    setQuantity(floorToStep((maxQuantity * value) / 100, quantityStep));
  }

  function stepPrice(direction: 1 | -1) {
    const step = toNumber(marketDefinition?.priceStep ?? "0.01");
    const current = toNumber(price) || displayPrice || 0;
    setPrice(Math.max(current + direction * step, step).toFixed(priceDecimals));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loggedIn) {
      navigate("/login");
      return;
    }
    if (validation || !quantity) {
      setError(validation ?? "请输入数量");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await actions.placeOrder({
        side,
        type,
        timeInForce: limitPriced ? timeInForce : "ioc",
        price: limitPriced ? toNumber(price).toFixed(priceDecimals) : undefined,
        quantity: floorToStep(quantityValue, quantityStep),
        ...(postOnlyActive ? { postOnly: true } : {}),
        ...(stpMode !== "expire_taker" ? { stpMode } : {}),
        ...(mode === "stop" ? { triggerPrice: triggerValue.toFixed(priceDecimals) } : {})
      });
      setQuantity("");
      setPercent(0);
    } catch (submitError) {
      const message = readErrorMessage(submitError);
      setError(message);
      actions.toast("negative", "下单失败", message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={`order-form side-${side}`} id="order-form" onSubmit={submit} noValidate>
      <div className="side-switch" role="tablist">
        <button
          type="button"
          className={side === "buy" ? "active buy" : ""}
          onClick={() => {
            setSide("buy");
            setPercent(0);
          }}
          id="order-side-buy"
        >
          买入
        </button>
        <button
          type="button"
          className={side === "sell" ? "active sell" : ""}
          onClick={() => {
            setSide("sell");
            setPercent(0);
          }}
          id="order-side-sell"
        >
          卖出
        </button>
      </div>

      <div className="type-row">
        <div className="type-switch">
          <button type="button" className={mode === "limit" ? "active" : ""} onClick={() => setMode("limit")}>
            限价
          </button>
          <button type="button" className={mode === "market" ? "active" : ""} onClick={() => setMode("market")} id="order-type-market">
            市价
          </button>
          <button type="button" className={mode === "stop" ? "active" : ""} onClick={() => setMode("stop")} id="order-type-stop">
            止损
          </button>
        </div>
        {mode === "stop" ? (
          <select
            name="stopKind"
            id="order-stop-kind"
            value={stopKind}
            onChange={(event) => setStopKind(event.target.value as "stop_limit" | "stop_market")}
            className="tif-select"
            title="止损限价：触发后按限价挂单；止损市价：触发后按市价成交"
          >
            <option value="stop_limit">止损限价</option>
            <option value="stop_market">止损市价</option>
          </select>
        ) : null}
        {limitPriced ? (
          <select
            name="timeInForce"
            value={timeInForce}
            onChange={(event) => {
              const next = event.target.value as TimeInForce;
              setTimeInForce(next);
              if (next !== "gtc") {
                setPostOnly(false);
              }
            }}
            title={TIF_HELP[timeInForce]}
            className="tif-select"
          >
            <option value="gtc">GTC</option>
            <option value="ioc">IOC</option>
            <option value="fok">FOK</option>
          </select>
        ) : null}
      </div>

      {type === "limit" ? (
        <div className="option-row">
          <label title="只做 Maker：如果下单时会立即和对手盘成交，撮合引擎整单拒绝，保证只挂单、只付 Maker 费率">
            <input
              type="checkbox"
              id="order-post-only"
              checked={postOnly}
              onChange={(event) => {
                setPostOnly(event.target.checked);
                if (event.target.checked) {
                  setTimeInForce("gtc");
                }
              }}
            />
            只做 Maker
          </label>
          <select
            name="stpMode"
            id="order-stp-mode"
            className="tif-select"
            value={stpMode}
            onChange={(event) => setStpMode(event.target.value as StpMode)}
            title={STP_HELP[stpMode]}
          >
            <option value="expire_taker">STP：保留挂单</option>
            <option value="expire_maker">STP：撤旧挂单</option>
            <option value="expire_both">STP：双方过期</option>
          </select>
        </div>
      ) : null}

      <div className="avail">
        <span>可用</span>
        <b id="order-available">
          {loggedIn ? `${formatAmount(available, side === "buy" ? 2 : quantityDecimals)} ${side === "buy" ? quote : base}` : "--"}
        </b>
      </div>

      {mode === "stop" ? (
        <div className="input-group">
          <span className="ig-label">触发价</span>
          <input
            id="order-trigger-price-input"
            name="triggerPrice"
            inputMode="decimal"
            autoComplete="off"
            placeholder={side === "buy" ? "最新价 ≥ 触发价时提交" : "最新价 ≤ 触发价时提交"}
            value={triggerPrice}
            onChange={(event) => setTriggerPrice(event.target.value.replace(/[^\d.]/g, ""))}
          />
          <span className="ig-suffix">{quote}</span>
        </div>
      ) : null}

      {limitPriced ? (
        <div className="input-group">
          <span className="ig-label">{mode === "stop" ? "委托价" : "价格"}</span>
          <input
            id="order-price-input"
            name="price"
            inputMode="decimal"
            autoComplete="off"
            value={price}
            onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ""))}
          />
          <span className="ig-suffix">{quote}</span>
          <span className="ig-steppers">
            <button type="button" onClick={() => stepPrice(1)} aria-label="加价">
              ▲
            </button>
            <button type="button" onClick={() => stepPrice(-1)} aria-label="减价">
              ▼
            </button>
          </span>
        </div>
      ) : (
        <div className="input-group disabled">
          <span className="ig-label">价格</span>
          <input value={mode === "stop" ? "触发后以市场最优价成交" : "以市场最优价成交"} disabled />
          <span className="ig-suffix">{quote}</span>
        </div>
      )}

      <div className="input-group">
        <span className="ig-label">数量</span>
        <input
          id="order-quantity-input"
          name="quantity"
          inputMode="decimal"
          autoComplete="off"
          placeholder={`最小 ${formatAmount(minQuantity)}`}
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value.replace(/[^\d.]/g, ""));
            setPercent(0);
          }}
        />
        <span className="ig-suffix">{base}</span>
      </div>

      <div className="percent-row">
        {PERCENTS.map((value) => (
          <button
            key={value}
            type="button"
            className={percent === value ? "active" : ""}
            onClick={() => applyPercent(value)}
            disabled={!loggedIn}
          >
            {value}%
          </button>
        ))}
      </div>

      <dl className="order-summary">
        <div>
          <dt>{limitPriced ? "成交额" : "预估成交额"}</dt>
          <dd id="order-total">{total > 0 ? `${formatFixed(total, 2)} ${quote}` : "--"}</dd>
        </div>
        <div>
          <dt>预估手续费</dt>
          <dd id="order-fee-estimate" title={feeTier ? `${feeTier.tier} 等级费率（min(等级费率, 市场费率)）` : "市场默认费率"}>
            {total > 0
              ? `${formatAmount(estimatedFee, side === "sell" ? 4 : 8)} ${side === "sell" ? quote : base} (${feeTier ? `${feeTier.tier} ` : ""}${crosses && !postOnlyActive ? "Taker" : "Maker"} ${(feeRate * 100).toFixed(2)}%)`
              : `${feeTier ? `${feeTier.tier} ` : ""}${crosses && !postOnlyActive ? "Taker" : "Maker"} ${(feeRate * 100).toFixed(2)}%`}
          </dd>
        </div>
      </dl>

      {writeFrozen ? (
        <div className="form-error" role="status" id="order-frozen-notice">
          平台处于只读模式（运营开启了 API 写入冻结）：暂时不能下新单，已有挂单仍可撤销。
        </div>
      ) : null}

      {postOnlyWouldTake && !error && !validation ? (
        <div className="form-error" role="status" id="order-post-only-warning">
          当前价格会立即与对手盘成交，只做 Maker 单将被撮合引擎拒绝
        </div>
      ) : null}

      {error || validation ? (
        <div className="form-error" role="alert">
          {error ?? validation}
        </div>
      ) : null}

      {loggedIn ? (
        <Button
          type="submit"
          variant={side}
          size="lg"
          block
          loading={submitting}
          disabled={writeFrozen}
          id="order-submit"
        >
          {side === "buy" ? "买入" : "卖出"} {base}
        </Button>
      ) : (
        <Button variant="primary" size="lg" block onClick={() => navigate("/login")}>
          登录后交易
        </Button>
      )}

      <p className="form-note">
        {mode === "stop"
          ? `${triggerHint ?? "止损单先冻结资金、显示为「待触发」，最新成交价触及触发价后才进入撮合引擎"}；触发前可随时撤单`
          : type === "limit"
            ? postOnlyActive
              ? "只做 Maker：只挂单不吃单，会立即成交就整单拒绝"
              : TIF_HELP[timeInForce]
            : "市价单按对手盘最优价逐档成交，未成交部分立即撤销（IOC）"}
      </p>
    </form>
  );
}
