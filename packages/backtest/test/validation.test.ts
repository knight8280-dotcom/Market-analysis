import { describe, expect, it } from "vitest";
import {
  BacktestError,
  combinations,
  MAX_COMBINATIONS,
  OVERFIT_WARNING_AT,
  overfitWarning,
  resolveStrategy,
  runBacktest,
  splitMetrics,
  sweep,
  walkForward,
  type StrategyInput,
} from "../src";
import { data, security, sessions, walk } from "./helpers";

const D = sessions("2022-01-03", "2023-12-29");
const market = data(
  [1, 2, 3].map((n) => security(walk(`TEST_V${n}`, D, 40 + n, 100, 0.0003, 0.02))),
);

/** Buys when the close is above a moving average whose period is a parameter. */
const input = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  version: 1,
  universe: { kind: "all", assetClass: "any" },
  entry: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: ">",
        right: { kind: "indicator", id: "sma", params: { period: { $param: "period" } } },
      },
    ],
  },
  exit: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: "<",
        right: { kind: "indicator", id: "sma", params: { period: { $param: "period" } } },
      },
    ],
  },
  sizing: { maxPositions: 2 },
  initialCapital: 100_000,
  fractionalShares: true,
  start: D[0]!,
  end: D[D.length - 1]!,
  ...over,
});

describe("combinations", () => {
  it("lists every combination in a fixed order", () => {
    expect(combinations({ b: [1, 2], a: [10, 20] })).toEqual([
      { a: 10, b: 1 },
      { a: 10, b: 2 },
      { a: 20, b: 1 },
      { a: 20, b: 2 },
    ]);
    expect(combinations({})).toEqual([{}]);
    expect(() => combinations({ a: [] })).toThrow(/no values listed for "a"/);
  });

  it("warns about overfitting only above the threshold", () => {
    expect(overfitWarning(OVERFIT_WARNING_AT)).toBeNull();
    expect(overfitWarning(OVERFIT_WARNING_AT + 1)).toMatch(/21 parameter combinations/);
  });
});

describe("parameter sweep", () => {
  it("runs each combination as its own backtest and picks the best by the objective", () => {
    const result = sweep(input(), market, { period: [10, 20, 50] }, "total_return");
    expect(result.combinations).toBe(3);
    expect(result.warning).toBeNull();
    expect(result.rows.map((r) => r.values.period)).toEqual([10, 20, 50]);
    for (const row of result.rows) {
      expect(row.error).toBeNull();
      const direct = runBacktest(resolveStrategy(input(), row.values), market);
      expect(row.summary!.totalReturn).toBe(direct.metrics.totalReturn);
      expect(row.summary!.trades).toBe(direct.metrics.trades);
    }
    const best = Math.max(...result.rows.map((r) => r.summary!.totalReturn));
    expect(result.best!.summary!.totalReturn).toBe(best);
  });

  it("restricts runs to the period given", () => {
    const period = { start: "2022-01-03", end: "2022-06-30" };
    const { rows } = sweep(input(), market, { period: [20] }, "cagr", period);
    const direct = runBacktest(resolveStrategy({ ...input(), ...period }, { period: 20 }), market);
    expect(rows[0]!.summary!.totalReturn).toBe(direct.metrics.totalReturn);
  });

  it("records a combination that is not a valid strategy instead of failing the sweep", () => {
    const macd = input({
      entry: {
        combine: "all",
        rules: [
          {
            left: {
              kind: "indicator",
              id: "macd",
              params: { fast: { $param: "fast" }, slow: { $param: "slow" } },
              output: "histogram",
            },
            op: ">",
            right: { kind: "const", value: 0 },
          },
        ],
      },
      exit: null,
    });
    const result = sweep(macd, market, { fast: [12, 30], slow: [26] }, "total_return");
    expect(result.rows[0]!.error).toBeNull();
    expect(result.rows[1]!.summary).toBeNull();
    expect(result.rows[1]!.error).toBe(
      "entry.rules.0.left.params.fast: MACD fast must be below slow",
    );
    expect(result.best!.values).toEqual({ fast: 12, slow: 26 });
  });

  it("refuses missing parameters and oversized sweeps, and warns on many combinations", () => {
    expect(() => sweep(input(), market, {}, "cagr")).toThrow(/no values for parameter period/);
    const many = Array.from({ length: MAX_COMBINATIONS + 1 }, (_, i) => 2 + i);
    expect(() => sweep(input(), market, { period: many }, "cagr")).toThrow(BacktestError);
    const small = data([security(walk("TEST_W", D.slice(0, 60), 7))]);
    const range = { start: D[0]!, end: D[59]! };
    const periods = Array.from({ length: OVERFIT_WARNING_AT + 1 }, (_, i) => 2 + i);
    expect(sweep(input(), small, { period: periods }, "cagr", range).warning).toMatch(
      /out of sample/,
    );
  });

  it("stops at the time limit rather than recording it as a failed combination", () => {
    expect(() =>
      sweep(input(), market, { period: [10] }, "cagr", undefined, Date.now() - 1),
    ).toThrow(/time limit/);
  });
});

