import "server-only";
import { tradingDaysBetween } from "@market/calendar";
import { OWNER_USER_ID } from "@market/config";
import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";
import {
  analyzePortfolio,
  benchmarkIndex,
  benchmarkReturn,
  portfolioRisk,
  type PortfolioReport,
  type PortfolioRisk,
  type ShareAction,
  type Tx,
  type TxType,
} from "@market/portfolio";
import { db } from "./db";
import { riskFreeRates } from "./market";

export interface PortfolioSummary {
  id: string;
  name: string;
  benchmark: string;
  count: number;
}

export async function listPortfolios(): Promise<PortfolioSummary[]> {
  const rows = await db()
    .selectFrom("portfolios as p")
    .leftJoin("transactions as t", "t.portfolio_id", "p.portfolio_id")
    .select((eb) => [
      "p.portfolio_id",
      "p.name",
      "p.benchmark_ticker",
      eb.fn.count<string>("t.transaction_id").as("count"),
    ])
    .where("p.user_id", "=", OWNER_USER_ID)
    .groupBy(["p.portfolio_id", "p.name", "p.benchmark_ticker"])
    .orderBy("p.name")
    .execute();
  return rows.map((r) => ({
    id: r.portfolio_id,
    name: r.name,
    benchmark: r.benchmark_ticker,
    count: Number(r.count),
  }));
}

export interface TxRow extends Tx {
  id: string;
  ticker: string | null;
  notes: string | null;
  source: string;
}

/** The owner's transactions in a portfolio, oldest first. */
export async function portfolioTransactions(portfolioId: string): Promise<TxRow[]> {
  const rows = await db()
    .selectFrom("transactions as t")
    .leftJoin("market.securities as s", "s.security_id", "t.security_id")
    .select([
      "t.transaction_id",
      "t.trade_date",
      "t.type",
      "t.security_id",
      "t.quantity",
      "t.price",
      "t.amount",
      "t.fees",
      "t.notes",
      "t.source",
      "s.ticker",
    ])
    .where("t.portfolio_id", "=", portfolioId)
    .where("t.user_id", "=", OWNER_USER_ID)
    .orderBy("t.trade_date")
    .orderBy("t.transaction_id")
    .execute();
  const n = (v: string | null) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    id: r.transaction_id,
    date: r.trade_date,
    type: r.type as TxType,
    securityId: r.security_id,
    quantity: n(r.quantity),
    price: n(r.price),
    amount: n(r.amount),
    fees: Number(r.fees),
    notes: r.notes,
    source: r.source,
    ticker: r.ticker,
  }));
}

/** Splits and stock dividends (share-count changes) from the price source. */
export async function shareActions(
  database: Database,
  source: ProviderId,
  securityIds: readonly string[],
): Promise<ShareAction[]> {
  if (securityIds.length === 0) return [];
  const rows = await database
    .selectFrom("market.corporate_actions")
    .select(["security_id", "ex_date", "ratio"])
    .where("source", "=", source)
    .where("type", "in", ["split", "stock_dividend"])
    .where("security_id", "in", securityIds)
    .orderBy("ex_date")
    .execute();
  return rows.map((r) => ({
    securityId: r.security_id,
    exDate: r.ex_date,
    ratio: Number(r.ratio),
  }));
}

export interface HoldingInfo {
  ticker: string;
  name: string;
  sector: string | null;
  assetClass: string;
}

export interface PortfolioView {
  report: PortfolioReport;
  /** Growth of 1 for the benchmark on the report's days; null before its first close. */
  benchmark: {
    ticker: string;
    index: (number | null)[];
    total: number | null;
    annualized: number | null;
  } | null;
  securities: Map<string, HoldingInfo>;
  /** Risk measures (Phase 2 step C1); `riskFree` says whether T-bill rates were available. */
  risk: PortfolioRisk;
  riskFree: boolean;
}

