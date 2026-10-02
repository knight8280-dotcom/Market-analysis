import { sql, type Database } from "@market/db";
import { canDisplay, licenseFor, ProviderId, type Dataset } from "@market/market-data";

/**
 * Read queries behind the app shell and ticker pages. Every price comes from one source (the
 * active route for daily_bars) and is returned with that source and its session date, so the
 * page can label it (MUST DO #7). Personal-plan data is only ever returned for the owner.
 */

const NAMES: Partial<Record<ProviderId, string>> = {
  synthetic: "Synthetic (sample data)",
  tiingo: "Tiingo",
  sec_edgar: "SEC EDGAR",
  fred: "FRED",
  finnhub: "Finnhub",
  treasury: "U.S. Treasury",
  finra: "FINRA",
};

export interface SourceInfo {
  id: ProviderId;
  name: string;
  attribution: string;
  url?: string;
}

export function sourceInfo(id: ProviderId): SourceInfo {
  const { attribution } = licenseFor(id);
  return { id, name: NAMES[id] ?? id, attribution: attribution.text, url: attribution.url };
}

export class NotDisplayableError extends Error {
  constructor(source: ProviderId, dataset: Dataset) {
    super(`${source} ${dataset} data may not be displayed here`);
    this.name = "NotDisplayableError";
  }
}

/** Refuses to hand out data the license does not let the owner see (spec §2.2). */
export function assertDisplayable(source: ProviderId, dataset: Dataset, appEnv: string) {
  if (!canDisplay(source, dataset, { appEnv, viewer: "owner" })) {
    throw new NotDisplayableError(source, dataset);
  }
}

/**
 * The source whose bars pages show: the active daily_bars route, or before any routing state
 * exists, the source with the most recent bar (real data before sample data on a tie).
 */
export async function priceSource(db: Database): Promise<ProviderId | null> {
  const route = await db
    .selectFrom("ops.dataset_routing")
    .select("active_source")
    .where("dataset", "=", "daily_bars")
    .executeTakeFirst();
  if (route?.active_source) return ProviderId.parse(route.active_source);
  const latest = await db
    .selectFrom("market.prices_daily")
    .select("source")
    .orderBy("date", "desc")
    // On a tie, real data wins over sample data.
    .orderBy(sql`source = 'synthetic'`)
    .limit(1)
    .executeTakeFirst();
  return latest ? ProviderId.parse(latest.source) : null;
}

export interface LastUpdated {
  source: ProviderId;
  /** Latest session with bars from this source. */
  session: string | null;
  /** When the last successful end-of-day load finished. */
  loadedAt: Date | null;
}

export async function lastUpdated(db: Database, source: ProviderId): Promise<LastUpdated> {
  const [bar, run] = await Promise.all([
    db
      .selectFrom("market.prices_daily")
      .select((eb) => eb.fn.max("date").as("date"))
      .where("source", "=", source)
      .executeTakeFirst(),
    db
      .selectFrom("ops.data_ingestion_runs")
      .select((eb) => eb.fn.max("finished_at").as("at"))
      .where("dataset", "=", "daily_bars")
      .where("source", "=", source)
      .where("status", "=", "succeeded")
      .executeTakeFirst(),
  ]);
  return {
    source,
    session: bar?.date ?? null,
    loadedAt: run?.at ? new Date(run.at) : null,
  };
}

/** Datasets whose freshness SLO is currently breached (open staleness alerts). */
export async function staleDatasets(db: Database): Promise<{ dataset: string; since: Date }[]> {
  const rows = await db
    .selectFrom("ops.alerts")
    .select(["dataset", "opened_at"])
    .where("kind", "=", "staleness")
    .where("resolved_at", "is", null)
    .orderBy("opened_at")
    .execute();
  return rows.map((r) => ({ dataset: r.dataset, since: new Date(r.opened_at) }));
}

export interface SearchResult {
  ticker: string;
  name: string;
  assetClass: string;
  active: boolean;
}

function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Ticker search for the command palette: exact ticker first, then ticker prefix, then name
 * matches. Only securities the price source covers are offered.
 */
