import { mean } from "@market/metrics";
import type { Fill, Trade } from "./engine";

/**
 * Report metrics (Phase 2 step B4). Equity measures (returns, volatility, Sharpe, Sortino,
 * drawdowns, CAGR, monthly returns) come from @market/metrics, shared with portfolio risk; the
 * trade measures are the engine's own:
 * - win rate and profit factor use closed trades; open trades are listed but not counted;
 * - turnover = (bought + sold) ÷ 2 ÷ average equity, per year.
 */
export {
  dailyReturns,
  equityMetrics,
  monthlyReturns,
  riskFreeReturns,
  type EquityMetrics,
  type MonthlyReturn,
} from "@market/metrics";

export interface TradeMetrics {
  trades: number;
  openTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageSessionsHeld: number | null;
}

const DAY = 86_400_000;

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
