import {
  fundamentalTimeline,
  sharesTimeline,
  warmupSessions,
  type BacktestData,
  type IncomeRow,
  type SecurityData,
  type Strategy,
} from "@market/backtest";
import {
  addDays,
  CALENDAR_FIRST_YEAR,
  previousTradingDay,
  tradingDaysBetween,
} from "@market/calendar";
import { sql, type Database } from "@market/db";

/**
 * Loads what a backtest reads (Phase 2 steps B3 and B7) from the database: raw bars with their
 * adjustment factors, splits and dividends, point-in-time fundamentals, the benchmark and the
 * risk-free rate. Everything comes from one price source, so series are never mixed.
 */

/** Asset classes behind the strategy's universe choices. */
export const ASSET_CLASSES = {
  equity: ["equity", "adr"],
  etf: ["etf"],
  any: ["equity", "adr", "etf"],
} as const;

export interface LoadedInputs {
  source: string;
  warmupSessions: number;
  /** First session loaded (warm-up included) and the run's own first and last sessions. */
  loadedFrom: string;
  runFrom: string;
  runTo: string;
  securities: { ticker: string; securityId: string; bars: number; delistedAt: string | null }[];
  benchmark: { ticker: string; available: boolean } | null;
  riskFree: { series: "DTB3"; available: boolean };
  notes: string[];
}

export class DataError extends Error {}

const usesFundamentals = (s: Strategy) => JSON.stringify(s).includes('"kind":"fundamental"');

/** The session `n` sessions before `date`, stopping at the start of the market calendar. */
function sessionsBefore(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) {
    const prev = previousTradingDay(d);
    if (Number(prev.slice(0, 4)) < CALENDAR_FIRST_YEAR) break;
    d = prev;
  }
  return d;
}

interface UniverseRow {
  security_id: string;
  ticker: string;
  delisted_at: string | null;
  cik: string | null;
}

/**
 * The securities a strategy trades. A listed ticker means the security that held it last
 * within the period (so a renamed company keeps its earlier history), and every security is
 * a member from its first bar until it delisted. "All" is every stored security of the asset
 * classes with prices in the period, delisted ones included (survivorship-free).
 */
async function universe(
  db: Database,
  s: Strategy,
  source: string,
  from: string,
  notes: string[],
): Promise<UniverseRow[]> {
  if (s.universe.kind === "tickers") {
    const tickers = s.universe.tickers;
    const rows = await sql<UniverseRow & { requested: string; valid_from: string }>`
      select h.ticker as requested, h.valid_from, h.security_id, s.ticker, s.delisted_at, s.cik
      from market.security_symbol_history h
      join market.securities s using (security_id)
      where h.ticker = any(${tickers}::text[])
        and h.valid_from <= ${s.end}::date
        and (h.valid_to is null or h.valid_to > ${from}::date)
      order by h.ticker, h.valid_from desc
    `.execute(db);
    const out: UniverseRow[] = [];
    for (const t of tickers) {
      const held = rows.rows.filter((r) => r.requested === t);
      if (held.length === 0) {
        throw new DataError(`no security had the ticker ${t} between ${from} and ${s.end}`);
      }
      const chosen = held[0]!;
      const others = new Set(
        held.map((r) => r.security_id).filter((id) => id !== chosen.security_id),
      );
      if (others.size) {
        notes.push(
          `${t} also named ${others.size === 1 ? "another security" : `${others.size} other securities`} earlier in the period; the test uses the one that had it from ${chosen.valid_from}.`,
        );
      }
      out.push(chosen);
    }
    return out;
  }
  const classes = [...ASSET_CLASSES[s.universe.assetClass]];
  const rows = await sql<UniverseRow>`
    select s.security_id, s.ticker, s.delisted_at, s.cik
    from market.securities s
    where s.asset_class = any(${classes}::text[])
      and exists (
        select 1 from market.prices_daily p
        where p.security_id = s.security_id and p.source = ${source}
          and p.date between ${s.start}::date and ${s.end}::date
      )
    order by s.security_id
  `.execute(db);
  return rows.rows;
}