export async function searchSecurities(
  db: Database,
  source: ProviderId,
  query: string,
  limit = 8,
): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 40);
  if (!q) return [];
  const prefix = `${likeEscape(q)}%`;
  const anywhere = `%${likeEscape(q)}%`;
  const rows = await sql<{ ticker: string; name: string; asset_class: string; is_active: boolean }>`
    select s.ticker, s.name, s.asset_class, s.is_active
    from market.securities s
    where exists (
        select 1 from market.provider_symbols ps
        where ps.security_id = s.security_id and ps.source = ${source}
      )
      and (s.ticker ilike ${prefix} or s.name ilike ${anywhere})
    order by upper(s.ticker) = upper(${q}) desc,
      s.ticker ilike ${prefix} desc,
      s.is_active desc,
      s.ticker
    limit ${limit}
  `.execute(db);
  return rows.rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    assetClass: r.asset_class,
    active: r.is_active,
  }));
}

export interface Quote {
  securityId: string;
  ticker: string;
  name: string;
  source: ProviderId;
  date: string;
  close: number;
  /** Split-adjusted change from the previous session's close (dividends not removed). */
  change: number | null;
  volume: number;
}

/**
 * The latest bar and the change from the session before it, per security, for one source.
 * The previous close is split-adjusted so a split does not show as a crash.
 */
export async function latestQuotes(
  db: Database,
  source: ProviderId,
  opts: { securityIds?: readonly string[]; tickers?: readonly string[] } = {},
): Promise<Quote[]> {
  const bySecurity = opts.securityIds?.length
    ? sql`and s.security_id in (${sql.join(opts.securityIds)})`
    : sql``;
  const byTicker = opts.tickers?.length ? sql`and s.ticker in (${sql.join(opts.tickers)})` : sql``;
  const rows = await sql<{
    security_id: string;
    ticker: string;
    name: string;
    date: string;
    close: string;
    volume: string;
    change: number | null;
  }>`
    select s.security_id, s.ticker, s.name, t.date, t.close, t.volume,
      (t.close::float8 * coalesce(ft.split_factor, 1))
        / nullif(y.close::float8 * coalesce(fy.split_factor, 1), 0) - 1 as change
    from market.securities s
    cross join lateral (
      select p.date, p.close, p.volume from market.prices_daily p
      where p.security_id = s.security_id and p.source = ${source}
      order by p.date desc limit 1
    ) t
    left join lateral (
      select p.date, p.close from market.prices_daily p
      where p.security_id = s.security_id and p.source = ${source} and p.date < t.date
      order by p.date desc limit 1
    ) y on true
    left join lateral (
      select af.split_factor from market.adjustment_factors af
      where af.security_id = s.security_id and af.ex_date > t.date
      order by af.ex_date limit 1
    ) ft on true
    left join lateral (
      select af.split_factor from market.adjustment_factors af
      where af.security_id = s.security_id and af.ex_date > y.date
      order by af.ex_date limit 1
    ) fy on true
    where true ${bySecurity} ${byTicker}
  `.execute(db);
  return rows.rows.map((r) => ({
    securityId: r.security_id,
    ticker: r.ticker,
    name: r.name,
    source,
    date: r.date,
    close: Number(r.close),
    change: r.change,
    volume: Number(r.volume),
  }));
}

/** Biggest gainers and losers on the latest session, among securities with bars that day. */
export async function movers(
  db: Database,
  source: ProviderId,
  session: string,
  limit = 5,
): Promise<{ gainers: Quote[]; losers: Quote[] }> {
  const ids = await db
    .selectFrom("market.prices_daily")
    .select("security_id")
    .where("source", "=", source)
    .where("date", "=", session)
    .execute();
  if (ids.length === 0) return { gainers: [], losers: [] };
  const quotes = (
    await latestQuotes(db, source, { securityIds: ids.map((r) => r.security_id) })
  ).filter((q): q is Quote & { change: number } => q.date === session && q.change !== null);
  quotes.sort((a, b) => b.change - a.change);
  return {
    gainers: quotes.slice(0, limit).filter((q) => q.change > 0),
    losers: quotes
      .slice(-limit)
      .reverse()
      .filter((q) => q.change < 0),
  };
}

export interface SecurityDetail {
  securityId: string;
  ticker: string;
  name: string;
  assetClass: string;
  exchangeMic: string | null;
  cik: string | null;
  sicCode: string | null;
  sector: string | null;
  industry: string | null;
  currency: string;
  active: boolean;
  listedAt: string | null;
  delistedAt: string | null;
}

/**
 * The security a ticker names today, or the one that last used it. A reused ticker resolves to
 * the active listing first, then the most recently delisted.
 */
