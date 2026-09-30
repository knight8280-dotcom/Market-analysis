import { ema, sma } from "./averages";
import {
  assertPeriod,
  assertSameLength,
  highest,
  lowest,
  nulls,
  trueRange,
  type Series,
} from "./core";

export interface Bands {
  upper: Series;
  middle: Series;
  lower: Series;
}

/** Bollinger Bands (TA-Lib BBANDS, SMA middle): middle ± k population standard deviations. */
export function bollinger(close: readonly number[], period = 20, k = 2): Bands {
  assertPeriod(period);
  const n = close.length;
  const middle = sma(close, period);
  const out: Bands = { upper: nulls(n), middle, lower: nulls(n) };
  for (let i = period - 1; i < n; i += 1) {
    const mean = middle[i]!;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j += 1) sq += (close[j]! - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    out.upper[i] = mean + k * sd;
    out.lower[i] = mean - k * sd;
  }
  return out;
}

/**
 * Average True Range with Wilder smoothing (TA-Lib ATR). The first value, at index `period`,
 * is the simple average of the first `period` true ranges (which start at index 1).
 */
export function atr(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
): Series {
  assertSameLength(high, low, close);
  assertPeriod(period);
  const n = close.length;
  const out = nulls(n);
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += trueRange(high, low, close, i);
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i += 1) {
    prev = (prev * (period - 1) + trueRange(high, low, close, i)) / period;
    out[i] = prev;
  }
  return out;
}

/** Donchian channel: highest high and lowest low over `period`, and their midpoint. */
export function donchian(high: readonly number[], low: readonly number[], period = 20): Bands {
  assertSameLength(high, low);
  assertPeriod(period);
  const n = high.length;
  const out: Bands = { upper: nulls(n), middle: nulls(n), lower: nulls(n) };
  for (let i = period - 1; i < n; i += 1) {
    const u = highest(high, i, period);
    const l = lowest(low, i, period);
    out.upper[i] = u;
    out.lower[i] = l;
    out.middle[i] = (u + l) / 2;
  }
  return out;
}

/** Keltner channel: EMA(close, period) ± multiplier × ATR(atrPeriod). */
export function keltner(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 20,
  multiplier = 2,
  atrPeriod = 10,
): Bands {
  const middle = ema(close, period);
  const range = atr(high, low, close, atrPeriod);
  const n = close.length;
  const out: Bands = { upper: nulls(n), middle: nulls(n), lower: nulls(n) };
  for (let i = 0; i < n; i += 1) {
    const m = middle[i];
    const a = range[i];
    if (m === null || m === undefined || a === null || a === undefined) continue;
    out.middle[i] = m;
    out.upper[i] = m + multiplier * a;
    out.lower[i] = m - multiplier * a;
  }
  return out;
}

/**
 * Annualized rolling volatility: sample standard deviation of `period` daily log returns,
 * times √annualization. The first value needs period + 1 closes.
 */
export function rollingVolatility(
  close: readonly number[],
  period = 20,
  annualization = 252,
): Series {
  if (!Number.isInteger(period) || period < 2) throw new RangeError("period must be at least 2");
  const n = close.length;
  const out = nulls(n);
  const r = close.map((c, i) => (i === 0 ? 0 : Math.log(c / close[i - 1]!)));
  for (let i = period; i < n; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += r[j]!;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j += 1) sq += (r[j]! - mean) ** 2;
    out[i] = Math.sqrt(sq / (period - 1)) * Math.sqrt(annualization);
  }
  return out;
}
