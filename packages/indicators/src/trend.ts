import { assertPeriod, assertSameLength, isZero, nulls, trueRange, type Series } from "./core";

/**
 * Directional movement for bar i: +DM when the up-move is positive and larger than the
 * down-move, -DM in the mirror case, else neither (TA-Lib's rule).
 */
function directional(high: readonly number[], low: readonly number[], i: number) {
  const up = high[i]! - high[i - 1]!;
  const down = low[i - 1]! - low[i]!;
  if (down > 0 && up < down) return { plus: 0, minus: down };
  if (up > 0 && up > down) return { plus: up, minus: 0 };
  return { plus: 0, minus: 0 };
}

export interface DirectionalResult {
  plusDI: Series;
  minusDI: Series;
  adx: Series;
}

/**
 * Wilder's directional system (TA-Lib PLUS_DI, MINUS_DI, ADX). +DI and -DI start at index
 * `period`; ADX, the Wilder average of DX, starts at 2 × period - 1.
 */
export function directionalMovement(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
): DirectionalResult {
  assertSameLength(high, low, close);
  assertPeriod(period);
  const n = close.length;
  const out: DirectionalResult = { plusDI: nulls(n), minusDI: nulls(n), adx: nulls(n) };
  if (n <= period) return out;

  // Sums of the first period - 1 moves, then Wilder smoothing from bar `period` on.
  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;
  for (let i = 1; i < period; i += 1) {
    const dm = directional(high, low, i);
    plusDM += dm.plus;
    minusDM += dm.minus;
    tr += trueRange(high, low, close, i);
  }

  let sumDX = 0;
  let adx: number | null = null;
  for (let i = period; i < n; i += 1) {
    const dm = directional(high, low, i);
    plusDM = plusDM - plusDM / period + dm.plus;
    minusDM = minusDM - minusDM / period + dm.minus;
    tr = tr - tr / period + trueRange(high, low, close, i);

    const plusDI = isZero(tr) ? 0 : (100 * plusDM) / tr;
    const minusDI = isZero(tr) ? 0 : (100 * minusDM) / tr;
    out.plusDI[i] = plusDI;
    out.minusDI[i] = minusDI;

    // DX is undefined when there is no range or no movement; ADX then carries forward.
    const total = plusDI + minusDI;
    const dx = !isZero(tr) && !isZero(total) ? (100 * Math.abs(minusDI - plusDI)) / total : null;
    if (i < 2 * period - 1) {
      if (dx !== null) sumDX += dx;
    } else if (i === 2 * period - 1) {
      if (dx !== null) sumDX += dx;
      adx = sumDX / period;
    } else if (dx !== null && adx !== null) {
      adx = (adx * (period - 1) + dx) / period;
    }
    if (adx !== null) out.adx[i] = adx;
  }
  return out;
}
