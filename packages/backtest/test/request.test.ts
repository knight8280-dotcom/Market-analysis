import { describe, expect, it } from "vitest";
import {
  checkRunRequest,
  lookbackSessions,
  MAX_COMBINATIONS,
  resolveStrategy,
  walkForwardWindows,
  warmupSessions,
  type StrategyInput,
} from "../src";

const base: StrategyInput = {
  version: 1,
  universe: { kind: "tickers", tickers: ["TEST_A"] },
  entry: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: ">",
        right: { kind: "indicator", id: "sma", params: { period: 50 } },
      },
    ],
  },
  sizing: { maxPositions: 1 },
  initialCapital: 10_000,
  start: "2020-01-02",
  end: "2023-12-29",
};
const withParam: StrategyInput = {
  ...base,
  entry: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: ">",
        right: { kind: "indicator", id: "sma", params: { period: { $param: "n" } } },
      },
    ],
  },
};

describe("run requests", () => {
  it("accept a single run and check its split date", () => {
    const ok = checkRunRequest({ kind: "single", strategy: base, split: "2022-01-03" });
    expect(ok.strategy.start).toBe("2020-01-02");
    expect(ok.combinations).toEqual([{}]);
    expect(() => checkRunRequest({ kind: "single", strategy: base, split: "2019-01-02" })).toThrow(
      /split date/,
    );
    expect(() => checkRunRequest({ kind: "single", strategy: withParam })).toThrow(
      /a single run needs numbers, not parameters \(n\)/,
    );
  });

  it("require values for every parameter and no unused ones", () => {
    const sweep = { kind: "sweep", strategy: withParam, objective: "cagr" };
    expect(checkRunRequest({ ...sweep, params: { n: [20, 50] } }).combinations).toEqual([
      { n: 20 },
      { n: 50 },
    ]);
    expect(() => checkRunRequest({ ...sweep, params: {} })).toThrow(/no values for parameter n/);
    expect(() => checkRunRequest({ ...sweep, params: { n: [20], m: [1] } })).toThrow(
      /parameter m is not used/,
    );
    expect(() => checkRunRequest({ ...sweep, strategy: base, params: { n: [20] } })).toThrow(
      /no parameters to vary/,
    );
    const fifty = Array.from({ length: 50 }, (_, i) => 2 + i);
    expect(() => checkRunRequest({ ...sweep, params: { n: [...fifty, 60] } })).toThrow(); // > 50
    const two = {
      ...sweep,
      strategy: {
        ...withParam,
        sizing: { maxPositions: { $param: "k" } },
      },
    };
    const k = Array.from({ length: 1 + Math.floor(MAX_COMBINATIONS / 50) }, (_, i) => 1 + i);
    expect(
      checkRunRequest({ ...two, params: { n: fifty, k: k.slice(0, -1) } }).combinations,
    ).toHaveLength(MAX_COMBINATIONS);
    expect(() => checkRunRequest({ ...two, params: { n: fifty, k } })).toThrow(
      /450 combinations is more than the 400 allowed/,
    );
    expect(() => checkRunRequest({ ...sweep, params: { n: [20] }, objective: "luck" })).toThrow();
  });

  it("limit walk-forward runs and need room for one window", () => {
    const wf = {
      kind: "walk_forward",
      strategy: withParam,
      params: { n: [20, 50] },
      objective: "sharpe",
      trainMonths: 12,
      testMonths: 6,
    };
    expect(checkRunRequest(wf).windows).toHaveLength(6);
    expect(() => checkRunRequest({ ...wf, strategy: { ...withParam, end: "2020-12-31" } })).toThrow(
      /too short/,
    );
    const values = Array.from({ length: 50 }, (_, i) => 2 + i);
    const twoParams = {
      ...wf,
      strategy: {
        ...withParam,
        exit: {
          combine: "all",
          rules: [
            {
              left: { kind: "price", field: "close" },
              op: "<",
              right: { kind: "indicator", id: "ema", params: { period: { $param: "m" } } },
            },
          ],
        },
      },
      params: { n: values, m: values.slice(0, 8) },
      trainMonths: 6,
      testMonths: 3,
    };
    expect(() => checkRunRequest(twoParams)).toThrow(/more than the 2000 allowed/);
  });
});

describe("walk-forward windows", () => {
  it("clip the last test window to the end and handle month ends", () => {
    expect(walkForwardWindows("2021-01-31", "2021-12-15", 6, 3)).toEqual([
      {
        trainStart: "2021-01-31",
        trainEnd: "2021-07-30",
        testStart: "2021-07-31",
        testEnd: "2021-10-30",
      },
      {
        trainStart: "2021-04-30",
        trainEnd: "2021-10-29",
        testStart: "2021-10-30",
        testEnd: "2021-12-15",
      },
    ]);
  });
});

describe("warm-up", () => {
  const rule = (right: object, op = ">") => ({
    ...base,
    entry: { combine: "all", rules: [{ left: { kind: "price", field: "close" }, op, right }] },
  });
  it("covers the longest indicator, bars ago and crossings", () => {
    expect(lookbackSessions(resolveStrategy(base))).toBe(50);
    expect(
      lookbackSessions(
        resolveStrategy(
          rule(
            { kind: "indicator", id: "macd", params: {}, output: "signal", barsAgo: 3 },
            "crosses_above",
          ),
        ),
      ),
    ).toBe(26 + 9 + 3 + 1);
    expect(
      lookbackSessions(resolveStrategy(rule({ kind: "indicator", id: "adx", output: "adx" }))),
    ).toBe(29);
    expect(lookbackSessions(resolveStrategy(rule({ kind: "const", value: 1 })))).toBe(1);
  });

  it("loads twice the lookback, within 30 and 1,000 sessions", () => {
    expect(warmupSessions(resolveStrategy(base))).toBe(100);
    expect(warmupSessions(resolveStrategy(rule({ kind: "const", value: 1 })))).toBe(30);
    expect(
      warmupSessions(
        resolveStrategy(
          rule({ kind: "indicator", id: "sma", params: { period: 400 }, barsAgo: 200 }),
        ),
      ),
    ).toBe(1000);
  });
});
