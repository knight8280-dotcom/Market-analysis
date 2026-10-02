import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { equityMetrics, monthlyReturns, riskFreeReturns, tradeMetrics, type Trade } from "../src";

/** Report metrics against their independent textbook computation (scripts/make_fixtures.py). */
interface MetricsFixture {
  sessions: string[];
  values: number[];
  riskFree: { dates: string[]; rate: number[] };
  trades: { pnl: number; sessionsHeld: number; open: boolean }[];
  expected: Record<string, number> & { monthly: { month: string; return: number }[] };
}
const fx = JSON.parse(
  readFileSync(new URL("./fixtures/metrics.json", import.meta.url), "utf8"),
) as MetricsFixture;

const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(Math.abs(a! - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.max(Math.abs(b) * 1e-9, 1e-12));
};

describe("equity metrics", () => {
  const rf = riskFreeReturns(fx.sessions, fx.riskFree);
  const m = equityMetrics(fx.sessions, fx.values, rf);

  it("match the reference", () => {
    for (const key of [
      "totalReturn",
      "cagr",
      "volatility",
      "sharpe",
      "sortino",
      "maxDrawdown",
      "calmar",
      "bestMonth",
      "worstMonth",
    ] as const) {
      close(m[key], fx.expected[key]!);
    }
    expect(m.maxDrawdownDuration).toBe(fx.expected.maxDrawdownDuration);
  });

  it("give monthly returns from month-end to month-end", () => {
    const months = monthlyReturns(fx.sessions, fx.values);
    expect(months.map((x) => x.month)).toEqual(fx.expected.monthly.map((x) => x.month));
    months.forEach((x, i) => close(x.return, fx.expected.monthly[i]!.return));
  });

  it("leave Sharpe and Sortino unavailable without a risk-free rate", () => {
    const none = equityMetrics(fx.sessions, fx.values, null);
    expect(none.sharpe).toBeNull();
    expect(none.sortino).toBeNull();
    expect(riskFreeReturns(fx.sessions, null)).toBeNull();
    // No observation yet on the first sessions: unavailable rather than assumed.
    expect(riskFreeReturns(fx.sessions, { dates: ["2099-01-01"], rate: [0.05] })).toBeNull();
  });

  it("measure drawdown spells only while under water", () => {
    const rising = equityMetrics(["2024-01-02", "2024-01-03", "2024-01-04"], [1, 2, 3], null);
    expect(rising.maxDrawdown).toBe(0);
    expect(rising.maxDrawdownDuration).toBe(0);
    const dip = equityMetrics(
      ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"],
      [10, 8, 9, 10, 9],
      null,
    );
    expect(dip.maxDrawdown).toBeCloseTo(0.2, 12);
    expect(dip.maxDrawdownDuration).toBe(3);
  });
});

describe("trade metrics", () => {
  it("count closed trades only and match the reference", () => {
    const trades = fx.trades.map((t): Trade => ({
      securityId: "x",
      ticker: "X",
      entryDate: "2024-01-02",
      entryPrice: 1,
      exitDate: t.open ? null : "2024-02-01",
      exitPrice: t.open ? null : 1,
      exitReason: t.open ? "open" : "exit_rule",
      invested: 1000,
      proceeds: 1000 + t.pnl,
      dividends: 0,
      commissions: 0,
      pnl: t.pnl,
      returnPct: t.pnl / 1000,
      sessionsHeld: t.sessionsHeld,
    }));
    const m = tradeMetrics(trades);
    expect(m.trades).toBe(fx.expected.trades);
    expect(m.openTrades).toBe(fx.expected.openTrades);
    for (const key of [
      "winRate",
      "profitFactor",
      "averageWin",
      "averageLoss",
      "averageSessionsHeld",
    ] as const) {
      close(m[key], fx.expected[key]!);
    }
  });
});
