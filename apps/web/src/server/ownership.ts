import "server-only";
import { sql, type Database } from "@market/db";
import type { InsiderLine, OwnerLike } from "@market/ownership";

/**
 * Ownership tab data (Phase 2 step H4, spec §5.13): Form 4 transactions by issuer CIK, 13F
 * positions by quarter with their changes, and FINRA short interest by settlement date.
 * Everything is read as stored, with the filing or date it comes from.
 */

export interface InsiderRow extends InsiderLine {
  line: number;
  filedAt: Date;
  url: string;
  securityTitle: string;
  sharesAfter: number | null;
  ownership: "D" | "I" | null;
  ownershipNature: string | null;
  aff10b5One: boolean | null;
  /** Footnote texts referenced by this line. */
  notes: string[];
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** Form 4 lines for an issuer, newest first, with the filing each comes from. */
export async function insiderRows(
  database: Database,
  cik: string,
  opts: { since: string; limit?: number },
): Promise<{
  rows: InsiderRow[];
  truncated: boolean;
  lastFiledAt: Date | null;
  lastReadAt: Date | null;
}> {
  const limit = opts.limit ?? 300;
  const result = await sql<{
    accession_no: string;
    form_type: string;
    filed_at: Date;
    url: string;
    owners: OwnerLike[];
    aff_10b5_1: boolean | null;
    footnotes: Record<string, string>;
    line: number;
    derivative: boolean;
    security_title: string;
    transaction_date: string;
    code: string;
    shares: string | null;
    price: string | null;
    acquired_disposed: "A" | "D" | null;
    shares_after: string | null;
    ownership: "D" | "I" | null;
    ownership_nature: string | null;
    footnote_ids: string[];
  }>`
    select f.accession_no, f.form_type, f.filed_at, f.url, f.owners, f.aff_10b5_1, f.footnotes,
      t.line, t.derivative, t.security_title, t.transaction_date, t.code, t.shares, t.price,
      t.acquired_disposed, t.shares_after, t.ownership, t.ownership_nature, t.footnote_ids
    from market.insider_filings f
    join market.insider_transactions t on t.accession_no = f.accession_no
    where f.issuer_cik = ${cik} and t.transaction_date >= ${opts.since}
    order by t.transaction_date desc, f.filed_at desc, t.accession_no, t.line
    limit ${limit + 1}
  `.execute(database);
  const latest = await sql<{ filed: Date | null; read: Date | null }>`
    select max(filed_at) as filed, max(fetched_at) as read
    from market.insider_filings where issuer_cik = ${cik}
  `.execute(database);
  const rows = result.rows.slice(0, limit).map((r) => ({
    accession_no: r.accession_no,
    form_type: r.form_type,
    owners: r.owners,
    transaction_date: r.transaction_date,
    code: r.code,
    derivative: r.derivative,
    acquired_disposed: r.acquired_disposed,
    shares: num(r.shares),
    price: num(r.price),
    line: r.line,
    filedAt: r.filed_at,
    url: r.url,
    securityTitle: r.security_title,
    sharesAfter: num(r.shares_after),
    ownership: r.ownership,
    ownershipNature: r.ownership_nature,
    aff10b5One: r.aff_10b5_1,
    notes: r.footnote_ids.map((id) => r.footnotes[id]).filter((t): t is string => Boolean(t)),
  }));
  return {
    rows,
    truncated: result.rows.length > limit,
    lastFiledAt: latest.rows[0]?.filed ?? null,
    lastReadAt: latest.rows[0]?.read ?? null,
  };
}

export interface Holder {
  filerCik: string;
  filerName: string;
  shares: number;
  valueUsd: number;
  filedOn: string;
  accessions: string[];
  /** Shares at the previous quarter end; null when the filer reported no position then. */
  previousShares: number | null;
}

export interface HoldingsView {
  /**
   * How many CUSIPs tie 13F positions to this security. CUSIPs only join SEC's files and are
   * never shown (ADR-032), so the page gets a count, not the identifiers.
   */
  cusips: number;
  /** The end of the latest 13F data set read: filings after it are not in yet. */
  dataSetsThrough: string | null;
  /** Quarter ends with data for this security, newest first. */
  periods: string[];
  period: string | null;
  /** The quarter before `period`, when its data is loaded (changes compare with it). */
  previous: string | null;
  holders: Holder[];
  /** Filers with a position last quarter whose holdings report this quarter lists none. */
  soldOut: { filerCik: string; filerName: string; previousShares: number; filedOn: string }[];
  totals: {
    holders: number;
    shares: number;
    previousHolders: number | null;
    previousShares: number | null;
    newPositions: number;
    /** All such filers; `soldOut` lists the largest. */
    soldOut: number;
  };
  /** The first and latest filing dates among this quarter's positions. */
  filed: { first: string; last: string } | null;
}

/** The calendar quarter end before a quarter end: 2026-06-30 → 2026-03-31. */
export function priorQuarterEnd(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const q = Math.ceil(m / 3);
  return q === 1 ? `${y - 1}-12-31` : `${y}-${q === 2 ? "03-31" : q === 3 ? "06-30" : "09-30"}`;
}

/** 13F positions in a security for one quarter end (default: the latest), with changes. */
export async function holdingsView(
  database: Database,
  securityId: string,
  requested: string | null,
  top = 50,
): Promise<HoldingsView> {
  const [periodRows, cusipRows, sets] = await Promise.all([
    sql<{ p: string }>`
      select distinct report_period::text as p from market.institutional_holdings
      where security_id = ${securityId} order by p desc
    `.execute(database),
    sql<{ n: string }>`
      select count(*) as n from market.security_cusips where security_id = ${securityId}
    `.execute(database),
    sql<{ through: string | null }>`
      select max(window_end)::text as through from market.form13f_data_sets
    `.execute(database),
  ]);
  const periods = periodRows.rows.map((r) => r.p);
  const period = requested && periods.includes(requested) ? requested : (periods[0] ?? null);
  const empty: HoldingsView = {
    cusips: Number(cusipRows.rows[0]?.n ?? 0),
    dataSetsThrough: sets.rows[0]?.through ?? null,
    periods,
    period,
    previous: null,
    holders: [],
    soldOut: [],
    totals: {
      holders: 0,
      shares: 0,
      previousHolders: null,
      previousShares: null,
      newPositions: 0,
      soldOut: 0,
    },
    filed: null,
  };
  if (!period) return empty;
  // Changes compare with the quarter just before, never with an older one across a gap.
  const prior = priorQuarterEnd(period);
  const previous = periods.includes(prior) ? prior : null;

  const positions = await sql<{
    filer_cik: string;
    filer_name: string;
    shares: string;
    value_usd: string;
    filed_on: string;
    accession_nos: string[];
    previous_shares: string | null;
  }>`
    select h.filer_cik, h.filer_name, h.shares, h.value_usd, h.filed_on::text, h.accession_nos,
      p.shares as previous_shares
    from market.institutional_holdings h
    left join market.institutional_holdings p
      on p.security_id = h.security_id and p.filer_cik = h.filer_cik and p.report_period = ${previous}
    where h.security_id = ${securityId} and h.report_period = ${period}
    order by h.shares desc, h.filer_cik
  `.execute(database);
  const all = positions.rows;
  const totals = await sql<{ holders: string; shares: string | null }>`
    select count(*) as holders, sum(shares) as shares from market.institutional_holdings
    where security_id = ${securityId} and report_period = ${previous}
  `.execute(database);

  // Sold out: a position last quarter, none this quarter, and a holdings report filed for it.
  const soldOut = previous
    ? (
        await sql<{ filer_cik: string; filer_name: string; shares: string; filed_on: string }>`
          select p.filer_cik, p.filer_name, p.shares, max(f.filed_on)::text as filed_on
          from market.institutional_holdings p
          join market.form13f_filings f
            on f.filer_cik = p.filer_cik and f.report_period = ${period}
           and f.submission_type in ('13F-HR', '13F-HR/A') and f.report_type <> '13F NOTICE'
          where p.security_id = ${securityId} and p.report_period = ${previous}
            and not exists (
              select 1 from market.institutional_holdings h
              where h.security_id = p.security_id and h.filer_cik = p.filer_cik
                and h.report_period = ${period})
          group by p.filer_cik, p.filer_name, p.shares
          order by p.shares desc, p.filer_cik
        `.execute(database)
      ).rows.map((r) => ({
        filerCik: r.filer_cik,
        filerName: r.filer_name,
        previousShares: Number(r.shares),
        filedOn: r.filed_on,
      }))
    : [];

  const filedDates = all.map((r) => r.filed_on).sort();
  return {
    ...empty,
    previous,
    holders: all.slice(0, top).map((r) => ({
      filerCik: r.filer_cik,
      filerName: r.filer_name,
      shares: Number(r.shares),
      valueUsd: Number(r.value_usd),
      filedOn: r.filed_on,
      accessions: r.accession_nos,
      previousShares: num(r.previous_shares),
    })),
    soldOut: soldOut.slice(0, top),
    totals: {
      holders: all.length,
      shares: all.reduce((s, r) => s + Number(r.shares), 0),
      previousHolders: previous ? Number(totals.rows[0]?.holders ?? 0) : null,
      previousShares: previous ? Number(totals.rows[0]?.shares ?? 0) : null,
      newPositions: previous ? all.filter((r) => r.previous_shares === null).length : 0,
      soldOut: soldOut.length,
    },
    filed: filedDates.length ? { first: filedDates[0]!, last: filedDates.at(-1)! } : null,
  };
}

export interface ShortInterestRow {
  settlementDate: string;
  symbol: string;
  shortInterest: number;
  previousShortInterest: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  revised: boolean;
  splitAdjusted: boolean;
  fetchedAt: Date;
}

/** FINRA short interest for a security, newest settlement date first. */
export async function shortInterestRows(
  database: Database,
  securityId: string,
  limit = 12,
): Promise<ShortInterestRow[]> {
  const rows = await database
    .selectFrom("market.short_interest")
    .selectAll()
    .where("security_id", "=", securityId)
    .orderBy("settlement_date", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    settlementDate: r.settlement_date,
    symbol: r.symbol,
    shortInterest: Number(r.short_interest),
    previousShortInterest: num(r.previous_short_interest),
    avgDailyVolume: num(r.avg_daily_volume),
    daysToCover: num(r.days_to_cover),
    revised: r.revised,
    splitAdjusted: r.split_adjusted,
    fetchedAt: r.fetched_at,
  }));
}
