/**
 * Shared types and helpers. Every indicator takes plain number arrays (oldest first, one entry
 * per trading session, no gaps) and returns an array of the same length, with null for the
 * warm-up entries that do not have enough history yet. Warm-up lengths match TA-Lib's.
 */
export type Series = (number | null)[];

export interface Ohlcv {
  open: readonly number[];
  high: readonly number[];
  low: readonly number[];
  close: readonly number[];
  volume: readonly number[];
}

/** TA-Lib treats |x| < 1e-8 as zero when guarding divisions; so do we, to match it. */
export const EPSILON = 1e-8;
export const isZero = (x: number) => x > -EPSILON && x < EPSILON;

export function nulls(n: number): Series {
  return new Array<number | null>(n).fill(null);
}

export function assertPeriod(period: number, name = "period"): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} must be a positive integer (got ${period})`);
  }
}

export function assertSameLength(...arrays: readonly (readonly unknown[])[]): void {
  const n = arrays[0]?.length ?? 0;
  if (arrays.some((a) => a.length !== n)) throw new RangeError("input arrays differ in length");
}

/** Highest value in values[end - period + 1 .. end]. */
export function highest(values: readonly number[], end: number, period: number): number {
  let m = -Infinity;
  for (let i = end - period + 1; i <= end; i += 1) if (values[i]! > m) m = values[i]!;
  return m;
}

export function lowest(values: readonly number[], end: number, period: number): number {
  let m = Infinity;
  for (let i = end - period + 1; i <= end; i += 1) if (values[i]! < m) m = values[i]!;
  return m;
}

/** True range for index i >= 1 (TA-Lib TRANGE). */
export function trueRange(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  i: number,
): number {
  const prevClose = close[i - 1]!;
  return Math.max(
    high[i]! - low[i]!,
    Math.abs(high[i]! - prevClose),
    Math.abs(low[i]! - prevClose),
  );
}
