import { useEffect, useMemo, useState } from "react";

import { Badge, Button, formatAmount, marketLabel, type Tone } from "@web3-cex/web-ui";

import { toUnits, type MatchOutcome } from "../../lib/match-explain.js";
import type { MatchReplay } from "../../state/store.js";

const STEP_MS = 1800;

const OUTCOME_TONE: Record<MatchOutcome, Tone> = {
  filled: "positive",
  resting: "info",
  rested_no_fill: "neutral",
  ioc_cancelled: "warning",
  ioc_no_liquidity: "warning",
  fok_rejected: "negative",
  rejected: "negative"
};

function ratio(part: string, whole: string): number {
  const total = toUnits(whole);
  if (total <= 0n) {
    return 0;
  }
  const value = Number((toUnits(part) * 10000n) / total) / 10000;
  return Math.max(0, Math.min(1, value));
}

// M3-4: step-by-step replay of how the user's last order walked the opposite
// book (price priority, then time priority) and what happened to the rest.
export function MatchReplayCard(props: { replay: MatchReplay; onClose: () => void }) {
  const { explanation } = props.replay;
  const steps = explanation.steps;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    setStep(0);
    setPlaying(true);
  }, [props.replay.orderId, props.replay.createdAt]);

  useEffect(() => {
    if (!playing || step >= steps.length - 1) {
      return;
    }
    const timer = window.setTimeout(() => setStep((current) => current + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step, steps.length]);

  const current = steps[Math.min(step, steps.length - 1)];
  // Levels whose fills have been "played" so far.
  const revealed = useMemo(() => {
    let through = -1;
    for (const item of steps.slice(0, step + 1)) {
      if (item.kind === "level" && item.levelIndex !== undefined) {
        through = Math.max(through, item.levelIndex);
      }
    }
    return through;
  }, [steps, step]);
  const finished = step >= steps.length - 1;
  const limitIndex =
    explanation.limitPrice !== undefined
      ? explanation.levels.findIndex((level) => level.state === "beyond_limit")
      : -1;
  const sideWord = explanation.side === "buy" ? "买入" : "卖出";

  return (
    <section className="match-replay" id="match-replay" aria-label="撮合过程回放">
      <header className="match-replay-head">
        <div>
          <strong>撮合过程回放</strong>
          <span>
            {sideWord} {formatAmount(explanation.quantity)} {marketLabel(props.replay.market)} ·{" "}
            {explanation.orderType === "market" ? "市价" : `限价 ${formatAmount(explanation.limitPrice, 2)}`} ·{" "}
            {explanation.timeInForce.toUpperCase()}
          </span>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭回放" onClick={props.onClose}>
          ✕
        </button>
      </header>

      <div className="match-book">
        <div className="match-book-caption">
          <span>对手盘 {explanation.bookSide === "asks" ? "卖盘（价低者优先）" : "买盘（价高者优先）"}</span>
          <span>挂单量 → 被吃掉</span>
        </div>
        {explanation.levels.length === 0 ? (
          <p className="muted match-empty">下单瞬间对手盘为空。</p>
        ) : (
          <ol>
            {explanation.levels.map((level, index) => {
              const played = index <= revealed && level.fills.length > 0;
              const active = current?.levelIndex === index;
              const base = toUnits(level.quantityBefore) > 0n ? level.quantityBefore : level.filled;
              return (
                <li
                  key={`${level.price}-${index}`}
                  className={[
                    "match-level",
                    `side-${explanation.bookSide}`,
                    played ? `is-${level.state}` : "",
                    active ? "is-active" : "",
                    level.state === "beyond_limit" ? "is-beyond" : ""
                  ].join(" ")}
                  data-level-state={played ? level.state : level.state === "beyond_limit" ? "beyond_limit" : "pending"}
                >
                  {index === limitIndex ? (
                    <div className="match-limit-line">限价 {formatAmount(explanation.limitPrice, 2)}</div>
                  ) : null}
                  <span className="match-price">{formatAmount(level.price, 2)}</span>
                  <span className="match-bar" title={`挂单 ${level.quantityBefore}`}>
                    <span className="match-bar-fill" style={{ width: `${played ? ratio(level.filled, base) * 100 : 0}%` }} />
                    <span className="match-bar-text">
                      {played ? `${formatAmount(level.filled)} / ${formatAmount(base)}` : formatAmount(base)}
                    </span>
                  </span>
                  <span className="match-tag">
                    {played
                      ? level.state === "swept"
                        ? `吃光 · ${level.fills.length} 笔`
                        : `部分 · ${level.fills.length} 笔`
                      : level.state === "beyond_limit"
                        ? "超出限价"
                        : level.fills.length > 0
                          ? "待撮合"
                          : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="match-step" aria-live="polite">
        <div className="match-step-head">
          <span className="match-step-index">
            {step + 1}/{steps.length}
          </span>
          <strong>{current?.title}</strong>
        </div>
        <p>{current?.detail}</p>
        {finished ? (
          <Badge tone={OUTCOME_TONE[explanation.outcome]}>{explanation.outcomeLabel}</Badge>
        ) : (
          <span className="muted">剩余待成交 {formatAmount(current?.remaining)}</span>
        )}
      </div>

      <div className="match-dots" aria-hidden="true">
        {steps.map((item, index) => (
          <span key={index} className={index <= step ? "on" : ""} title={item.title} />
        ))}
      </div>

      <footer className="match-controls">
        <Button size="sm" variant="ghost" disabled={step === 0} onClick={() => { setPlaying(false); setStep(step - 1); }}>
          上一步
        </Button>
        {finished ? (
          <Button size="sm" variant="ghost" onClick={() => { setStep(0); setPlaying(true); }}>
            重播
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setPlaying(!playing)}>
            {playing ? "暂停" : "播放"}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={finished} onClick={() => { setPlaying(false); setStep(step + 1); }}>
          下一步
        </Button>
      </footer>
    </section>
  );
}
