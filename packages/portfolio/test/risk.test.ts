import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzePortfolio,
  benchmarkIndex,
  portfolioRisk,
  type PriceBook,
  type ShareAction,
  type Tx,
} from "../src";

/** Risk measures (Phase 2 step C1) against scripts/make_fixture.py's spreadsheet-style figures. */
interface Scenario {
  end: string;
  calendar: string[];
  prices: Record<string, { dates: string[]; closes: number[] }>;
  adjusted: Record<string, { dates: string[]; closes: number[] }>;
  benchmark: { dates: string[]; closes: number[] };
  riskFree: { dates: string[]; rate: number[] };
  splits: ShareAction[];
  transactions: Tx[];
}
interface Expected {
  value: number;
  netContributions: number;
  risk: {
    sessions: number;
    volatility: number;
    sharpe: number;
    sortino: number;
    maxDrawdownDuration: number;
    beta: number;
    correlation: number;
    holdingsCorrelation: number;
    top10: number;
    hhi: number;
    cashWeight: number;
    dailyPnl: { date: string; pnl: number }[];
  };
}
const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const scenario = load<Scenario>("scenario.json");
const expected = load<Expected>("expected.json");

/** Within 0.01% (the plan's tolerance), with a small absolute floor for values near zero. */
function close(actual: number | null | undefined, want: number, abs = 1e-9) {
  expect(actual).not.toBeNull();
  expect(actual).toBeDefined();
  const tol = Math.max(Math.abs(want) * 1e-4, abs);
  expect(Math.abs(actual! - want), `${actual} vs ${want}`).toBeLessThanOrEqual(tol);
}

const report = analyzePortfolio(
  scenario.transactions,
  scenario.splits,
  new Map(Object.entries(scenario.prices)),
  { end: scenario.end, calendar: scenario.calendar },
);
const benchmark = benchmarkIndex(
  report.days.map((d) => d.date),
  scenario.benchmark,
);
const adjusted: PriceBook = new Map(Object.entries(scenario.adjusted));
const risk = portfolioRisk(report, {
  sessions: scenario.calendar,
  benchmark,
  riskFree: scenario.riskFree,
  adjusted,
});

describe("portfolio risk vs the spreadsheet fixture", () => {
  it("measures volatility, Sharpe, Sortino and the longest drawdown on session returns", () => {
    expect(risk.sessions?.count).toBe(expected.risk.sessions);
    close(risk.volatility, expected.risk.volatility);
    close(risk.sharpe, expected.risk.sharpe);
    close(risk.sortino, expected.risk.sortino);
    expect(risk.maxDrawdownDuration).toBe(expected.risk.maxDrawdownDuration);
  });

  it("measures beta and correlation against the benchmark", () => {
    close(risk.beta, expected.risk.beta);
    close(risk.correlation, expected.risk.correlation);
    expect(risk.benchmarkObservations).toBe(expected.risk.sessions - 1);
  });

  it("correlates the holdings' total returns, across B's split", () => {
    const m = risk.correlations!;
    expect(m.securityIds).toEqual(["B", "A"]); // largest position first
    expect(m.matrix[0]![0]).toBe(1);
    close(m.matrix[0]![1], expected.risk.holdingsCorrelation);
    expect(m.matrix[1]![0]).toBe(m.matrix[0]![1]);
    // On raw closes the split would look like a −50% day and distort the result.
    const raw = portfolioRisk(report, {
      sessions: scenario.calendar,
      benchmark,
      riskFree: scenario.riskFree,
      adjusted: new Map(Object.entries(scenario.prices)),
    });
    expect(
      Math.abs(raw.correlations!.matrix[0]![1]! - expected.risk.holdingsCorrelation),
    ).toBeGreaterThan(0.01);
  });

  it("measures concentration among holdings and the cash share", () => {
    close(risk.concentration?.top10, expected.risk.top10);
    close(risk.concentration?.hhi, expected.risk.hhi);
    close(risk.concentration?.effectiveCount, 1 / expected.risk.hhi);
    close(risk.concentration?.cashWeight, expected.risk.cashWeight);
    expect(risk.concentration?.count).toBe(2);
  });

  it("splits each day's change in value into P&L and money moved", () => {
    expect(risk.dailyPnl.map((d) => d.date)).toEqual(expected.risk.dailyPnl.map((d) => d.date));
    risk.dailyPnl.forEach((d, i) => close(d.pnl, expected.risk.dailyPnl[i]!.pnl, 0.005));
    // All the P&L together is the gain: value less the money put in.
    const total = risk.dailyPnl.reduce((s, d) => s + d.pnl, 0);
    close(total, expected.value - expected.netContributions, 0.005);
  });
});

describe("portfolio risk edge cases", () => {
  it("leaves Sharpe and Sortino unavailable without T-bill rates", () => {
    const none = portfolioRisk(report, { sessions: scenario.calendar, benchmark, riskFree: null });
    expect(none.sharpe).toBeNull();
    expect(none.sortino).toBeNull();
    close(none.volatility, expected.risk.volatility);
    expect(none.correlations).toBeNull();
  });

  it("has nothing to measure before two sessions", () => {
    const short = analyzePortfolio(
      scenario.transactions.slice(0, 1),
      [],
      new Map(Object.entries(scenario.prices)),
      { end: scenario.transactions[0]!.date, calendar: scenario.calendar },
    );
    const r = portfolioRisk(short, {
      sessions: scenario.calendar,
      benchmark: null,
      riskFree: null,
    });
    expect(r.sessions).toBeNull();
    expect(r.volatility).toBeNull();
    expect(r.beta).toBeNull();
    expect(r.concentration).toBeNull();
  });
});
