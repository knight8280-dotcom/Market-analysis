import { rsi, sma } from "@market/indicators";
import { decimalAdd } from "@market/market-data/statements";

/**
 * One screener_snapshot row from a security's recent adjusted bars and its latest
 * fundamentals (Phase 1 step F1). Pure, so it is tested without a database.
 *
 * - Returns are total returns from adjusted closes over calendar windows. The starting close is
 *   the last one on or before the window start; if that bar is more than 10 days older than the
 *   start (a gap in the data), the return is left empty rather than stretched.
 * - Valuation uses trailing-twelve-month revenue and net income; P/E is empty unless earnings
 *   are positive. Nothing is estimated.
 */
export interface AdjustedBar {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface SnapshotFundamentals {
  sharesOutstanding: number | null;
  revenueTtm: string | null;
  netIncomeTtm: string | null;
  equity: string | null;
  asOf: string | null;
}

export interface SnapshotValues {
  as_of: string;
  change_1d: number | null;
  return_1w: number | null;
  return_1m: number | null;
  return_3m: number | null;
  return_6m: number | null;
  return_ytd: number | null;
  return_1y: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  high_52w: number | null;
  low_52w: number | null;
  avg_volume_30d: number | null;
  shares_outstanding: number | null;
  market_cap: number | null;
  revenue_ttm: string | null;
  net_income_ttm: string | null;
  equity: string | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  dividend_yield: number | null;
  fundamentals_as_of: string | null;
}

const DAY = 86_400_000;
const shift = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
const monthsBack = (iso: string, months: number) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
};

/** Index of the last bar on or before `date`, or -1. Bars are sorted by date. */
function atOrBefore(bars: readonly AdjustedBar[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const MAX_ANCHOR_GAP_DAYS = 10;

function returnSince(bars: readonly AdjustedBar[], start: string): number | null {
  const i = atOrBefore(bars, start);
  if (i < 0) return null;
  const anchor = bars[i]!;
  if ((Date.parse(start) - Date.parse(anchor.date)) / DAY > MAX_ANCHOR_GAP_DAYS) return null;
  if (anchor.close === 0) return null;
  return bars.at(-1)!.close / anchor.close - 1;
}

const last = (xs: readonly (number | null)[]) => xs.at(-1) ?? null;

export function computeSnapshot(
  bars: readonly AdjustedBar[],
  fundamentals: SnapshotFundamentals | null,
  /** Sum of split-adjusted cash dividends per share with ex-dates in the last 365 days. */
  dividendsTtm: number | null,
  /** Latest raw (as traded) close; equal to the adjusted close on the latest bar. */
  close: number,
): SnapshotValues {
  const latest = bars.at(-1)!;
  const asOf = latest.date;
  const closes = bars.map((b) => b.close);
  const prev = bars.length >= 2 ? bars.at(-2)! : null;
  const yearAgo = shift(asOf, -365);
  const window52 = bars.filter((b) => b.date > yearAgo);
  const recent = bars.slice(-30);

  const shares = fundamentals?.sharesOutstanding ?? null;
  const marketCap = shares !== null && shares > 0 ? shares * close : null;
  const revenue = fundamentals?.revenueTtm ? Number(fundamentals.revenueTtm) : null;
  const netIncome = fundamentals?.netIncomeTtm ? Number(fundamentals.netIncomeTtm) : null;
  const equity = fundamentals?.equity ? Number(fundamentals.equity) : null;

  return {
    as_of: asOf,
    change_1d: prev && prev.close !== 0 ? latest.close / prev.close - 1 : null,
    return_1w: returnSince(bars, shift(asOf, -7)),
    return_1m: returnSince(bars, monthsBack(asOf, 1)),
    return_3m: returnSince(bars, monthsBack(asOf, 3)),
    return_6m: returnSince(bars, monthsBack(asOf, 6)),
    return_ytd: returnSince(bars, `${Number(asOf.slice(0, 4)) - 1}-12-31`),
    return_1y: returnSince(bars, monthsBack(asOf, 12)),
    sma50: last(sma(closes, 50)),
    sma200: last(sma(closes, 200)),
    rsi14: last(rsi(closes, 14)),
    high_52w: window52.length ? Math.max(...window52.map((b) => b.high)) : null,
    low_52w: window52.length ? Math.min(...window52.map((b) => b.low)) : null,
    avg_volume_30d: recent.length ? recent.reduce((s, b) => s + b.volume, 0) / recent.length : null,
    shares_outstanding: shares,
    market_cap: marketCap,
    revenue_ttm: fundamentals?.revenueTtm ?? null,
    net_income_ttm: fundamentals?.netIncomeTtm ?? null,
    equity: fundamentals?.equity ?? null,
    pe: marketCap !== null && netIncome !== null && netIncome > 0 ? marketCap / netIncome : null,
    ps: marketCap !== null && revenue !== null && revenue > 0 ? marketCap / revenue : null,
    pb: marketCap !== null && equity !== null && equity > 0 ? marketCap / equity : null,
    dividend_yield: dividendsTtm !== null && close > 0 ? dividendsTtm / close : null,
    fundamentals_as_of: fundamentals?.asOf ?? null,
  };
}

export interface QuarterFigures {
  periodEnd: string;
  revenue: string | null;
  netIncome: string | null;
}

/**
 * Trailing twelve months from the four most recent quarters when they are consecutive and
 * recent; otherwise the latest fiscal year if it ended within 15 months. Per line, a sum needs
 * all four quarters.
 */
export function trailingTwelveMonths(
  quarters: readonly QuarterFigures[],
  annual: QuarterFigures | null,
  asOf: string,
): { revenue: string | null; netIncome: string | null; asOf: string | null } {
  const q = [...quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, 4);
  const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;
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
      q.every((x) => x[key] !== null) ? q.reduce((s, x) => decimalAdd(s, x[key]!), "0") : null;
    return { revenue: sum("revenue"), netIncome: sum("netIncome"), asOf: q[0]!.periodEnd };
  }
  if (annual && days(asOf, annual.periodEnd) <= 460) {
    return { revenue: annual.revenue, netIncome: annual.netIncome, asOf: annual.periodEnd };
  }
  return { revenue: null, netIncome: null, asOf: null };
}
