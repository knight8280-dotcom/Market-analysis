import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src";
import { data, security, strategy } from "./helpers";

/**
 * Golden test (spec §5.15 acceptance): buy-and-hold must match the total return computed
 * independently from raw prices, splits and dividends (scripts/make_fixtures.py).
 */
interface Golden {
  security: {
    ticker: string;
    sessions: string[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    splits: { exDate: string; ratio: number }[];
    dividends: { exDate: string; amount: number }[];
  };
  cases: Record<string, { equity: number[]; finalShares: number; finalCash: number }>;
}
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/golden.json", import.meta.url), "utf8"),
) as Golden;
const g = golden.security;
const sec = security({
  ticker: g.ticker,
  dates: g.sessions,
  open: g.open,
  high: g.high,
  low: g.low,
  close: g.close,
  splits: g.splits,
  dividends: g.dividends,
});
const start = g.sessions[0]!;
const end = g.sessions[g.sessions.length - 1]!;

function expectCurve(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => {
    expect(Math.abs(v - expected[i]!) / expected[i]!, `session ${i}`).toBeLessThan(1e-9);
  });
}

describe("buy-and-hold matches the independent reference", () => {
  it("with dividends reinvested and no costs", () => {
    const r = runBacktest(strategy({ start, end, dividends: "reinvest" }), data([sec]));
    expectCurve(r.series.equity, golden.cases.reinvest_frictionless!.equity);
    const ref = golden.cases.reinvest_frictionless!;
    expect(r.metrics.totalReturn).toBeCloseTo(ref.equity.at(-1)! / 100_000 - 1, 12);
    expect(r.fills[0]).toMatchObject({ date: g.sessions[1], side: "buy", reason: "entry" });
  });

  it("with dividends kept as cash", () => {
    const r = runBacktest(strategy({ start, end, dividends: "cash" }), data([sec]));
    expectCurve(r.series.equity, golden.cases.cash_frictionless!.equity);
  });

  it("with commission, slippage and whole shares", () => {
    const r = runBacktest(
      strategy({
        start,
        end,
        dividends: "reinvest",
        fractionalShares: false,
        costs: { commissionPerTrade: 4.95, commissionBps: 5, slippageBps: 10 },
      }),
      data([sec]),
    );
    expectCurve(r.series.equity, golden.cases.reinvest_with_costs!.equity);
  });

  it("is close to the adjusted-price total return, which assumes slightly different timing", () => {
    // Adjusted closes reinvest dividends at the previous close; the engine buys at the ex-date
    // open after entering at the second session's open. Same order of magnitude, not identical.
    const r = runBacktest(strategy({ start, end }), data([sec]));
    const adj = (i: number) => g.close[i]! * sec.bars.splitFactor[i]! * sec.bars.dividendFactor[i]!;
    const viaAdjusted =
      adj(g.sessions.length - 1) /
        (g.open[1]! * sec.bars.splitFactor[1]! * sec.bars.dividendFactor[1]!) -
      1;
    expect(Math.abs(r.metrics.totalReturn - viaAdjusted)).toBeLessThan(0.002);
  });
});
