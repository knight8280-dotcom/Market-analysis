import { emaSeeded, onDefined, sma } from "./averages";
import {
  assertPeriod,
  assertSameLength,
  highest,
  isZero,
  lowest,
  nulls,
  type Series,
} from "./core";

/**
 * Relative Strength Index with Wilder smoothing (TA-Lib RSI). The first value, at index
 * `period`, averages the first `period` changes; flat prices give 0, as in TA-Lib.
 */
export function rsi(close: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out = nulls(close.length);
  if (close.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = close[i]! - close[i - 1]!;
    if (d < 0) loss -= d;
    else gain += d;
  }
  gain /= period;
  loss /= period;
  const value = () => (isZero(gain + loss) ? 0 : (100 * gain) / (gain + loss));
  out[period] = value();
  for (let i = period + 1; i < close.length; i += 1) {
    const d = close[i]! - close[i - 1]!;
    gain *= period - 1;
    loss *= period - 1;
    if (d < 0) loss -= d;
    else gain += d;
    gain /= period;
    loss /= period;
    out[i] = value();
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/**
 * MACD (TA-Lib MACD). As in TA-Lib, both averages are seeded at the slow average's first
 * index, and all three outputs start once the signal line has warmed up (index 33 for 12/26/9).
 */
export function macd(close: readonly number[], fast = 12, slow = 26, signal = 9): MacdResult {
  assertPeriod(fast, "fast");
  assertPeriod(slow, "slow");
  assertPeriod(signal, "signal");
  if (fast > slow) [fast, slow] = [slow, fast];
  const n = close.length;
  const start = slow - 1;
  const fastEma = emaSeeded(close, fast, start);
  const slowEma = emaSeeded(close, slow, start);
  const line: Series = nulls(n);
  for (let i = start; i < n; i += 1) line[i] = fastEma[i]! - slowEma[i]!;
  const sig = onDefined(line, (v) => emaSeeded(v, signal, signal - 1));
  const first = start + signal - 1;
  const out: MacdResult = { macd: nulls(n), signal: nulls(n), histogram: nulls(n) };
  for (let i = first; i < n; i += 1) {
    out.macd[i] = line[i]!;
    out.signal[i] = sig[i]!;
    out.histogram[i] = line[i]! - sig[i]!;
  }
  return out;
}

export interface StochasticResult {
  k: Series;
  d: Series;
}

/**
 * Slow stochastic (TA-Lib STOCH with SMA smoothing): raw %K over `kPeriod`, smoothed over
 * `kSmoothing` into %K, and %K averaged over `dPeriod` into %D. Both lines start together, at
 * index kPeriod + kSmoothing + dPeriod - 3, as in TA-Lib.
 */
export function stochastic(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  kPeriod = 14,
  kSmoothing = 3,
  dPeriod = 3,
): StochasticResult {
  assertSameLength(high, low, close);
  assertPeriod(kPeriod, "kPeriod");
  assertPeriod(kSmoothing, "kSmoothing");
  assertPeriod(dPeriod, "dPeriod");
  const n = close.length;
  const fastK: Series = nulls(n);
  for (let i = kPeriod - 1; i < n; i += 1) {
    const hh = highest(high, i, kPeriod);
    const ll = lowest(low, i, kPeriod);
    const range = hh - ll;
    fastK[i] = range !== 0 ? ((close[i]! - ll) / range) * 100 : 0;
  }
  const k = onDefined(fastK, (v) => sma(v, kSmoothing));
  const d = onDefined(k, (v) => sma(v, dPeriod));
  const first = kPeriod + kSmoothing + dPeriod - 3;
  const out: StochasticResult = { k: nulls(n), d: nulls(n) };
  for (let i = first; i < n; i += 1) {
    out.k[i] = k[i]!;
    out.d[i] = d[i]!;
  }
  return out;
}

/** Williams %R (TA-Lib WILLR): 0 at the period high, -100 at the period low. */
export function williamsR(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
): Series {
  assertSameLength(high, low, close);
  assertPeriod(period);
  const out = nulls(close.length);
  for (let i = period - 1; i < close.length; i += 1) {
    const hh = highest(high, i, period);
    const ll = lowest(low, i, period);
    const range = hh - ll;
    out[i] = range !== 0 ? ((hh - close[i]!) / range) * -100 : 0;
  }
  return out;
}

/** Commodity Channel Index (TA-Lib CCI) on the typical price, with the 0.015 constant. */
export function cci(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 20,
): Series {
  assertSameLength(high, low, close);
  assertPeriod(period);
  const n = close.length;
  const tp = close.map((c, i) => (high[i]! + low[i]! + c) / 3);
  const out = nulls(n);
  for (let i = period - 1; i < n; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += tp[j]!;
    const avg = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j += 1) dev += Math.abs(tp[j]! - avg);
    dev /= period;
    const diff = tp[i]! - avg;
    out[i] = diff !== 0 && dev !== 0 ? diff / (0.015 * dev) : 0;
  }
  return out;
}
