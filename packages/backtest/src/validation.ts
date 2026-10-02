import type { BacktestData } from "./data";
import { BacktestError } from "./engine";
import { equityMetrics, riskFreeReturns, type EquityMetrics } from "./metrics";
import { runBacktest, type BacktestReport } from "./report";
import { describeError, paramNames, resolveStrategy, type Strategy } from "./schema";

/**
 * Validation (Phase 2 step B6; spec §5.15): parameter sweeps, in-sample / out-of-sample splits
 * and walk-forward analysis.
 */

export const OBJECTIVES = ["cagr", "sharpe", "calmar", "total_return"] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** More combinations than this and the best result is likely overstated: say so. */
export const OVERFIT_WARNING_AT = 20;
export const MAX_COMBINATIONS = 400;
export const MAX_RUNS = 2000;

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

const summarize = (r: BacktestReport): Summary => ({
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

/** Every combination of the listed values, in a fixed order. */
export function combinations(
  params: Readonly<Record<string, readonly number[]>>,
): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const name of Object.keys(params).sort()) {
    const values = params[name]!;
    if (values.length === 0) throw new BacktestError(`no values listed for "${name}"`);
    out = out.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
  }
  return out;
}

export function overfitWarning(count: number): string | null {
  return count > OVERFIT_WARNING_AT
    ? `${count} parameter combinations were tested. The best of many tries usually looks better than it will do on new data; check it out of sample.`
    : null;
}

function withPeriod(input: unknown, start: string, end: string): unknown {
  return { ...(input as Record<string, unknown>), start, end };
}

/** Runs one strategy definition per combination over [start, end]. */
export function sweep(
  input: unknown,
  data: BacktestData,
  params: Readonly<Record<string, readonly number[]>>,
  objective: Objective,
  period?: { start: string; end: string },
  deadline?: number,
): { rows: SweepRow[]; best: SweepRow | null; combinations: number; warning: string | null } {
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
      if (err instanceof BacktestError && /time limit/.test(err.message)) throw err;
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

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}
const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export interface WalkForwardWindow {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
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
  combinations: number;
  warning: string | null;
}

/**
 * Walk-forward: choose parameters on each training window, then run them on the following test
 * window; the test windows chained together are the out-of-sample record.
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
  const base = resolveStrategy(
    input,
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v[0]!])),
  );
  const windows: WalkForwardWindow[] = [];
  let trainStart = base.start;
  for (;;) {
    const testStart = addMonths(trainStart, trainMonths);
    if (testStart > base.end) break;
    const testEnd = [dayBefore(addMonths(testStart, testMonths)), base.end].sort()[0]!;
    windows.push({
      trainStart,
      trainEnd: dayBefore(testStart),
      testStart,
      testEnd,
      chosen: null,
      inSample: null,
      outOfSample: null,
    });
    trainStart = addMonths(trainStart, testMonths);
  }
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
      const strategy: Strategy = resolveStrategy(
        withPeriod(input, w.testStart, w.testEnd),
        s.best.values,
      );
      test = runBacktest(strategy, data, { deadline });
    } catch (err) {
      if (err instanceof BacktestError && /time limit/.test(err.message)) throw err;
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
    combinations: combos,
    warning: overfitWarning(combos),
  };
}
