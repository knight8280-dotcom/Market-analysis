import { mean } from "./series";

/**
 * How series move together, and how concentrated a set of weights is (Phase 2 step C1).
 * Returns are paired by position and a pair is used only when both values exist.
 */

/** Pairs of returns where both are known. */
export function paired(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
): { a: number[]; b: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  return { a: xs, b: ys };
}

function covariance(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (xs.length - 1);
}

/** Pearson correlation of the paired returns; null with fewer than 3 pairs or no variation. */
export function correlation(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
): number | null {
  const p = paired(a, b);
  if (p.a.length < 3) return null;
  const va = covariance(p.a, p.a);
  const vb = covariance(p.b, p.b);
  if (!(va > 0) || !(vb > 0)) return null;
  return Math.max(-1, Math.min(1, covariance(p.a, p.b) / Math.sqrt(va * vb)));
}

/** Beta of `asset` against `market`: cov(asset, market) ÷ var(market) over paired returns. */
export function beta(
  asset: readonly (number | null)[],
  market: readonly (number | null)[],
): number | null {
  const p = paired(asset, market);
  if (p.a.length < 3) return null;
  const vm = covariance(p.b, p.b);
  return vm > 0 ? covariance(p.a, p.b) / vm : null;
}

/** Correlation of every pair of series (1 on the diagonal when a series varies). */
export function correlationMatrix(
  series: readonly (readonly (number | null)[])[],
): (number | null)[][] {
  return series.map((a, i) =>
    series.map((b, j) => (i === j ? (correlation(a, a) === null ? null : 1) : correlation(a, b))),
  );
}

/**
 * Concentration of positive weights (normalized to sum to 1): the largest ten's share and the
 * Herfindahl-Hirschman index Σw² (1 = one holding; 1 ÷ HHI is the "effective" number held).
 */
export function concentration(
  weights: readonly number[],
): { top10: number; hhi: number; effectiveCount: number; count: number } | null {
  const w = weights.filter((x) => x > 0);
  const total = w.reduce((s, x) => s + x, 0);
  if (w.length === 0 || !(total > 0)) return null;
  const norm = w.map((x) => x / total).sort((a, b) => b - a);
  const hhi = norm.reduce((s, x) => s + x * x, 0);
  return {
    top10: norm.slice(0, 10).reduce((s, x) => s + x, 0),
    hhi,
    effectiveCount: 1 / hhi,
    count: w.length,
  };
}
