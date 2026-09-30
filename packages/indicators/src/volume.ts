import { assertPeriod, assertSameLength, nulls, type Series } from "./core";

/**
 * On-balance volume (TA-Lib OBV): starts at the first bar's volume, then adds or subtracts
 * each bar's volume as the close rises or falls.
 */
export function obv(close: readonly number[], volume: readonly number[]): Series {
  assertSameLength(close, volume);
  const out = nulls(close.length);
  if (close.length === 0) return out;
  let total = volume[0]!;
  out[0] = total;
  for (let i = 1; i < close.length; i += 1) {
    if (close[i]! > close[i - 1]!) total += volume[i]!;
    else if (close[i]! < close[i - 1]!) total -= volume[i]!;
    out[i] = total;
  }
  return out;
}

/**
 * Rolling volume-weighted average price over `period` daily bars, using the typical price
 * (high + low + close) / 3. Daily bars have no intraday trades, so this is the standard
 * approximation.
 */
export function vwap(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  volume: readonly number[],
  period = 20,
): Series {
  assertSameLength(high, low, close, volume);
  assertPeriod(period);
  const n = close.length;
  const out = nulls(n);
  for (let i = period - 1; i < n; i += 1) {
    let pv = 0;
    let v = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      pv += ((high[j]! + low[j]! + close[j]!) / 3) * volume[j]!;
      v += volume[j]!;
    }
    out[i] = v !== 0 ? pv / v : null;
  }
  return out;
}

/**
 * Relative strength against a benchmark (not RSI): the security's growth divided by the
 * benchmark's since the first bar, as an index starting at 100. Above 100 means it has
 * outperformed over the window shown.
 */
export function relativeStrength(close: readonly number[], benchmark: readonly number[]): Series {
  assertSameLength(close, benchmark);
  if (close.length === 0) return [];
  const c0 = close[0]!;
  const b0 = benchmark[0]!;
  return close.map((c, i) => {
    const b = benchmark[i]!;
    return c0 !== 0 && b !== 0 ? (c / c0 / (b / b0)) * 100 : null;
  });
}