export async function findSecurity(db: Database, ticker: string): Promise<SecurityDetail | null> {
  const row = await db
    .selectFrom("market.securities")
    .selectAll()
    .where("ticker", "=", ticker)
    .orderBy("is_active", "desc")
    .orderBy(sql`delisted_at desc nulls first`)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    securityId: row.security_id,
    ticker: row.ticker,
    name: row.name,
    assetClass: row.asset_class,
    exchangeMic: row.exchange_mic,
    cik: row.cik,
    sicCode: row.sic_code,
    sector: row.sector,
    industry: row.industry,
    currency: row.currency,
    active: row.is_active,
    listedAt: row.listed_at,
    delistedAt: row.delisted_at,
  };
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The most recent raw bars, newest first. */
export async function recentBars(
  db: Database,
  securityId: string,
  source: ProviderId,
  limit = 10,
): Promise<Bar[]> {
  const rows = await db
    .selectFrom("market.prices_daily")
    .select(["date", "open", "high", "low", "close", "volume"])
    .where("security_id", "=", securityId)
    .where("source", "=", source)
    .orderBy("date", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    date: r.date,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/** [date, open, high, low, close, volume], oldest first: compact for the chart API. */
export type BarTuple = [string, number, number, number, number, number];

/**
 * Full daily history for a chart. Adjusted bars are split- and dividend-adjusted on read
 * (prices_daily_adjusted); raw bars are as traded.
 */
export async function dailySeries(
  db: Database,
  securityId: string,
  source: ProviderId,
  adjusted: boolean,
): Promise<BarTuple[]> {
  const table = adjusted ? "market.prices_daily_adjusted" : "market.prices_daily";
  const rows = await db
    .selectFrom(table)
    .select(["date", "open", "high", "low", "close", "volume"])
    .where("security_id", "=", securityId)
    .where("source", "=", source)
    .orderBy("date")
    .execute();
  return rows.map((r) => [
    String(r.date),
    Number(r.open),
    Number(r.high),
    Number(r.low),
    Number(r.close),
    Number(r.volume),
  ]);
}

export interface ChartAction {
  date: string;
  type: string;
  /** Short marker text: "4:1", "1:10", "$0.24", "Spin-off". */
  label: string;
}

function ratioLabel(ratio: number): string {
  if (ratio >= 1) return `${Number(ratio.toFixed(4))}:1`;
  return `1:${Number((1 / ratio).toFixed(4))}`;
}

/** Splits, dividends and other actions to mark on the chart. */
export async function chartActions(
  db: Database,
  securityId: string,
  source: ProviderId,
): Promise<ChartAction[]> {
  const rows = await db
    .selectFrom("market.corporate_actions")
    .select(["ex_date", "type", "ratio", "cash_amount"])
    .where("security_id", "=", securityId)
    .where("source", "=", source)
    .orderBy("ex_date")
    .execute();
  return rows.map((r) => {
    const ratio = r.ratio === null ? null : Number(r.ratio);
    const cash = r.cash_amount === null ? null : Number(r.cash_amount);
    let label = r.type.replaceAll("_", " ");
    if ((r.type === "split" || r.type === "stock_dividend") && ratio) label = ratioLabel(ratio);
    else if (cash !== null)
      label = `$${cash
        .toFixed(cash < 1 ? 4 : 2)
        .replace(/0+$/, "")
        .replace(/\.$/, "")}`;
    return { date: r.ex_date, type: r.type, label };
  });
}

/**
 * 3-month T-bill rates (FRED DTB3) as decimal annual rates, from the last observation on or
 * before `from` to `to`; null when none is stored.
 */
export async function riskFreeRates(
  database: Database,
  from: string,
  to: string,
): Promise<{ dates: string[]; rate: number[] } | null> {
  const rows = await sql<{ date: string; value: number }>`
    select date, value::float8 as value from market.macro_observations
    where series_id = 'DTB3' and value is not null and date <= ${to}::date
      and date >= coalesce(
        (select max(date) from market.macro_observations
          where series_id = 'DTB3' and value is not null and date <= ${from}::date),
        ${from}::date)
    order by date
  `.execute(database);
  if (rows.rows.length === 0) return null;
  return { dates: rows.rows.map((r) => r.date), rate: rows.rows.map((r) => r.value / 100) };
}
