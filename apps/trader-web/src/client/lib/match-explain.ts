// M3-4 "how did my order match?" — pure logic, no React.
//
// Given the opposite side of the order book captured just before submission
// and the trades the new order produced as taker, rebuild the walk the
// matching engine did: price priority (best opposite level first) then time
// priority (earlier resting orders at the same price first), and what happened
// to the remainder (rests in the book / IOC cancelled / FOK rejected).
//
// Amounts are 18-decimal strings from the services; all math uses bigint.

import { describeOrderReason } from "./order-options.js";
import type { DepthLevel, DepthSnapshot, OrderSide } from "./types.js";

const SCALE = 18;
const BASE = 10n ** BigInt(SCALE);

export function toUnits(value: string | number | undefined | null): bigint {
  if (value === undefined || value === null || value === "") {
    return 0n;
  }
  const text = String(value).trim();
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^[-+]/, "").split(".");
  const units =
    BigInt(whole || "0") * BASE + BigInt((fraction + "0".repeat(SCALE)).slice(0, SCALE) || "0");
  return negative ? -units : units;
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / BASE;
  const fraction = (absolute % BASE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export interface MatchOrderInput {
  side: OrderSide;
  type?: "limit" | "market";
  timeInForce?: "gtc" | "ioc" | "fok";
  price?: string;
  quantity: string;
  filledQuantity?: string;
  status?: string;
  rejectedReason?: string;
}

export interface MatchTradeInput {
  tradeId?: string;
  price?: string;
  quantity?: string;
  executedAt?: string;
  executionSequence?: number;
}

export type LevelState = "swept" | "partial" | "untouched" | "beyond_limit";

export interface MatchFill {
  /** 1-based position among all fills of this order. */
  sequence: number;
  price: string;
  quantity: string;
  /** 1-based position of the maker order within its price level (time priority). */
  queuePosition: number;
}

export interface ExplainedLevel {
  price: string;
  quantityBefore: string;
  orderCountBefore?: number;
  filled: string;
  remainingAfter: string;
  fills: MatchFill[];
  state: LevelState;
  /** The level was hit but did not exist in the pre-trade snapshot (book moved). */
  missingFromSnapshot?: boolean;
}

export type MatchOutcome =
  | "filled"
  | "resting"
  | "rested_no_fill"
  | "ioc_cancelled"
  | "ioc_no_liquidity"
  | "fok_rejected"
  | "rejected";

export interface MatchStep {
  kind: "intro" | "level" | "stop" | "outcome";
  title: string;
  detail: string;
  /** Index into `levels` the step focuses on. */
  levelIndex?: number;
  /** Quantity the taker still needs after this step. */
  remaining: string;
}

export interface MatchExplanation {
  side: OrderSide;
  bookSide: "asks" | "bids";
  orderType: "limit" | "market";
  timeInForce: "gtc" | "ioc" | "fok";
  limitPrice?: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  averagePrice?: string;
  quoteAmount: string;
  /** Opposite-side quantity inside the limit in the pre-trade snapshot. */
  availableWithinLimit: string;
  levels: ExplainedLevel[];
  fills: MatchFill[];
  outcome: MatchOutcome;
  outcomeLabel: string;
  steps: MatchStep[];
}

/** Opposite levels sorted by price priority for a taker on `side`. */
export function oppositeLevels(depth: DepthSnapshot, side: OrderSide): DepthLevel[] {
  const levels = side === "buy" ? depth.asks : depth.bids;
  return [...(levels ?? [])]
    .filter((level) => toUnits(level.quantity) > 0n)
    .sort((left, right) => {
      const diff = toUnits(left.price) - toUnits(right.price);
      const ordered = side === "buy" ? diff : -diff;
      return ordered > 0n ? 1 : ordered < 0n ? -1 : 0;
    });
}

/** A level is within the limit when a buyer pays <= limit or a seller gets >= limit. */
function withinLimit(side: OrderSide, levelPrice: bigint, limit: bigint | undefined): boolean {
  if (limit === undefined) {
    return true;
  }
  return side === "buy" ? levelPrice <= limit : levelPrice >= limit;
}

function compareTrades(left: MatchTradeInput, right: MatchTradeInput): number {
  if (left.executionSequence !== undefined && right.executionSequence !== undefined) {
    return left.executionSequence - right.executionSequence;
  }
  return 0;
}

export function explainMatch(input: {
  order: MatchOrderInput;
  trades: MatchTradeInput[];
  depthBefore: DepthSnapshot;
  /** Extra untouched levels to show after the last one hit. */
  contextLevels?: number;
}): MatchExplanation {
  const { order } = input;
  const side = order.side;
  const orderType = order.type === "market" ? "market" : "limit";
  const timeInForce = orderType === "market" ? "ioc" : (order.timeInForce ?? "gtc");
  const limit = orderType === "limit" && order.price ? toUnits(order.price) : undefined;
  const quantity = toUnits(order.quantity);

  // Stable sort keeps the service's order when no sequence is available.
  const trades = [...input.trades]
    .filter((trade) => toUnits(trade.quantity) > 0n)
    .map((trade, index) => ({ trade, index }))
    .sort((left, right) => compareTrades(left.trade, right.trade) || left.index - right.index)
    .map((item) => item.trade);

  const levels: ExplainedLevel[] = oppositeLevels(input.depthBefore, side).map((level) => ({
    price: fromUnits(toUnits(level.price)),
    quantityBefore: fromUnits(toUnits(level.quantity)),
    orderCountBefore: level.orderCount,
    filled: "0",
    remainingAfter: fromUnits(toUnits(level.quantity)),
    fills: [],
    state: "untouched"
  }));

  const fills: MatchFill[] = [];
  let filledUnits = 0n;
  let quoteUnits = 0n;
  for (const trade of trades) {
    const priceUnits = toUnits(trade.price);
    const qtyUnits = toUnits(trade.quantity);
    let level = levels.find((item) => toUnits(item.price) === priceUnits);
    if (!level) {
      level = {
        price: fromUnits(priceUnits),
        quantityBefore: "0",
        filled: "0",
        remainingAfter: "0",
        fills: [],
        state: "untouched",
        missingFromSnapshot: true
      };
      levels.push(level);
    }
    const fill: MatchFill = {
      sequence: fills.length + 1,
      price: fromUnits(priceUnits),
      quantity: fromUnits(qtyUnits),
      queuePosition: level.fills.length + 1
    };
    level.fills.push(fill);
    level.filled = fromUnits(toUnits(level.filled) + qtyUnits);
    fills.push(fill);
    filledUnits += qtyUnits;
    quoteUnits += (priceUnits * qtyUnits) / BASE;
  }

  // Re-sort in case synthetic levels were appended, then classify each level.
  levels.sort((left, right) => {
    const diff = toUnits(left.price) - toUnits(right.price);
    const ordered = side === "buy" ? diff : -diff;
    return ordered > 0n ? 1 : ordered < 0n ? -1 : 0;
  });
  for (const level of levels) {
    const before = toUnits(level.quantityBefore);
    const filled = toUnits(level.filled);
    const remaining = before > filled ? before - filled : 0n;
    level.remainingAfter = fromUnits(remaining);
    if (filled > 0n) {
      level.state = remaining === 0n ? "swept" : "partial";
    } else if (!withinLimit(side, toUnits(level.price), limit)) {
      level.state = "beyond_limit";
    }
  }

  const withinLimitLevels = levels.filter(
    (level) => !level.missingFromSnapshot && withinLimit(side, toUnits(level.price), limit)
  );
  const availableWithinLimit = withinLimitLevels.reduce(
    (sum, level) => sum + toUnits(level.quantityBefore),
    0n
  );

  // Show every level that was hit (for FOK: every level inside the limit),
  // plus a little context after it.
  const lastHit = levels.reduce((last, level, index) => (level.fills.length > 0 ? index : last), -1);
  const core = Math.max(lastHit + 1, timeInForce === "fok" ? withinLimitLevels.length : 0);
  const shown = levels.slice(0, Math.min(core + (input.contextLevels ?? 2), levels.length));

  const reportedFilled =
    order.filledQuantity !== undefined ? toUnits(order.filledQuantity) : filledUnits;
  const filled = reportedFilled > filledUnits ? reportedFilled : filledUnits;
  const remaining = quantity > filled ? quantity - filled : 0n;
  const outcome = resolveOutcome(order.status, timeInForce, filled, remaining);

  const explanation: MatchExplanation = {
    side,
    bookSide: side === "buy" ? "asks" : "bids",
    orderType,
    timeInForce,
    limitPrice: limit !== undefined ? fromUnits(limit) : undefined,
    quantity: fromUnits(quantity),
    filledQuantity: fromUnits(filled),
    remainingQuantity: fromUnits(remaining),
    averagePrice: filledUnits > 0n ? fromUnits((quoteUnits * BASE) / filledUnits) : undefined,
    quoteAmount: fromUnits(quoteUnits),
    availableWithinLimit: fromUnits(availableWithinLimit),
    levels: shown,
    fills,
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    steps: []
  };
  explanation.steps = buildSteps(explanation, order, levels);
  return explanation;
}

const OUTCOME_LABELS: Record<MatchOutcome, string> = {
  filled: "全部成交",
  resting: "部分成交，剩余挂入订单簿",
  rested_no_fill: "未成交，整单挂入订单簿",
  ioc_cancelled: "部分成交，剩余按 IOC 撤销",
  ioc_no_liquidity: "无可成交对手盘，按 IOC 撤销",
  fok_rejected: "无法一次全部成交，按 FOK 整单拒绝",
  rejected: "委托被拒绝"
};

function resolveOutcome(
  status: string | undefined,
  timeInForce: "gtc" | "ioc" | "fok",
  filled: bigint,
  remaining: bigint
): MatchOutcome {
  if (status === "rejected") {
    if (filled > 0n) {
      return "ioc_cancelled";
    }
    if (timeInForce === "fok") {
      return "fok_rejected";
    }
    return timeInForce === "ioc" ? "ioc_no_liquidity" : "rejected";
  }
  if (remaining === 0n && filled > 0n) {
    return "filled";
  }
  if (status === "cancelled") {
    return filled > 0n ? "ioc_cancelled" : "ioc_no_liquidity";
  }
  if (timeInForce === "ioc") {
    return filled > 0n ? "ioc_cancelled" : "ioc_no_liquidity";
  }
  if (timeInForce === "fok" && remaining > 0n) {
    return "fok_rejected";
  }
  return filled > 0n ? "resting" : "rested_no_fill";
}

function sideWord(side: OrderSide): string {
  return side === "buy" ? "买入" : "卖出";
}

function buildSteps(
  explanation: MatchExplanation,
  order: MatchOrderInput,
  allLevels: ExplainedLevel[]
): MatchStep[] {
  const steps: MatchStep[] = [];
  const bookName = explanation.bookSide === "asks" ? "卖盘（asks）" : "买盘（bids）";
  const direction =
    explanation.bookSide === "asks" ? "从最低卖价往上" : "从最高买价往下";
  const priceText =
    explanation.orderType === "market"
      ? "市价（不限价，吃到数量满足或对手盘耗尽）"
      : `限价 ${explanation.limitPrice}（${explanation.timeInForce.toUpperCase()}）`;
  steps.push({
    kind: "intro",
    title: `新订单：${sideWord(explanation.side)} ${explanation.quantity} · ${priceText}`,
    detail: `撮合引擎拿它去对手方的${bookName}匹配：先按价格优先${direction}逐档成交，同一价位内按挂单时间先后（时间优先）依次成交。`,
    remaining: explanation.quantity
  });

  let remaining = toUnits(explanation.quantity);
  explanation.levels.forEach((level, index) => {
    if (level.fills.length === 0) {
      return;
    }
    remaining -= toUnits(level.filled);
    const queue =
      level.fills.length > 1
        ? `该价位依次吃掉 ${level.fills.length} 笔挂单（时间优先：先挂的先成交）`
        : "吃掉该价位排在最前面的挂单";
    const left =
      level.state === "swept"
        ? "这一档被吃光"
        : `这一档还剩 ${level.remainingAfter} 继续挂着`;
    steps.push({
      kind: "level",
      title: `第 ${index + 1} 档 @ ${level.price}：成交 ${level.filled}`,
      detail: `${queue}：${level.fills
        .map((fill) => `${fill.price} × ${fill.quantity}`)
        .join("，")}。${left}；新订单还差 ${fromUnits(remaining > 0n ? remaining : 0n)}。${
        level.missingFromSnapshot ? "（下单瞬间盘口已变化，这一档不在下单前的快照里）" : ""
      }`,
      levelIndex: index,
      remaining: fromUnits(remaining > 0n ? remaining : 0n)
    });
  });

  const remainingQty = toUnits(explanation.remainingQuantity);
  if (remainingQty > 0n && explanation.outcome !== "fok_rejected") {
    const nextIndex = explanation.levels.findIndex(
      (level) => level.fills.length === 0 && !level.missingFromSnapshot
    );
    const next = nextIndex >= 0 ? explanation.levels[nextIndex] : undefined;
    const hasMoreBook = allLevels.some((level) => level.state !== "swept" && level.fills.length === 0);
    let detail: string;
    if (next && next.state === "beyond_limit") {
      detail = `下一档价格 ${next.price} ${explanation.side === "buy" ? "高于" : "低于"}限价 ${explanation.limitPrice}，价格条件不满足，停止撮合。`;
    } else if (!hasMoreBook) {
      detail = "对手盘已被吃空，没有更多可成交的挂单。";
    } else {
      detail = "可成交的对手盘已经用完（盘口在下单瞬间可能有变化）。";
    }
    steps.push({
      kind: "stop",
      title: `停止撮合，剩余 ${explanation.remainingQuantity}`,
      detail,
      levelIndex: next ? nextIndex : undefined,
      remaining: explanation.remainingQuantity
    });
  }

  steps.push({
    kind: "outcome",
    title: `结果：${explanation.outcomeLabel}`,
    detail: describeOutcome(explanation, order),
    remaining: explanation.outcome === "resting" || explanation.outcome === "rested_no_fill"
      ? explanation.remainingQuantity
      : "0"
  });
  return steps;
}

function describeOutcome(explanation: MatchExplanation, order: MatchOrderInput): string {
  const average = explanation.averagePrice ? `，成交均价 ${explanation.averagePrice}` : "";
  const own = explanation.side === "buy" ? "买盘" : "卖盘";
  switch (explanation.outcome) {
    case "filled":
      return `共成交 ${explanation.filledQuantity}（${explanation.fills.length} 笔）${average}。订单结束，冻结资金按成交结算，多冻结的部分退回可用。`;
    case "resting":
      return `已成交 ${explanation.filledQuantity}${average}；剩余 ${explanation.remainingQuantity} 以限价 ${explanation.limitPrice} 挂入${own}，成为新的挂单（Maker），等待后来的对手单。`;
    case "rested_no_fill":
      return `限价 ${explanation.limitPrice} 与对手盘最优价不交叉，没有成交；整单 ${explanation.remainingQuantity} 挂入${own}等待成交。`;
    case "ioc_cancelled":
      return `已成交 ${explanation.filledQuantity}${average}；IOC（立即成交否则取消）不允许挂单，剩余 ${explanation.remainingQuantity} 被撤销，对应冻结资金解冻。`;
    case "ioc_no_liquidity":
      return "IOC / 市价单不会挂单：没有满足价格条件的对手盘，整单撤销并解冻资金。";
    case "fok_rejected":
      return `FOK（全部成交否则取消）要求一次成交全部 ${explanation.quantity}；下单前限价范围内的对手盘只有 ${explanation.availableWithinLimit}，不够，所以一笔也不成交、整单拒绝并解冻资金。`;
    default:
      return order.rejectedReason ? `拒绝原因：${describeOrderReason(order.rejectedReason)}` : "委托没有进入撮合。";
  }
}
