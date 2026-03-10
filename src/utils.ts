const YEAR_SECONDS = 365 * 24 * 60 * 60;

export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("median requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function bpsToDecimal(bps: number): number {
  return bps / 10_000;
}

export function decimalToBps(value: number): number {
  return value * 10_000;
}

export function toBase18(value: number): bigint {
  return BigInt(Math.round(value * 1e18));
}

export function fromBase18(value: bigint | string): number {
  const parsed = typeof value === "string" ? BigInt(value) : value;
  return Number(parsed) / 1e18;
}

export function yearsFromSeconds(seconds: number): number {
  return Math.max(0, seconds) / YEAR_SECONDS;
}

export function signedCarryPnlUsd(
  side: "LONG" | "SHORT",
  floatingApr: number,
  fixedApr: number,
  notionalUsd: number,
  elapsedSeconds: number,
): number {
  const aprSpread = side === "LONG" ? floatingApr - fixedApr : fixedApr - floatingApr;
  return notionalUsd * aprSpread * yearsFromSeconds(elapsedSeconds);
}

export function markToMarketPnlUsd(
  side: "LONG" | "SHORT",
  currentApr: number,
  entryApr: number,
  notionalUsd: number,
  remainingSeconds: number,
): number {
  const aprMove = side === "LONG" ? currentApr - entryApr : entryApr - currentApr;
  return notionalUsd * aprMove * yearsFromSeconds(remainingSeconds);
}
