import type { BacktestData } from "./data";
import { ENGINE_VERSION, simulate, type Fill, type Trade } from "./engine";
import {
  equityMetrics,
  exposureAndTurnover,
  monthlyReturns,
  riskFreeReturns,
  tradeMetrics,
  type EquityMetrics,
  type MonthlyReturn,
  type TradeMetrics,
} from "./metrics";
import type { Strategy } from "./schema";

export interface BacktestReport {
  engineVersion: string;
  strategy: Strategy;
  sessions: { first: string; last: string; count: number };
  metrics: EquityMetrics & TradeMetrics & { exposure: number; turnover: number | null };
  benchmark: { ticker: string; metrics: EquityMetrics; from: string } | null;
  riskFreeAvailable: boolean;
  series: {
    dates: string[];
    equity: number[];
    benchmark: (number | null)[];
    drawdown: number[];
    exposure: number[];
  };
  monthly: MonthlyReturn[];
  trades: Trade[];
  fills: Fill[];
  warnings: string[];
}

/** Runs a strategy and computes its report (Phase 2 steps B2 and B4). */
export function runBacktest(
  strategy: Strategy,
  data: BacktestData,
  opts: { deadline?: number } = {},
): BacktestReport {
  const sim = simulate(strategy, data, opts);
  const rf = riskFreeReturns(sim.dates, data.riskFree);
  const equity = equityMetrics(sim.dates, sim.equity, rf);
  const trades = tradeMetrics(sim.trades);
  const usage = exposureAndTurnover(sim.dates, sim.equity, sim.exposure, sim.fills);

  let benchmark: BacktestReport["benchmark"] = null;
  const first = sim.benchmark.findIndex((v) => v !== null);
  if (data.benchmark && first >= 0 && first < sim.dates.length - 1) {
    const dates = sim.dates.slice(first);
    const values = sim.benchmark.slice(first) as number[];
    benchmark = {
      ticker: data.benchmark.ticker,
      metrics: equityMetrics(dates, values, riskFreeReturns(dates, data.riskFree)),
      from: dates[0]!,
    };
  }

  let peak = -Infinity;
  const drawdown = sim.equity.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? v / peak - 1 : 0;
  });

  return {
    engineVersion: ENGINE_VERSION,
    strategy,
    sessions: {
      first: sim.dates[0]!,
      last: sim.dates[sim.dates.length - 1]!,
      count: sim.dates.length,
    },
    metrics: { ...equity, ...trades, ...usage },
    benchmark,
    riskFreeAvailable: rf !== null,
    series: {
      dates: sim.dates,
      equity: sim.equity,
      benchmark: sim.benchmark,
      drawdown,
      exposure: sim.exposure,
    },
    monthly: monthlyReturns(sim.dates, sim.equity),
    trades: sim.trades,
    fills: sim.fills,
    warnings: sim.warnings,
  };
}
