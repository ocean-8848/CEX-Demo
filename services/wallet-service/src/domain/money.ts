const DECIMAL_SCALE = 18n;
const DECIMAL_FACTOR = 10n ** DECIMAL_SCALE;

function normalizeParts(amount: string): { sign: bigint; whole: string; fractional: string } {
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  const sign = trimmed.startsWith("-") ? -1n : 1n;
  const normalized = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  const parts = normalized.split(".");
  const whole = parts[0] ?? "0";
  const fractional = parts[1] ?? "";

  if (fractional.length > Number(DECIMAL_SCALE)) {
    throw new Error(`Amount exceeds supported precision: ${amount}`);
  }

  return {
    sign,
    whole,
    fractional: fractional.padEnd(Number(DECIMAL_SCALE), "0")
  };
}

export function toAtomicUnits(amount: string): bigint {
  const { sign, whole, fractional } = normalizeParts(amount);
  return sign * (BigInt(whole) * DECIMAL_FACTOR + BigInt(fractional));
}

export function fromAtomicUnits(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / DECIMAL_FACTOR;
  const fractional = absolute % DECIMAL_FACTOR;
  const trimmedFractional = fractional.toString().padStart(Number(DECIMAL_SCALE), "0").replace(/0+$/, "");

  return trimmedFractional.length > 0 ? `${sign}${whole}.${trimmedFractional}` : `${sign}${whole}`;
}

export function addAmounts(left: string, right: string): string {
  return fromAtomicUnits(toAtomicUnits(left) + toAtomicUnits(right));
}

export function compareAmounts(left: string, right: string): number {
  const delta = toAtomicUnits(left) - toAtomicUnits(right);
  if (delta === 0n) {
    return 0;
  }

  return delta > 0n ? 1 : -1;
}

export function sumAmounts(amounts: Iterable<string>): string {
  let total = 0n;
  for (const amount of amounts) {
    total += toAtomicUnits(amount);
  }

  return fromAtomicUnits(total);
}

export function isPositiveOrZero(amount: string): boolean {
  return toAtomicUnits(amount) >= 0n;
}
