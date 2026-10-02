import { lastIndexAtOrBefore } from "./data";
import type { Fill, Trade } from "./engine";

/**
 * Report metrics (Phase 2 step B4). Conventions, also stated on the report page:
 * - daily returns are simple returns between consecutive closes;
 * - volatility is their sample standard deviation × √252;
 * - the risk-free rate is the 3-month T-bill rate (FRED DTB3) ÷ 252 per session, using the
 *   latest observation on or before each session; Sharpe and Sortino are unavailable without it;
 * - Sharpe = mean excess return ÷ its sample standard deviation × √252;
 * - Sortino = mean excess return ÷ downside deviation (root mean square of the negative excess
 *   returns over all sessions) × √252;
 * - CAGR uses calendar time: (end ÷ start)^(365.25 ÷ days) − 1;
 * - drawdown duration counts sessions from a peak until the value first regains it (or the end);
 * - win rate and profit factor use closed trades; open trades are listed but not counted;
 * - turnover = (bought + sold) ÷ 2 ÷ average equity, per year.
 */

export interface EquityMetrics {
  startValue: number;
  endValue: number;
  totalReturn: number;
  cagr: number | null;
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  calmar: number | null;
  bestMonth: number | null;
  worstMonth: number | null;
}

export interface TradeMetrics {
  trades: number;
  openTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageSessionsHeld: number | null;
}

export interface MonthlyReturn {
  month: string;
  return: number;
}

const DAY = 86_400_000;

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function dailyReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i - 1]! > 0 ? values[i]! / values[i - 1]! - 1 : 0);
  }
  return out;
}

/** Per-session risk-free returns for sessions[1..], or null without a rate series. */
export function riskFreeReturns(
  sessions: readonly string[],
  riskFree: { dates: string[]; rate: number[] } | null,
): number[] | null {
  if (!riskFree || riskFree.dates.length === 0) return null;
  const out: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const k = lastIndexAtOrBefore(riskFree.dates, sessions[i]!);
    if (k < 0) return null;
    out.push(riskFree.rate[k]! / 252);
  }
  return out;
}

export function monthlyReturns(
  dates: readonly string[],
  values: readonly number[],
): MonthlyReturn[] {
  const out: MonthlyReturn[] = [];
  let base = values[0]!;
  for (let i = 0; i < dates.length; i++) {
    const month = dates[i]!.slice(0, 7);
    const last = i === dates.length - 1 || dates[i + 1]!.slice(0, 7) !== month;
    if (last) {
      out.push({ month, return: base > 0 ? values[i]! / base - 1 : 0 });
      base = values[i]!;
    }
  }
  return out;
}

export function equityMetrics(
  dates: readonly string[],
  values: readonly number[],
  riskFree: readonly number[] | null,
): EquityMetrics {
  const startValue = values[0]!;
  const endValue = values[values.length - 1]!;
  const totalReturn = startValue > 0 ? endValue / startValue - 1 : 0;
  const elapsed = (Date.parse(dates[dates.length - 1]!) - Date.parse(dates[0]!)) / DAY;
  const cagr =
    elapsed > 0 && startValue > 0 && endValue > 0
      ? (endValue / startValue) ** (365.25 / elapsed) - 1
      : null;
  const r = dailyReturns(values);
  const sd = sampleStd(r);
  const volatility = sd === null ? null : sd * Math.sqrt(252);

  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (riskFree && riskFree.length === r.length && r.length >= 2) {
    const excess = r.map((x, i) => x - riskFree[i]!);
    const m = mean(excess);
    const esd = sampleStd(excess);
    if (esd !== null && esd > 0) sharpe = (m / esd) * Math.sqrt(252);
    const downside = Math.sqrt(mean(excess.map((x) => Math.min(x, 0) ** 2)));
    if (downside > 0) sortino = (m / downside) * Math.sqrt(252);
  }

  let peak = values[0]!;
  let peakIndex = 0;
  let underwater = false;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v >= peak) {
      if (underwater) maxDrawdownDuration = Math.max(maxDrawdownDuration, i - peakIndex);
      underwater = false;
      peak = v;
      peakIndex = i;
    } else {
      underwater = true;
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? 1 - v / peak : 0);
    }
  }
  // Still under water at the end.
  if (underwater) {
    maxDrawdownDuration = Math.max(maxDrawdownDuration, values.length - 1 - peakIndex);
  }
  const months = monthlyReturns(dates, values).map((m) => m.return);

  return {
    startValue,
    endValue,
    totalReturn,
    cagr,
    volatility,
    sharpe,
    sortino,
    maxDrawdown,
    maxDrawdownDuration,
    calmar: cagr !== null && maxDrawdown > 0 ? cagr / maxDrawdown : null,
    bestMonth: months.length ? Math.max(...months) : null,
    worstMonth: months.length ? Math.min(...months) : null,
  };
}

export function tradeMetrics(trades: readonly Trade[]): TradeMetrics {
  const closed = trades.filter((t) => t.exitReason !== "open");
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  return {
    trades: closed.length,
    openTrades: trades.length - closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? -grossLoss / losses.length : null,
    averageSessionsHeld: closed.length ? mean(closed.map((t) => t.sessionsHeld)) : null,
  };
}

export function exposureAndTurnover(
  dates: readonly string[],
  equity: readonly number[],
  exposure: readonly number[],
  fills: readonly Fill[],
): { exposure: number; turnover: number | null } {
  const traded = fills
    .filter((f) => f.reason !== "dividend_reinvest" && f.reason !== "delisted")
    .reduce((s, f) => s + f.shares * f.price, 0);
  const years = (Date.parse(dates[dates.length - 1]!) - Date.parse(dates[0]!)) / DAY / 365.25;
  const avgEquity = mean(equity);
  return {
    exposure: mean(exposure),
    turnover: years > 0 && avgEquity > 0 ? traded / 2 / avgEquity / years : null,
  };
}
