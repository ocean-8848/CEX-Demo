const DECIMAL_SCALE = 18n;
const DECIMAL_BASE = 10n ** DECIMAL_SCALE;

function normalizeFraction(fraction: string): string {
  if (fraction.length > Number(DECIMAL_SCALE)) {
    throw new Error("Amount exceeds supported scale of 18 decimals");
  }

  return fraction.padEnd(Number(DECIMAL_SCALE), "0");
}

export function toAtomicUnits(amount: string): bigint {
  const normalized = amount.trim();

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }

  const sign = normalized.startsWith("-") ? -1n : 1n;
  const absolute = sign === -1n ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = absolute.split(".");
  const value = BigInt(whole) * DECIMAL_BASE + BigInt(normalizeFraction(fraction));
  return value * sign;
}

export function fromAtomicUnits(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / DECIMAL_BASE;
  const fraction = absolute % DECIMAL_BASE;

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  return `${sign}${whole.toString()}.${fraction
    .toString()
    .padStart(Number(DECIMAL_SCALE), "0")
    .replace(/0+$/, "")}`;
}

export function addAmounts(left: string, right: string): string {
  return fromAtomicUnits(toAtomicUnits(left) + toAtomicUnits(right));
}

export function subtractAmounts(left: string, right: string): string {
  return fromAtomicUnits(toAtomicUnits(left) - toAtomicUnits(right));
}

export function multiplyAmounts(left: string, right: string): string {
  return fromAtomicUnits((toAtomicUnits(left) * toAtomicUnits(right)) / DECIMAL_BASE);
}

export function divideAmounts(left: string, right: string): string {
  const denominator = toAtomicUnits(right);
  if (denominator === 0n) {
    throw new Error("Division by zero");
  }

  return fromAtomicUnits((toAtomicUnits(left) * DECIMAL_BASE) / denominator);
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

export function floorAmountToStep(amount: string, step: string): string {
  const stepAtomic = toAtomicUnits(step);
  if (stepAtomic <= 0n) {
    throw new Error("Step must be greater than zero");
  }

  const valueAtomic = toAtomicUnits(amount);
  return fromAtomicUnits((valueAtomic / stepAtomic) * stepAtomic);
}

export function alignsToStep(amount: string, step: string): boolean {
  const stepAtomic = toAtomicUnits(step);
  if (stepAtomic <= 0n) {
    return false;
  }

  return toAtomicUnits(amount) % stepAtomic === 0n;
}