export async function loadBacktestData(
  db: Database,
  s: Strategy,
  opts: { source: string; warmup?: number },
): Promise<{ data: BacktestData; inputs: LoadedInputs }> {
  const source = opts.source;
  const warmup = opts.warmup ?? warmupSessions(s);
  const notes: string[] = [];
  const from = sessionsBefore(s.start, warmup);

  const members = await universe(db, s, source, from, notes);
  const byId = new Map(members.map((m) => [m.security_id, m]));
  const ids = [...byId.keys()];

  const bars = await sql<{
    security_id: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>`
    select security_id, date, open::float8 as open, high::float8 as high, low::float8 as low,
      close::float8 as close, volume::float8 as volume
    from market.prices_daily
    where security_id = any(${ids}::bigint[]) and source = ${source}
      and date between ${from}::date and ${s.end}::date
    order by security_id, date
  `.execute(db);
  const factors = await sql<{
    security_id: string;
    ex_date: string;
    split_factor: number;
    dividend_factor: number;
  }>`
    select security_id, ex_date, split_factor, dividend_factor
    from market.adjustment_factors
    where security_id = any(${ids}::bigint[])
    order by security_id, ex_date
  `.execute(db);
  const actions = await sql<{
    security_id: string;
    type: string;
    ex_date: string;
    ratio: number | null;
    cash_amount: number | null;
  }>`
    select security_id, type, ex_date, ratio::float8 as ratio, cash_amount::float8 as cash_amount
    from market.corporate_actions
    where security_id = any(${ids}::bigint[]) and source = ${source}
      and ex_date > ${from}::date and ex_date <= ${s.end}::date
    order by security_id, ex_date, type
  `.execute(db);

  const group = <T extends { security_id: string }>(rows: T[]) => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const list = out.get(r.security_id);
      if (list) list.push(r);
      else out.set(r.security_id, [r]);
    }
    return out;
  };
  const barsBy = group(bars.rows);
  const factorsBy = group(factors.rows);
  const actionsBy = group(actions.rows);

  const fundamentals = new Map<string, { income: IncomeRow[]; shares: SharesRow[] }>();
  if (usesFundamentals(s)) {
    const ciks = [...new Set(members.map((m) => m.cik).filter((c): c is string => c !== null))];
    for (const [cik, f] of await loadFundamentals(db, ciks)) fundamentals.set(cik, f);
  }

  const securities: SecurityData[] = [];
  const inputs: LoadedInputs["securities"] = [];
  for (const id of ids) {
    const rows = barsBy.get(id) ?? [];
    const member = byId.get(id)!;
    const ticker = member.ticker;
    // Factors in force on each bar: the first one with an ex-date after it (as in
    // market.prices_daily_adjusted).
    const fs = factorsBy.get(id) ?? [];
    const splitFactor: number[] = [];
    const dividendFactor: number[] = [];
    let k = 0;
    for (const r of rows) {
      while (k < fs.length && fs[k]!.ex_date <= r.date) k++;
      splitFactor.push(fs[k]?.split_factor ?? 1);
      dividendFactor.push(fs[k]?.dividend_factor ?? 1);
    }
    const acts = actionsBy.get(id) ?? [];
    for (const a of acts) {
      if (a.type === "spin_off" || a.type === "merger") {
        notes.push(
          `${ticker} had a ${a.type.replace("_", "-")} on ${a.ex_date}; prices are not adjusted for it and the backtest does not model it.`,
        );
      }
    }
    const f = member.cik ? fundamentals.get(member.cik) : undefined;
    securities.push({
      securityId: id,
      ticker,
      bars: {
        dates: rows.map((r) => r.date),
        open: rows.map((r) => r.open),
        high: rows.map((r) => r.high),
        low: rows.map((r) => r.low),
        close: rows.map((r) => r.close),
        volume: rows.map((r) => r.volume),
        splitFactor,
        dividendFactor,
      },
      shareChanges: acts
        .filter((a) => (a.type === "split" || a.type === "stock_dividend") && a.ratio! > 0)
        .map((a) => ({ exDate: a.ex_date, ratio: a.ratio! })),
      dividends: acts
        .filter(
          (a) =>
            (a.type === "cash_dividend" || a.type === "special_dividend") && a.cash_amount! > 0,
        )
        .map((a) => ({ exDate: a.ex_date, amount: a.cash_amount! })),
      fundamentals: f ? fundamentalTimeline(f.income) : [],
      shares: f
        ? sharesTimeline(
            f.shares.map((x) => ({ shares: x.value, asOf: x.period_end, filed: x.filed_at })),
          )
        : [],
      // A member from its first bar; a delisted security leaves the day before it delisted.
      membership: [{ from, to: member.delisted_at ? addDays(member.delisted_at, -1) : null }],
      delistedAt: member.delisted_at,
    });
    inputs.push({ ticker, securityId: id, bars: rows.length, delistedAt: member.delisted_at });
    if (rows.length === 0) notes.push(`${ticker} has no ${source} prices in the period.`);
  }

  const firstBar = bars.rows.reduce<string | null>(
    (m, r) => (m === null || r.date < m ? r.date : m),
    null,
  );
  const lastBar = bars.rows.reduce<string | null>(
    (m, r) => (m === null || r.date > m ? r.date : m),
    null,
  );
  if (firstBar === null || lastBar === null || lastBar < s.start) {
    throw new DataError(`no ${source} prices for these securities between ${s.start} and ${s.end}`);
  }
  const sessions = tradingDaysBetween(firstBar, lastBar);
  const runFrom = sessions.find((d) => d >= s.start)!;
  if (firstBar > s.start) notes.push(`Prices start on ${firstBar}; the test starts there.`);
  if (lastBar < s.end) notes.push(`Prices end on ${lastBar}; the test ends there.`);

  const benchmark = s.benchmark
    ? await loadBenchmark(db, s.benchmark, source, s.start, lastBar)
    : null;
  if (s.benchmark && !benchmark) {
    notes.push(`The benchmark ${s.benchmark} has no ${source} prices in the period.`);
  }
  const riskFree = await loadRiskFree(db, runFrom, lastBar);
  if (!riskFree) {
    notes.push(
      "No 3-month T-bill rate (FRED DTB3) is stored, so Sharpe and Sortino are unavailable.",
    );
  }

  return {
    data: { sessions, securities, benchmark, riskFree },
    inputs: {
      source,
      warmupSessions: warmup,
      loadedFrom: sessions[0]!,
      runFrom,
      runTo: lastBar < s.end ? lastBar : sessions.at(-1)!,
      securities: inputs,
      benchmark: s.benchmark ? { ticker: s.benchmark, available: benchmark !== null } : null,
      riskFree: { series: "DTB3", available: riskFree !== null },
      notes,
    },
  };
}

