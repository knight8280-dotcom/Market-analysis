import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";

/** Calendar queries (Phase 1 step H). Dates are exchange-calendar dates (YYYY-MM-DD). */

export interface EarningsRow {
  ticker: string;
  name: string;
  date: string;
  hour: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  epsEstimate: string | null;
  epsActual: string | null;
  source: "finnhub" | "sec_edgar";
  onWatchlist: boolean;
}

/**
 * Earnings between two dates: Finnhub's calendar when loaded, plus past report dates from 8-K
 * Item 2.02 ("Results of Operations") filings for securities Finnhub does not cover.
 */
export async function earningsBetween(
  db: Database,
  from: string,
  to: string,
): Promise<EarningsRow[]> {
  const rows = await sql<{
    ticker: string;
    name: string;
    date: string;
    hour: string | null;
    fiscal_year: number | null;
    fiscal_quarter: number | null;
    eps_estimate: string | null;
    eps_actual: string | null;
    source: "finnhub" | "sec_edgar";
    on_watchlist: boolean;
  }>`
    with watched as (
      select distinct security_id from public.watchlist_items where user_id = ${OWNER_USER_ID}
    ),
    finnhub as (
      select e.security_id, e.report_date as date, e.hour, e.fiscal_year, e.fiscal_quarter,
        e.eps_estimate::text, e.eps_actual::text, 'finnhub'::text as source
      from market.earnings_events e
      where e.report_date between ${from}::date and ${to}::date
    ),
    edgar as (
      select distinct on (s.security_id, f.filing_date) s.security_id, f.filing_date as date,
        null::text as hour, null::int as fiscal_year, null::int as fiscal_quarter,
        null::text as eps_estimate, null::text as eps_actual, 'sec_edgar'::text as source
      from market.filings f
      join market.securities s on s.cik = f.cik and s.is_active
      where f.form_type in ('8-K', '8-K/A') and '2.02' = any(f.items)
        and f.filing_date between ${from}::date and ${to}::date
        and not exists (select 1 from market.earnings_events e where e.security_id = s.security_id
                        and abs(e.report_date - f.filing_date) <= 3)
    )
    select s.ticker, s.name, x.date, x.hour, x.fiscal_year, x.fiscal_quarter, x.eps_estimate,
      x.eps_actual, x.source, (w.security_id is not null) as on_watchlist
    from (select * from finnhub union all select * from edgar) x
    join market.securities s using (security_id)
    left join watched w using (security_id)
    order by x.date, on_watchlist desc, s.ticker
  `.execute(db);
  return rows.rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    date: r.date,
    hour: r.hour,
    fiscalYear: r.fiscal_year,
    fiscalQuarter: r.fiscal_quarter,
    epsEstimate: r.eps_estimate,
    epsActual: r.eps_actual,
    source: r.source,
    onWatchlist: r.on_watchlist,
  }));
}

/** Releases the calendar highlights (FRED release ids). */
export const MAJOR_RELEASES = new Map<number, string>([
  [50, "Jobs report"],
  [10, "Inflation (CPI)"],
  [46, "Producer prices (PPI)"],
  [53, "GDP"],
  [54, "Personal income and spending (PCE)"],
  [9, "Retail sales"],
  [13, "Industrial production"],
  [192, "Job openings (JOLTS)"],
]);

export interface ReleaseRow {
  releaseId: number;
  name: string;
  date: string;
  major: boolean;
}

export async function releasesBetween(
  db: Database,
  from: string,
  to: string,
): Promise<ReleaseRow[]> {
  const rows = await db
    .selectFrom("market.economic_releases")
    .select(["release_id", "name", "release_date"])
    .where("release_date", ">=", from)
    .where("release_date", "<=", to)
    .orderBy("release_date")
    .orderBy("name")
    .execute();
  return rows.map((r) => ({
    releaseId: r.release_id,
    name: r.name,
    date: r.release_date,
    major: MAJOR_RELEASES.has(r.release_id),
  }));
}

export interface ActionRow {
  ticker: string;
  name: string;
  date: string;
  type: string;
  ratio: string | null;
  cashAmount: string | null;
}

/** Dividends, splits and other corporate actions from the price source. */
export async function actionsBetween(
  db: Database,
  source: ProviderId,
  from: string,
  to: string,
): Promise<ActionRow[]> {
  const rows = await db
    .selectFrom("market.corporate_actions as a")
    .innerJoin("market.securities as s", "s.security_id", "a.security_id")
    .select(["s.ticker", "s.name", "a.ex_date", "a.type", "a.ratio", "a.cash_amount"])
    .where("a.source", "=", source)
    .where("a.ex_date", ">=", from)
    .where("a.ex_date", "<=", to)
    .orderBy("a.ex_date", "desc")
    .orderBy("s.ticker")
    .limit(500)
    .execute();
  return rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    date: r.ex_date,
    type: r.type,
    ratio: r.ratio,
    cashAmount: r.cash_amount,
  }));
}

/** Past earnings dates for one security (chart markers). */
export async function earningsDates(
  db: Database,
  securityId: string,
  cik: string | null,
): Promise<string[]> {
  const rows = await sql<{ date: string }>`
    select report_date as date from market.earnings_events where security_id = ${securityId}
    union
    select filing_date as date from market.filings
    where ${cik}::text is not null and cik = ${cik} and form_type in ('8-K', '8-K/A') and '2.02' = any(items)
    order by 1
  `.execute(db);
  return rows.rows.map((r) => r.date);
}
