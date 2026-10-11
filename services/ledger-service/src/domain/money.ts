const SCALE = 18n;
const BASE = 10n ** SCALE;

function normalizeFraction(fraction: string): string {
  if (fraction.length > Number(SCALE)) {
    throw new Error("Amount exceeds supported scale of 18 decimals");
  }

  return fraction.padEnd(Number(SCALE), "0");
}

export function toAtomicUnits(amount: string): bigint {
  const normalized = amount.trim();

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }

  const sign = normalized.startsWith("-") ? -1n : 1n;
  const absolute = sign === -1n ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = absolute.split(".");
  const value = BigInt(whole) * BASE + BigInt(normalizeFraction(fraction));
  return value * sign;
}

export function fromAtomicUnits(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / BASE;
  const fraction = absolute % BASE;

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  return `${sign}${whole.toString()}.${fraction
    .toString()
    .padStart(Number(SCALE), "0")
    .replace(/0+$/, "")}`;
}

export function addAmounts(left: string, right: string): string {
  return fromAtomicUnits(toAtomicUnits(left) + toAtomicUnits(right));
}

export function subtractAmounts(left: string, right: string): string {
  const result = toAtomicUnits(left) - toAtomicUnits(right);
  return fromAtomicUnits(result);
}

export function compareAmounts(left: string, right: string): number {
  const diff = toAtomicUnits(left) - toAtomicUnits(right);
  if (diff === 0n) {
    return 0;
  }

  return diff > 0n ? 1 : -1;
}

export function isPositiveAmount(amount: string): boolean {
  return compareAmounts(amount, "0") === 1;
}
