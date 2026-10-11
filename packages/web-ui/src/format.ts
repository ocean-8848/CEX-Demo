// Display formatting helpers. Services return 18-decimal strings such as
// "3200.000000000000000000"; these helpers turn them into readable numbers
// without ever feeding display values back into order payloads.

const EMPTY = "--";

export function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") {
    return Number.NaN;
  }
  return typeof value === "number" ? value : Number(value);
}

/** Number of decimals implied by a step string such as "0.001" -> 3. */
export function decimalsOf(step: string | undefined, fallback = 2): number {
  if (!step) {
    return fallback;
  }
  const [, fraction = ""] = step.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length === 0 && Number(step) >= 1 ? 0 : Math.max(trimmed.length, 0);
}

/** Fixed decimals with thousands separators: 3200 -> "3,200.00". */
export function formatFixed(value: string | number | undefined | null, decimals: number): string {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric)) {
    return EMPTY;
  }
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

/** Trims trailing zeros, keeps up to `maxDecimals`: "5.500000000000000000" -> "5.5". */
export function formatAmount(
  value: string | number | undefined | null,
  maxDecimals = 8
): string {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric)) {
    return EMPTY;
  }
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals
  });
}

/** Compact notation for large volumes: 1234567 -> "1.23M". */
export function formatCompact(value: string | number | undefined | null): string {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric)) {
    return EMPTY;
  }
  if (Math.abs(numeric) < 10_000) {
    return formatAmount(numeric, 2);
  }
  return numeric.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  });
}

/** Signed percentage: 0.0123 -> "+1.23%". */
export function formatPercent(ratio: number | undefined | null, decimals = 2): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) {
    return EMPTY;
  }
  const sign = ratio > 0 ? "+" : "";
  return `${sign}${(ratio * 100).toFixed(decimals)}%`;
}

/** 24h change ratio from a ticker; null when there is no reference price. */
export function changeRatio(lastPrice?: string, openPrice?: string): number | null {
  const last = toNumber(lastPrice);
  const open = toNumber(openPrice);
  if (!Number.isFinite(last) || !Number.isFinite(open) || open <= 0 || last <= 0) {
    return null;
  }
  return (last - open) / open;
}

export function trendClass(value: number | null | undefined): "up" | "down" | "flat" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

export function formatTime(value: string | undefined): string {
  if (!value) {
    return EMPTY;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return EMPTY;
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDateTime(value: string | undefined): string {
  if (!value) {
    return EMPTY;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return EMPTY;
  }
  return `${date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  })} ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

/** 0x1234567890abcdef -> 0x1234…cdef */
export function shortHash(value: string | undefined, head = 6, tail = 4): string {
  if (!value) {
    return EMPTY;
  }
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Rounds a free-form numeric input down to a market step and returns a plain
 * decimal string suitable for an order payload ("0.123456" + step "0.001" -> "0.123").
 */
export function floorToStep(value: number, step: string): string {
  const decimals = decimalsOf(step, 8);
  const stepValue = Number(step);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(stepValue) || stepValue <= 0) {
    return "";
  }
  const factor = 10 ** decimals;
  const floored = Math.floor((value + Number.EPSILON) * factor) / factor;
  const stepped = Math.floor(floored / stepValue + 1e-9) * stepValue;
  return stepped > 0 ? stepped.toFixed(decimals) : "";
}

export function splitMarket(market: string): { base: string; quote: string } {
  const [base = market, quote = ""] = market.split("-");
  return { base, quote };
}

export function marketLabel(market: string): string {
  const { base, quote } = splitMarket(market);
  return quote ? `${base}/${quote}` : base;
}
