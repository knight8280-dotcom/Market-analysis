import type { BacktestData } from "./data";
import { lastIndexAtOrBefore } from "./data";
import { BacktestError } from "./engine";
import { equityMetrics, riskFreeReturns, type EquityMetrics } from "./metrics";
import { runBacktest, type BacktestReport } from "./report";
import {
  combinations,
  MAX_COMBINATIONS,
  MAX_RUNS,
  overfitWarning,
  walkForwardWindows,
  type Objective,
  type WindowDates,
} from "./request";
import { describeError, paramNames, resolveStrategy, type Strategy } from "./schema";

/**
 * Validation (Phase 2 step B6; spec §5.15): parameter sweeps, in-sample / out-of-sample splits
 * and walk-forward analysis.
 */

export interface Summary {
  totalReturn: number;
  cagr: number | null;
  sharpe: number | null;
  calmar: number | null;
  maxDrawdown: number;
  trades: number;
}

export interface SweepRow {
  values: Record<string, number>;
  summary: Summary | null;
  error: string | null;
}

export const summarize = (r: BacktestReport): Summary => ({
  totalReturn: r.metrics.totalReturn,
  cagr: r.metrics.cagr,
  sharpe: r.metrics.sharpe,
  calmar: r.metrics.calmar,
  maxDrawdown: r.metrics.maxDrawdown,
  trades: r.metrics.trades,
});

function score(s: Summary | null, objective: Objective): number | null {
  if (!s) return null;
  switch (objective) {
    case "cagr":
      return s.cagr;
    case "sharpe":
      return s.sharpe;
    case "calmar":
      return s.calmar;
    case "total_return":
      return s.totalReturn;
  }
}

const isTimeLimit = (err: unknown) =>
  err instanceof BacktestError && /time limit/.test(err.message);

function withPeriod(input: unknown, start: string, end: string): unknown {
  return { ...(input as Record<string, unknown>), start, end };
}

export interface SweepResult {
  rows: SweepRow[];
  best: SweepRow | null;
  combinations: number;
  warning: string | null;
}

/** Runs one strategy definition per combination over [start, end]. */
export function sweep(
  input: unknown,
  data: BacktestData,
  params: Readonly<Record<string, readonly number[]>>,
  objective: Objective,
  period?: { start: string; end: string },
  deadline?: number,
): SweepResult {
  const missing = paramNames(input).filter((n) => !(n in params));
  if (missing.length) throw new BacktestError(`no values for parameter ${missing.join(", ")}`);
  const combos = combinations(params);
  if (combos.length > MAX_COMBINATIONS) {
    throw new BacktestError(
      `${combos.length} combinations is more than the ${MAX_COMBINATIONS} allowed in one sweep`,
    );
  }
  const rows: SweepRow[] = combos.map((values) => {
    try {
      const s = resolveStrategy(
        period ? withPeriod(input, period.start, period.end) : input,
        values,
      );
      return { values, summary: summarize(runBacktest(s, data, { deadline })), error: null };
    } catch (err) {
      if (isTimeLimit(err)) throw err;
      return { values, summary: null, error: describeError(err) };
    }
  });
  let best: SweepRow | null = null;
  for (const row of rows) {
    const s = score(row.summary, objective);
    if (s === null) continue;
    const b = best ? score(best.summary, objective) : null;
    if (b === null || s > b) best = row;
  }
  return { rows, best, combinations: combos.length, warning: overfitWarning(combos.length) };
}

export interface SplitReport {
  split: string;
  inSample: EquityMetrics | null;
  outOfSample: EquityMetrics | null;
}

/** Metrics of one run before and after a date (the strategy is the same in both parts). */
export function splitMetrics(
  report: BacktestReport,
  split: string,
  data: BacktestData,
): SplitReport {
  const { dates, equity } = report.series;
  const k = dates.findIndex((d) => d >= split);
  const part = (from: number, to: number) => {
    if (to - from < 2) return null;
    const ds = dates.slice(from, to);
    return equityMetrics(ds, equity.slice(from, to), riskFreeReturns(ds, data.riskFree));
  };
  if (k < 0) return { split, inSample: part(0, dates.length), outOfSample: null };
  return { split, inSample: part(0, k), outOfSample: part(Math.max(k - 1, 0), dates.length) };
}

