import {
  beta,
  concentration,
  correlation,
  correlationMatrix,
  dailyReturns,
  equityMetrics,
  lastIndexAtOrBefore,
  riskFreeReturns,
} from "@market/metrics";
import type { PortfolioReport, PriceBook } from "./types";

/**
 * Portfolio risk (Phase 2 step C1). Measured on the time-weighted index at each market session,
 * so deposits and withdrawals never count as gains or losses, with the same definitions as
 * backtest reports (@market/metrics): volatility, Sharpe and Sortino against the 3-month T-bill
 * (FRED DTB3), drawdown duration in sessions, beta and correlation against the benchmark, the
 * correlation of current holdings over the past year, concentration and daily P&L.
 */

export interface RiskInputs {
  /** Market sessions from the first transaction to the end (exchange calendar). */
  sessions: readonly string[];
  /** The benchmark's growth index on the report's days (`benchmarkIndex`), or null. */
  benchmark: readonly (number | null)[] | null;
  /** 3-month T-bill rates (FRED DTB3) as decimal annual rates by observation date. */
  riskFree: { dates: readonly string[]; rate: readonly number[] } | null;
  /** Total-return (adjusted) closes of the securities held at the end, for their correlations. */
  adjusted?: PriceBook;
  /** Sessions of history behind the correlation matrix (default 252, about a year). */
  correlationWindow?: number;
}

export interface PortfolioRisk {
  /** Sessions the measures cover; null before the portfolio has two. */
  sessions: { first: string; last: string; count: number } | null;
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  /** Longest drawdown of the time-weighted index: sessions from a peak until it is regained. */
  maxDrawdownDuration: number | null;
  beta: number | null;
  correlation: number | null;
  /** Session returns paired with the benchmark's. */
  benchmarkObservations: number;
  /** Change in value each day not explained by money moving in or out. */
  dailyPnl: { date: string; pnl: number }[];
  /** Weights among holdings (cash excluded), plus cash's share of the whole. */
  concentration: {
    top10: number;
    hhi: number;
    effectiveCount: number;
    count: number;
    cashWeight: number;
  } | null;
  /** Correlation of daily total returns between current holdings. */
  correlations: {
    securityIds: string[];
    matrix: (number | null)[][];
    from: string;
    to: string;
    sessions: number;
  } | null;
}

/** Values of a series known at each session: the last one on or before it. */
function atSessions<T>(
  dates: readonly string[],
  values: readonly T[],
  sessions: readonly string[],
): (T | null)[] {
  return sessions.map((s) => {
    const k = lastIndexAtOrBefore(dates, s);
    return k >= 0 ? values[k]! : null;
  });
}

function returnsOf(values: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    out.push(
      a !== null && a !== undefined && b !== null && b !== undefined && a > 0 ? b / a - 1 : null,
    );
  }
  return out;
}

/** Daily total returns of each holding on the dates it traded, over the trailing window. */
function holdingCorrelations(
  ids: readonly string[],
  adjusted: PriceBook,
  end: string,
  window: number,
): PortfolioRisk["correlations"] {
  const usable = ids.filter((id) => (adjusted.get(id)?.dates.length ?? 0) > 2);
  if (usable.length < 2) return null;
  const all = [...new Set(usable.flatMap((id) => adjusted.get(id)!.dates))]
    .filter((d) => d <= end)
    .sort();
  const dates = all.slice(-(window + 1));
  if (dates.length < 3) return null;
  const series = usable.map((id) => {
    const s = adjusted.get(id)!;
    const byDate = new Map(s.dates.map((d, i) => [d, s.closes[i]!]));
    // Only closes on the day itself: carrying a stale close forward would add false zero returns.
    return returnsOf(dates.map((d) => byDate.get(d) ?? null));
  });
  return {
    securityIds: usable,
    matrix: correlationMatrix(series),
    from: dates[0]!,
    to: dates.at(-1)!,
    sessions: dates.length - 1,
  };
}

export function portfolioRisk(report: PortfolioReport, inputs: RiskInputs): PortfolioRisk {
  const dayDates = report.days.map((d) => d.date);
  const sessions =
    report.start === null
      ? []
      : inputs.sessions.filter((s) => s >= report.start! && s <= report.end);

  let prev = 0;
  const dailyPnl = report.days.map((d) => {
    const pnl = d.value - prev - d.flow;
    prev = d.value;
    return { date: d.date, pnl };
  });

  const positions = report.positions.filter((p) => p.quantity > 0);
  const weights = concentration(positions.map((p) => p.marketValue));
  const concentrationOut = weights
    ? { ...weights, cashWeight: report.value > 0 ? report.cash / report.value : 0 }
    : null;
  const correlations = inputs.adjusted
    ? holdingCorrelations(
        positions.map((p) => p.securityId),
        inputs.adjusted,
        report.end,
        inputs.correlationWindow ?? 252,
      )
    : null;

  const index = atSessions(
    dayDates,
    report.days.map((d) => d.index),
    sessions,
  );
  if (sessions.length < 2 || index.some((v) => v === null)) {
    return {
      sessions: null,
      volatility: null,
      sharpe: null,
      sortino: null,
      maxDrawdownDuration: null,
      beta: null,
      correlation: null,
      benchmarkObservations: 0,
      dailyPnl,
      concentration: concentrationOut,
      correlations,
    };
  }
  const values = index as number[];
  const m = equityMetrics(sessions, values, riskFreeReturns(sessions, inputs.riskFree));
  const portfolioReturns = dailyReturns(values);
  const benchmarkReturns = inputs.benchmark
    ? returnsOf(atSessions(dayDates, inputs.benchmark, sessions))
    : null;
  const pairs = benchmarkReturns
    ? portfolioReturns.filter((_, i) => benchmarkReturns[i] !== null).length
    : 0;

  return {
    sessions: { first: sessions[0]!, last: sessions.at(-1)!, count: sessions.length },
    volatility: m.volatility,
    sharpe: m.sharpe,
    sortino: m.sortino,
    maxDrawdownDuration: m.maxDrawdownDuration,
    beta: benchmarkReturns ? beta(portfolioReturns, benchmarkReturns) : null,
    correlation: benchmarkReturns ? correlation(portfolioReturns, benchmarkReturns) : null,
    benchmarkObservations: pairs,
    dailyPnl,
    concentration: concentrationOut,
    correlations,
  };
}
