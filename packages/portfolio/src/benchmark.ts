import { annualize, daysBetween } from "./returns";

/**
 * A benchmark's growth over the portfolio's days, from total-return (split- and
 * dividend-adjusted) closes: 1 on the first day with a close, carried forward over gaps. Days
 * before the benchmark's first close are null.
 */
export function benchmarkIndex(
  days: readonly string[],
  adjusted: { dates: readonly string[]; closes: readonly number[] },
): (number | null)[] {
  const out: (number | null)[] = [];
  let j = -1;
  let base: number | null = null;
  for (const day of days) {
    while (j + 1 < adjusted.dates.length && adjusted.dates[j + 1]! <= day) j++;
    if (j < 0) {
      out.push(null);
      continue;
    }
    const close = adjusted.closes[j]!;
    base ??= close;
    out.push(close / base);
  }
  return out;
}

/** Total and annualized return of a benchmark index over the days it covers. */
export function benchmarkReturn(
  days: readonly string[],
  index: readonly (number | null)[],
): { total: number; annualized: number | null; from: string; to: string } | null {
  const first = index.findIndex((v) => v !== null);
  if (first < 0 || days.length === 0) return null;
  const total = index.at(-1)! - 1;
  return {
    total,
    annualized: annualize(total, daysBetween(days[first]!, days.at(-1)!)),
    from: days[first]!,
    to: days.at(-1)!,
  };
}