describe("in-sample and out-of-sample split", () => {
  const report = runBacktest(resolveStrategy(input(), { period: 20 }), market);
  const { dates, equity } = report.series;

  it("splits one run into two periods that chain back to the whole", () => {
    const split = splitMetrics(report, "2023-01-01", market);
    const k = dates.findIndex((d) => d >= "2023-01-01");
    expect(split.inSample!.totalReturn).toBeCloseTo(equity[k - 1]! / equity[0]! - 1, 12);
    expect(split.outOfSample!.totalReturn).toBeCloseTo(equity.at(-1)! / equity[k - 1]! - 1, 12);
    expect(
      (1 + split.inSample!.totalReturn) * (1 + split.outOfSample!.totalReturn) - 1,
    ).toBeCloseTo(report.metrics.totalReturn, 12);
  });

  it("leaves a side empty when the split is outside the run", () => {
    expect(splitMetrics(report, "2030-01-01", market).outOfSample).toBeNull();
    const before = splitMetrics(report, "2000-01-01", market);
    expect(before.inSample).toBeNull();
    expect(before.outOfSample!.totalReturn).toBeCloseTo(report.metrics.totalReturn, 12);
  });
});

describe("walk-forward", () => {
  const wf = walkForward(input(), market, { period: [10, 30] }, "total_return", 6, 3);

  it("rolls training and test windows forward without gaps or overlaps", () => {
    expect(wf.windows.map((w) => [w.trainStart, w.trainEnd, w.testStart, w.testEnd])).toEqual([
      ["2022-01-03", "2022-07-02", "2022-07-03", "2022-10-02"],
      ["2022-04-03", "2022-10-02", "2022-10-03", "2023-01-02"],
      ["2022-07-03", "2023-01-02", "2023-01-03", "2023-04-02"],
      ["2022-10-03", "2023-04-02", "2023-04-03", "2023-07-02"],
      ["2023-01-03", "2023-07-02", "2023-07-03", "2023-10-02"],
      ["2023-04-03", "2023-10-02", "2023-10-03", "2023-12-29"],
    ]);
    expect(wf.combinations).toBe(2);
    expect(wf.warning).toBeNull();
  });

  it("chooses each window's parameters on its training period alone", () => {
    for (const w of wf.windows) {
      const train = sweep(input(), market, { period: [10, 30] }, "total_return", {
        start: w.trainStart,
        end: w.trainEnd,
      });
      expect(w.chosen).toEqual(train.best!.values);
      expect(w.inSample).toEqual(train.best!.summary);
    }
  });

  it("chains the test windows into one out-of-sample record", () => {
    expect(wf.dates[0]! >= wf.windows[0]!.testStart).toBe(true);
    expect(wf.dates.every((d, i) => i === 0 || d > wf.dates[i - 1]!)).toBe(true);
    expect(wf.equity[0]).toBe(100_000);
    const chained = wf.windows.reduce((acc, w) => acc * (1 + w.outOfSample!.totalReturn), 1);
    expect(wf.equity.at(-1)! / 100_000).toBeCloseTo(chained, 10);
    expect(wf.metrics!.totalReturn).toBeCloseTo(chained - 1, 10);
  });

  it("refuses a period too short for one window, and too many runs", () => {
    expect(() =>
      walkForward(input({ end: "2022-05-31" }), market, { period: [10] }, "cagr", 6, 3),
    ).toThrow(/too short/);
    const many = Array.from({ length: 400 }, (_, i) => 2 + i);
    expect(() => walkForward(input(), market, { period: many }, "cagr", 6, 3)).toThrow(/2400 runs/);
  });
});