/**
 * Values a portfolio from end-of-day closes of the active price source (Phase 1 step J2), up to
 * the latest session loaded.
 */
export async function portfolioView(
  database: Database,
  source: ProviderId,
  session: string,
  txs: readonly TxRow[],
  benchmarkTicker: string,
): Promise<PortfolioView> {
  const ids = [...new Set(txs.flatMap((t) => (t.securityId ? [t.securityId] : [])))];
  const start = txs[0]?.date ?? session;
  const [priceRows, actions, info, bench] = await Promise.all([
    ids.length
      ? database
          .selectFrom("market.prices_daily")
          .select(["security_id", "date", "close"])
          .where("source", "=", source)
          .where("security_id", "in", ids)
          .where("date", ">=", sql<string>`${start}::date - 10`)
          .where("date", "<=", session)
          .orderBy("security_id")
          .orderBy("date")
          .execute()
      : Promise.resolve([]),
    shareActions(database, source, ids),
    ids.length
      ? database
          .selectFrom("market.securities")
          .select(["security_id", "ticker", "name", "sector", "asset_class"])
          .where("security_id", "in", ids)
          .execute()
      : Promise.resolve([]),
    sql<{ date: string; close: number }>`
      select a.date, a.close from market.prices_daily_adjusted a
      join market.securities s using (security_id)
      where s.ticker = ${benchmarkTicker} and a.source = ${source}
        and a.date >= ${start}::date and a.date <= ${session}::date
      order by a.date
    `.execute(database),
  ]);

  const prices = new Map<string, { dates: string[]; closes: number[] }>();
  for (const r of priceRows) {
    const series = prices.get(r.security_id) ?? { dates: [], closes: [] };
    series.dates.push(r.date);
    series.closes.push(Number(r.close));
    prices.set(r.security_id, series);
  }
  const report = analyzePortfolio(txs, actions, prices, { end: session });
  const days = report.days.map((d) => d.date);
  let benchmark: PortfolioView["benchmark"] = null;
  if (bench.rows.length > 0 && days.length > 0) {
    const index = benchmarkIndex(days, {
      dates: bench.rows.map((r) => r.date),
      closes: bench.rows.map((r) => r.close),
    });
    const ret = benchmarkReturn(days, index);
    benchmark = {
      ticker: benchmarkTicker,
      index,
      total: ret?.total ?? null,
      annualized: ret?.annualized ?? null,
    };
  }
  // Risk: session returns of the time-weighted index, T-bill rates, and a year of total
  // returns for the current holdings' correlations.
  const held = report.positions.map((p) => p.securityId);
  const [adjustedRows, rates] = await Promise.all([
    held.length
      ? sql<{ security_id: string; date: string; close: number }>`
          select security_id, date, close from market.prices_daily_adjusted
          where source = ${source} and security_id = any(${held}::bigint[])
            and date > ${session}::date - 400 and date <= ${session}::date
          order by security_id, date
        `.execute(database)
      : Promise.resolve({ rows: [] }),
    report.start ? riskFreeRates(database, report.start, session) : Promise.resolve(null),
  ]);
  const adjusted = new Map<string, { dates: string[]; closes: number[] }>();
  for (const r of adjustedRows.rows) {
    const series = adjusted.get(r.security_id) ?? { dates: [], closes: [] };
    series.dates.push(r.date);
    series.closes.push(r.close);
    adjusted.set(r.security_id, series);
  }
  const risk = portfolioRisk(report, {
    sessions: report.start ? tradingDaysBetween(report.start, session) : [],
    benchmark: benchmark?.index ?? null,
    riskFree: rates,
    adjusted,
  });

  return {
    report,
    benchmark,
    risk,
    riskFree: rates !== null,
    securities: new Map(
      info.map((s) => [
        s.security_id,
        { ticker: s.ticker, name: s.name, sector: s.sector, assetClass: s.asset_class },
      ]),
    ),
  };
}
