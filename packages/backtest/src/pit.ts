import { nextTradingDay } from "@market/calendar";
import type { FundamentalPoint, SecurityData, SharesPoint } from "./data";
import { lastIndexAtOrBefore } from "./data";

/**
 * Point-in-time fundamentals (Phase 2 step B3; spec §5.15 bias control (a)). Figures are used as
 * first reported, from the session after the filing that reported them: never from the period
 * end, and never with restatements filed later.
 */

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;

/** One line value as stored in market.financial_statements (as-reported basis). */
export interface FiledValue {
  value: number;
  /** Filing date (YYYY-MM-DD) of the value, or of the later component when derived. */
  filed: string;
}

export interface IncomeRow {
  frequency: "annual" | "quarterly";
  periodEnd: string;
  revenue: FiledValue | null;
  netIncome: FiledValue | null;
}

/** The session a figure filed on `filed` can first be used: the next one, as filings are dated. */
export function availableFrom(filed: string): string {
  return nextTradingDay(filed);
}

interface Figures {
  periodEnd: string;
  revenue: number | null;
  netIncome: number | null;
}

/**
 * Trailing twelve months, with the screener's rule (packages/screener `trailingTwelveMonths`):
 * the four latest quarters when consecutive and recent, else the latest fiscal year within 15
 * months. A line needs all four quarters.
 */
export function ttm(
  quarters: readonly Figures[],
  annual: Figures | null,
  asOf: string,
): { revenue: number | null; netIncome: number | null; periodEnd: string | null } {
  const q = [...quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, 4);
  const consecutive =
    q.length === 4 &&
    q.every(
      (x, i) =>
        i === 0 ||
        (days(q[i - 1]!.periodEnd, x.periodEnd) >= 80 &&
          days(q[i - 1]!.periodEnd, x.periodEnd) <= 100),
    );
  const fresh = q.length > 0 && days(asOf, q[0]!.periodEnd) <= 200;
  if (consecutive && fresh) {
    const sum = (key: "revenue" | "netIncome") =>
      q.every((x) => x[key] !== null) ? q.reduce((s, x) => s + x[key]!, 0) : null;
    return { revenue: sum("revenue"), netIncome: sum("netIncome"), periodEnd: q[0]!.periodEnd };
  }
  if (annual && days(asOf, annual.periodEnd) <= 460) {
    return { revenue: annual.revenue, netIncome: annual.netIncome, periodEnd: annual.periodEnd };
  }
  return { revenue: null, netIncome: null, periodEnd: null };
}

/**
 * The TTM figures known after each filing date, from as-reported income rows. A value counts
 * only once its own filing date has passed, so a figure is never used before it was public.
 */
export function fundamentalTimeline(rows: readonly IncomeRow[]): FundamentalPoint[] {
  const filedDates = [...new Set(rows.flatMap((r) => [r.revenue?.filed, r.netIncome?.filed]))]
    .filter((d): d is string => typeof d === "string")
    .sort();
  const known = (v: FiledValue | null, asOf: string) =>
    v !== null && v.filed <= asOf ? v.value : null;
  const figuresAsOf = (asOf: string, frequency: IncomeRow["frequency"]) =>
    rows
      .filter((r) => r.frequency === frequency)
      .map((r) => ({
        periodEnd: r.periodEnd,
        revenue: known(r.revenue, asOf),
        netIncome: known(r.netIncome, asOf),
      }))
      .filter((f) => f.revenue !== null || f.netIncome !== null);

  const points: FundamentalPoint[] = [];
  for (const filed of filedDates) {
    const quarters = figuresAsOf(filed, "quarterly");
    const annuals = figuresAsOf(filed, "annual").sort((a, b) =>
      b.periodEnd.localeCompare(a.periodEnd),
    );
    const now = ttm(quarters, annuals[0] ?? null, filed);
    if (now.periodEnd === null) continue;
    // The same measure a year earlier, from what was known at this filing.
    const yearAgoEnd = now.periodEnd;
    const earlierQuarters = quarters.filter((q) => days(yearAgoEnd, q.periodEnd) >= 330);
    const earlierAnnual = annuals.find((a) => days(yearAgoEnd, a.periodEnd) >= 330) ?? null;
    const yearAgoAsOf = new Date(Date.parse(yearAgoEnd) - 365 * DAY).toISOString().slice(0, 10);
    const ago = ttm(earlierQuarters, earlierAnnual, yearAgoAsOf);
    points.push({
      availableFrom: availableFrom(filed),
      periodEnd: now.periodEnd,
      revenueTtm: now.revenue,
      netIncomeTtm: now.netIncome,
      revenueTtmYearAgo: ago.revenue,
    });
  }
  // Several filings can become usable on the same session; keep the last.
  const bySession = new Map<string, FundamentalPoint>();
  for (const p of points) bySession.set(p.availableFrom, p);
  return [...bySession.values()].sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));
}

/** Cover-page share counts, usable from the session after each filing. */
export function sharesTimeline(
  rows: readonly { shares: number; asOf: string; filed: string }[],
): SharesPoint[] {
  const points = rows
    .filter((r) => r.shares > 0)
    .map((r) => ({ availableFrom: availableFrom(r.filed), asOf: r.asOf, shares: r.shares }))
    .sort((a, b) => a.availableFrom.localeCompare(b.availableFrom) || a.asOf.localeCompare(b.asOf));
  const bySession = new Map<string, SharesPoint>();
  for (const p of points) {
    const prev = bySession.get(p.availableFrom);
    if (!prev || p.asOf >= prev.asOf) bySession.set(p.availableFrom, p);
  }
  return [...bySession.values()];
}

const dateIndex = new WeakMap<SecurityData, { fundamentals: string[]; shares: string[] }>();
function datesOf(sec: SecurityData) {
  let d = dateIndex.get(sec);
  if (!d) {
    d = {
      fundamentals: sec.fundamentals.map((f) => f.availableFrom),
      shares: sec.shares.map((s) => s.availableFrom),
    };
    dateIndex.set(sec, d);
  }
  return d;
}

/** Fundamental values known on `date` for a security closing at `close` that day. */
export function fundamentalsOn(
  sec: SecurityData,
  date: string,
  close: number,
): {
  marketCap: number | null;
  peTtm: number | null;
  psTtm: number | null;
  revenueGrowthYoy: number | null;
  netMarginTtm: number | null;
} {
  const index = datesOf(sec);
  const fi = lastIndexAtOrBefore(index.fundamentals, date);
  const f = fi >= 0 ? sec.fundamentals[fi]! : null;
  const si = lastIndexAtOrBefore(index.shares, date);
  let shares: number | null = null;
  if (si >= 0) {
    const s = sec.shares[si]!;
    // A split after the count's date changes the number of shares.
    shares = sec.shareChanges
      .filter((c) => c.exDate > s.asOf && c.exDate <= date)
      .reduce((n, c) => n * c.ratio, s.shares);
  }
  const marketCap = shares !== null ? shares * close : null;
  const rev = f?.revenueTtm ?? null;
  const ni = f?.netIncomeTtm ?? null;
  const ago = f?.revenueTtmYearAgo ?? null;
  return {
    marketCap,
    peTtm: marketCap !== null && ni !== null && ni > 0 ? marketCap / ni : null,
    psTtm: marketCap !== null && rev !== null && rev > 0 ? marketCap / rev : null,
    revenueGrowthYoy: rev !== null && ago !== null && rev > 0 && ago > 0 ? rev / ago - 1 : null,
    netMarginTtm: rev !== null && ni !== null && rev > 0 ? ni / rev : null,
  };
}
