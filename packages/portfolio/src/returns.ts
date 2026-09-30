const DAY_MS = 86_400_000;

/** Calendar days between two ISO dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Annualizes a total return over `days` calendar days (365-day years); null under a year. */
export function annualize(total: number, days: number): number | null {
  if (days < 365 || total <= -1) return null;
  return (1 + total) ** (365 / days) - 1;
}

/** Largest peak-to-trough fall of a growth index, as a positive fraction (0 when never down). */
export function maxDrawdown(index: readonly number[]): number | null {
  if (index.length === 0) return null;
  let peak = index[0]!;
  let worst = 0;
  for (const v of index) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

export interface CashFlow {
  date: string;
  /** From the investor's side: money in is negative, money out (and the final value) positive. */
  amount: number;
}

/**
 * XIRR: the annual rate r with Σ amount × (1 + r)^(−days/365) = 0 (actual/365, like the
 * spreadsheet function). Newton's method from 10%, falling back to bisection on
 * (−99.99%, 1,000,000%). Null when the flows do not change sign or no root is found.
 */
export function xirr(flows: readonly CashFlow[]): number | null {
  const nonzero = flows.filter((f) => f.amount !== 0);
  if (!nonzero.some((f) => f.amount > 0) || !nonzero.some((f) => f.amount < 0)) return null;
  const t0 = nonzero[0]!.date;
  const ts = nonzero.map((f) => daysBetween(t0, f.date) / 365);
  const npv = (r: number) => nonzero.reduce((s, f, i) => s + f.amount / (1 + r) ** ts[i]!, 0);
  const dnpv = (r: number) =>
    nonzero.reduce((s, f, i) => s - (ts[i]! * f.amount) / (1 + r) ** (ts[i]! + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(r);
    const d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  let lo = -0.9999;
  let hi = 10_000;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) {
    return null;
  }
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(hi - lo) < 1e-14 || fm === 0) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}
