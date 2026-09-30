import { assertPeriod, nulls, type Series } from "./core";

/** Simple moving average (TA-Lib SMA). First value at index period - 1. */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average seeded with the simple average of the `period` values ending at
 * `seedEnd` (TA-Lib's default EMA seeding). Standalone EMA seeds at period - 1; MACD seeds its
 * fast average later, as TA-Lib does.
 */
export function emaSeeded(values: readonly number[], period: number, seedEnd: number): Series {
  assertPeriod(period);
  const out = nulls(values.length);
  if (seedEnd >= values.length || seedEnd < period - 1) return out;
  let sum = 0;
  for (let i = seedEnd - period + 1; i <= seedEnd; i += 1) sum += values[i]!;
  const k = 2 / (period + 1);
  let prev = sum / period;
  out[seedEnd] = prev;
  for (let i = seedEnd + 1; i < values.length; i += 1) {
    prev = (values[i]! - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

/** Exponential moving average (TA-Lib EMA): k = 2 / (period + 1), seeded with an SMA. */
export function ema(values: readonly number[], period: number): Series {
  return emaSeeded(values, period, period - 1);
}

/** Linearly weighted moving average (TA-Lib WMA): weights 1..period, newest heaviest. */
export function wma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out = nulls(values.length);
  const divisor = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < period; j += 1) sum += values[i - period + 1 + j]! * (j + 1);
    out[i] = sum / divisor;
  }
  return out;
}

/** Applies `fn` to the non-null tail of a series (for smoothing an indicator's output). */
export function onDefined(series: Series, fn: (values: number[]) => Series): Series {
  const start = series.findIndex((v) => v !== null);
  if (start < 0) return nulls(series.length);
  const tail = fn(series.slice(start) as number[]);
  return [...nulls(start), ...tail];
}