interface SharesRow {
  value: number;
  period_end: string;
  filed_at: string;
}

type Items = Record<string, { value: string; filed: string } | undefined>;

/** As-reported income lines and cover-page share counts per CIK. */
async function loadFundamentals(db: Database, ciks: string[]) {
  const out = new Map<string, { income: IncomeRow[]; shares: SharesRow[] }>();
  if (ciks.length === 0) return out;
  const statements = await db
    .selectFrom("market.financial_statements")
    .select(["cik", "frequency", "period_end", "line_items"])
    .where("cik", "in", ciks)
    .where("statement", "=", "income")
    .where("basis", "=", "as_reported")
    .orderBy("period_end")
    .execute();
  const shares = await sql<SharesRow & { cik: string }>`
    select cik, value::float8 as value, period_end, filed_at
    from market.fundamentals_facts
    where cik = any(${ciks}::text[]) and unit = 'shares'
      and ((taxonomy = 'dei' and concept = 'EntityCommonStockSharesOutstanding')
        or (taxonomy = 'us-gaap' and concept = 'CommonStockSharesOutstanding'))
    order by cik, filed_at, period_end
  `.execute(db);
  for (const cik of ciks) out.set(cik, { income: [], shares: [] });
  const filed = (v: { value: string; filed: string } | undefined) =>
    v ? { value: Number(v.value), filed: v.filed } : null;
  for (const r of statements) {
    const items = r.line_items as unknown as Items;
    out.get(r.cik)!.income.push({
      frequency: r.frequency as IncomeRow["frequency"],
      periodEnd: r.period_end,
      revenue: filed(items.revenue),
      netIncome: filed(items.netIncome),
    });
  }
  for (const r of shares.rows) out.get(r.cik)!.shares.push(r);
  return out;
}

/** Total-return closes of the security that had `ticker` at the end of the run. */
async function loadBenchmark(
  db: Database,
  ticker: string,
  source: string,
  start: string,
  end: string,
): Promise<BacktestData["benchmark"]> {
  const rows = await sql<{ date: string; close: number }>`
    select a.date, a.close
    from market.prices_daily_adjusted a
    where a.source = ${source} and a.date between ${start}::date and ${end}::date
      and a.security_id = (
        select h.security_id from market.security_symbol_history h
        where h.ticker = ${ticker} and h.valid_from <= ${end}::date
        order by h.valid_from desc limit 1
      )
    order by a.date
  `.execute(db);
  if (rows.rows.length === 0) return null;
  return {
    ticker,
    dates: rows.rows.map((r) => r.date),
    adjClose: rows.rows.map((r) => r.close),
  };
}

/** FRED DTB3 (percent) as decimal annual rates, from the last observation on or before `from`. */
async function loadRiskFree(
  db: Database,
  from: string,
  to: string,
): Promise<BacktestData["riskFree"]> {
  const rows = await sql<{ date: string; value: number }>`
    select date, value::float8 as value from market.macro_observations
    where series_id = 'DTB3' and value is not null and date <= ${to}::date
      and date >= coalesce(
        (select max(date) from market.macro_observations
          where series_id = 'DTB3' and value is not null and date <= ${from}::date),
        ${from}::date)
    order by date
  `.execute(db);
  if (rows.rows.length === 0) return null;
  return { dates: rows.rows.map((r) => r.date), rate: rows.rows.map((r) => r.value / 100) };
}