export interface WalkForwardWindow extends WindowDates {
  chosen: Record<string, number> | null;
  inSample: Summary | null;
  outOfSample: Summary | null;
}

export interface WalkForwardReport {
  windows: WalkForwardWindow[];
  /** Out-of-sample sessions chained window after window. */
  dates: string[];
  equity: number[];
  metrics: EquityMetrics | null;
  /** The benchmark over the same sessions, scaled to the same starting value. */
  benchmark: { ticker: string; values: (number | null)[]; metrics: EquityMetrics | null } | null;
  combinations: number;
  warning: string | null;
}

/** Benchmark total-return values on `dates`, scaled to `base` on the first date it has. */
function benchmarkOn(
  data: BacktestData,
  dates: readonly string[],
  base: number,
): WalkForwardReport["benchmark"] {
  const b = data.benchmark;
  if (!b || dates.length === 0) return null;
  const raw = dates.map((d) => {
    const i = lastIndexAtOrBefore(b.dates, d);
    return i >= 0 ? b.adjClose[i]! : null;
  });
  const first = raw.findIndex((v) => v !== null);
  if (first < 0) return null;
  const values = raw.map((v) => (v === null ? null : (base * v) / raw[first]!));
  const ds = dates.slice(first);
  return {
    ticker: b.ticker,
    values,
    metrics:
      ds.length >= 2
        ? equityMetrics(ds, values.slice(first) as number[], riskFreeReturns(ds, data.riskFree))
        : null,
  };
}

/**
 * Walk-forward: choose parameters on each training window, then run them on the following test
 * window; the test windows chained together are the out-of-sample record. Each test window
 * starts in cash with the value the previous one ended with.
 */
export function walkForward(
  input: unknown,
  data: BacktestData,
  params: Readonly<Record<string, readonly number[]>>,
  objective: Objective,
  trainMonths: number,
  testMonths: number,
  deadline?: number,
): WalkForwardReport {
  const base: Strategy = resolveStrategy(
    input,
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v[0]!])),
  );
  const windows: WalkForwardWindow[] = walkForwardWindows(
    base.start,
    base.end,
    trainMonths,
    testMonths,
  ).map((w) => ({ ...w, chosen: null, inSample: null, outOfSample: null }));
  if (windows.length === 0) {
    throw new BacktestError("the period is too short for one training window and one test window");
  }
  const combos = combinations(params).length;
  if (combos * windows.length > MAX_RUNS) {
    throw new BacktestError(`${combos * windows.length} runs is more than the ${MAX_RUNS} allowed`);
  }

  const dates: string[] = [];
  const equity: number[] = [];
  let level = base.initialCapital;
  for (const w of windows) {
    const s = sweep(
      input,
      data,
      params,
      objective,
      { start: w.trainStart, end: w.trainEnd },
      deadline,
    );
    if (!s.best) continue;
    w.chosen = s.best.values;
    w.inSample = s.best.summary;
    let test: BacktestReport;
    try {
      const strategy = resolveStrategy(withPeriod(input, w.testStart, w.testEnd), s.best.values);
      test = runBacktest(strategy, data, { deadline });
    } catch (err) {
      if (isTimeLimit(err)) throw err;
      continue;
    }
    w.outOfSample = summarize(test);
    const start = test.series.equity[0]!;
    test.series.dates.forEach((d, i) => {
      if (dates.length && d <= dates[dates.length - 1]!) return;
      dates.push(d);
      equity.push((level * test.series.equity[i]!) / start);
    });
    level = equity[equity.length - 1] ?? level;
  }
  return {
    windows,
    dates,
    equity,
    metrics:
      dates.length >= 2
        ? equityMetrics(dates, equity, riskFreeReturns(dates, data.riskFree))
        : null,
    benchmark: benchmarkOn(data, dates, base.initialCapital),
    combinations: combos,
    warning: overfitWarning(combos),
  };
}
