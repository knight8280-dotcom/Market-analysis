/**
 * Trading multiples and peer statistics (Phase 2 step D3). A multiple is unavailable (null)
 * when an input is missing or its denominator is not positive: never estimated.
 */

export interface MultipleInputs {
  price: number | null;
  shares: number | null;
  revenueTtm: number | null;
  netIncomeTtm: number | null;
  /** Operating income + depreciation and amortization, trailing twelve months. */
  ebitdaTtm: number | null;
  /** Debt less cash and short-term investments. */
  netDebt: number | null;
}

export interface Multiples {
  marketCap: number | null;
  enterpriseValue: number | null;
  pe: number | null;
  ps: number | null;
  evEbitda: number | null;
}

const ratio = (a: number | null, b: number | null) =>
  a !== null && b !== null && b > 0 && Number.isFinite(a) ? a / b : null;

export function multiples(x: MultipleInputs): Multiples {
  const marketCap =
    x.price !== null && x.shares !== null && x.price > 0 && x.shares > 0
      ? x.price * x.shares
      : null;
  const enterpriseValue = marketCap !== null && x.netDebt !== null ? marketCap + x.netDebt : null;
  return {
    marketCap,
    enterpriseValue,
    pe: ratio(marketCap, x.netIncomeTtm),
    ps: ratio(marketCap, x.revenueTtm),
    evEbitda:
      enterpriseValue !== null && enterpriseValue > 0 ? ratio(enterpriseValue, x.ebitdaTtm) : null,
  };
}

/** Median of the finite values; null when there are none. */
export function median(values: readonly (number | null)[]): number | null {
  const xs = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/**
 * Where `value` sits among `others`: the share below it plus half the share equal to it (0 to 1),
 * so the middle of a set is 0.5. Null without a value or anything to compare with.
 */
export function percentileRank(
  value: number | null,
  others: readonly (number | null)[],
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const xs = others.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0) return null;
  const below = xs.filter((v) => v < value).length;
  const equal = xs.filter((v) => v === value).length;
  return (below + equal / 2) / xs.length;
}

/** Peer candidates: closest in market cap on a log scale, excluding the subject. */
export function nearestByMarketCap<T extends { id: string; marketCap: number | null }>(
  subject: { id: string; marketCap: number | null },
  candidates: readonly T[],
  limit: number,
): T[] {
  const others = candidates.filter((c) => c.id !== subject.id);
  if (subject.marketCap === null || !(subject.marketCap > 0)) {
    return [...others].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, limit);
  }
  const target = Math.log(subject.marketCap);
  return others
    .filter((c) => c.marketCap !== null && c.marketCap > 0)
    .sort(
      (a, b) =>
        Math.abs(Math.log(a.marketCap!) - target) - Math.abs(Math.log(b.marketCap!) - target),
    )
    .slice(0, limit);
}
