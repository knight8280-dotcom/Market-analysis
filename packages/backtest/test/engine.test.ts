import { describe, expect, it } from "vitest";
import {
  fundamentalTimeline,
  resolveStrategy,
  runBacktest,
  simulate,
  StrategyInput,
  type SecurityData,
} from "../src";
import { ALWAYS, data, security, sessions, strategy, walk } from "./helpers";

const D = sessions("2024-01-02", "2024-12-31");

/** A flat security with hand-set bars on given sessions. */
function scripted(
  ticker: string,
  dates: string[],
  bars: { open: number; close: number; high?: number; low?: number }[],
  extra: Partial<Parameters<typeof security>[0]> = {},
): SecurityData {
  return security({
    ticker,
    dates,
    open: bars.map((b) => b.open),
    close: bars.map((b) => b.close),
    high: bars.map((b) => b.high ?? Math.max(b.open, b.close)),
    low: bars.map((b) => b.low ?? Math.min(b.open, b.close)),
    ...extra,
  });
}

describe("fills and exits", () => {
  const dates = D.slice(0, 8);
  const start = dates[0]!;
  const end = dates[7]!;

  it("never fills a signal on its own bar", () => {
    const sec = security(walk("TEST_A", dates, 1));
    const sim = simulate(strategy({ start, end }), data([sec]));
    expect(sim.fills[0]!.date).toBe(dates[1]);
    expect(sim.fills[0]!.price).toBe(sec.bars.open[1]);
    expect(sim.equity[0]).toBe(100_000);
  });

  it("fills a gapped stop at the open and an intraday stop at the level", () => {
    const flat = { open: 100, close: 100 };
    const gap = scripted("TEST_GAP", dates, [
      flat,
      flat,
      flat,
      { open: 99, close: 95 },
      { open: 86, close: 85 }, // opens below the 90 stop
      flat,
      flat,
      flat,
    ]);
    const sim = simulate(strategy({ start, end, stops: { stopLossPct: 0.1 } }), data([gap]));
    expect(sim.trades[0]).toMatchObject({
      entryDate: dates[1],
      exitDate: dates[4],
      exitReason: "stop_loss",
      exitPrice: 86,
    });

    const intraday = scripted("TEST_DIP", dates, [
      flat,
      flat,
      { open: 99, close: 98, low: 89 }, // trades through 90
      flat,
      flat,
      flat,
      flat,
      flat,
    ]);
    const sim2 = simulate(strategy({ start, end, stops: { stopLossPct: 0.1 } }), data([intraday]));
    expect(sim2.trades[0]).toMatchObject({ exitDate: dates[2], exitPrice: 90 });
  });

  it("takes profit at the level, or at the open when it gaps through", () => {
    const flat = { open: 100, close: 100 };
    const sec = scripted("TEST_TP", dates, [
      flat,
      flat,
      { open: 101, close: 104, high: 112 },
      flat,
      flat,
      flat,
      flat,
      flat,
    ]);
    const sim = simulate(strategy({ start, end, stops: { takeProfitPct: 0.1 } }), data([sec]));
    expect(sim.trades[0]).toMatchObject({ exitReason: "take_profit", exitDate: dates[2] });
    expect(sim.trades[0]!.exitPrice).toBeCloseTo(110, 10);
  });

  it("exits on a rule at the next open and after a maximum holding period", () => {
    const sec = scripted("TEST_EXIT", dates, [
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 100, close: 94 }, // close < 95: exit signal
      { open: 93, close: 93 },
      { open: 93, close: 93 },
      { open: 93, close: 93 },
      { open: 93, close: 93 },
      { open: 93, close: 93 },
    ]);
    const exitRule = {
      combine: "all" as const,
      rules: [
        {
          left: { kind: "price" as const, field: "close" as const },
          op: "<" as const,
          right: { kind: "const" as const, value: 95 },
        },
      ],
    };
    const ruled = simulate(strategy({ start, end, exit: exitRule }), data([sec]));
    expect(ruled.trades[0]).toMatchObject({
      exitDate: dates[3],
      exitReason: "exit_rule",
      exitPrice: 93,
    });

    const held = simulate(strategy({ start, end, stops: { maxHoldingDays: 3 } }), data([sec]));
    // Entered on session 1; the rule fires at session 4's close; it sells at session 5's open.
    expect(held.trades[0]).toMatchObject({
      entryDate: dates[1],
      exitDate: dates[5],
      exitReason: "max_hold",
    });
  });

  it("charges commission and slippage on every fill", () => {
    const sec = security(walk("TEST_FEE", dates, 2));
    const sim = simulate(
      strategy({
        start,
        end,
        fractionalShares: false,
        costs: { commissionPerTrade: 1, commissionBps: 10, slippageBps: 20 },
      }),
      data([sec]),
    );
    const f = sim.fills[0]!;
    expect(f.price).toBeCloseTo(sec.bars.open[1]! * 1.002, 10);
    expect(f.commission).toBeCloseTo(1 + f.shares * f.price * 0.001, 10);
    expect(Number.isInteger(f.shares)).toBe(true);
    expect(sim.cash[1]).toBeCloseTo(100_000 - f.shares * f.price - f.commission, 6);
  });
});

describe("portfolio construction", () => {
  const dates = D.slice(0, 60);
  const start = dates[0]!;
  const end = dates[59]!;

  it("fills free slots in ranking order", () => {
    const secs = [
      security(walk("TEST_LOW", dates, 3, 20)),
      security(walk("TEST_MID", dates, 4, 50)),
      security(walk("TEST_HIGH", dates, 5, 90)),
    ];
    const sim = simulate(
      strategy({
        start,
        end,
        sizing: { maxPositions: 2 },
        rank: { by: { kind: "price", field: "close" }, order: "desc" },
      }),
      data(secs),
    );
    const firstBuys = sim.fills.filter((f) => f.date === dates[1]).map((f) => f.ticker);
    expect(firstBuys).toEqual(["TEST_HIGH", "TEST_MID"]);
    expect(Math.max(...sim.positions)).toBe(2);
  });

  it("rebalances back to equal weights at each month end", () => {
    const up = walk("TEST_UP", dates, 6, 50, 0.01, 0.002);
    const flat = walk("TEST_FLAT", dates, 7, 50, 0, 0.002);
    const secs = [security(up), security(flat)];
    const sim = simulate(
      strategy({ start, end, sizing: { maxPositions: 2 }, rebalance: "monthly" }),
      data(secs),
    );
    const rebalances = sim.fills.filter((f) => f.reason === "rebalance");
    expect(rebalances.some((f) => f.ticker === "TEST_UP" && f.side === "sell")).toBe(true);
    expect(rebalances.some((f) => f.ticker === "TEST_FLAT" && f.side === "buy")).toBe(true);
    // Every rebalance happens at the first open of a month.
    for (const f of rebalances) {
      const i = dates.indexOf(f.date);
      expect(dates[i - 1]!.slice(0, 7)).not.toBe(f.date.slice(0, 7));
    }
  });
});

describe("survivorship and halts", () => {
  const dates = D.slice(0, 40);
  const start = dates[0]!;
  const end = dates[39]!;

  it("includes a security that later delists, and closes it at its last close", () => {
    const lastDay = dates[19]!;
    const live = security(walk("TEST_LIVE", dates, 8));
    const dying = walk("TEST_DELIST", dates.slice(0, 20), 9);
    const delisted = security({
      ...dying,
      delistedAt: dates[20]!,
      membership: [{ from: start, to: lastDay }],
    });
    const sim = simulate(
      strategy({ start, end, sizing: { maxPositions: 2 } }),
      data([live, delisted]),
    );
    // In the universe while listed: bought on the first fill day.
    expect(
      sim.fills
        .filter((f) => f.date === dates[1])
        .map((f) => f.ticker)
        .sort(),
    ).toEqual(["TEST_DELIST", "TEST_LIVE"]);
    const exit = sim.trades.find((t) => t.ticker === "TEST_DELIST")!;
    expect(exit).toMatchObject({
      exitReason: "delisted",
      exitDate: dates[20],
      exitPrice: dying.close[19],
    });
    // Never bought again after delisting.
    expect(
      sim.fills.filter((f) => f.ticker === "TEST_DELIST" && f.date > lastDay && f.side === "buy"),
    ).toEqual([]);
  });

  it("cancels a buy for a session the security does not trade", () => {
    const halted = walk("TEST_HALT", dates, 10);
    const keep = dates.map((_, i) => i !== 1);
    const sec = security({
      ticker: "TEST_HALT",
      dates: dates.filter((_, i) => keep[i]),
      open: halted.open.filter((_, i) => keep[i]),
      close: halted.close.filter((_, i) => keep[i]),
    });
    const sim = simulate(strategy({ start, end }), data([sec], { sessions: dates }));
    expect(sim.warnings[0]).toMatch(/TEST_HALT: entry on .* cancelled, no trading that session/);
    expect(sim.fills[0]!.date).toBe(dates[3]);
  });
});

describe("no look-ahead", () => {
  it("rejects a rule that reads a future bar", () => {
    const peek = {
      version: 1,
      universe: { kind: "all", assetClass: "any" },
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "price", field: "close", barsAgo: -1 },
            op: ">",
            right: { kind: "price", field: "close" },
          },
        ],
      },
      sizing: { maxPositions: 1 },
      initialCapital: 1000,
      start: "2024-01-02",
      end: "2024-06-28",
    };
    expect(() => StrategyInput.parse(peek)).toThrow(/look-ahead is not allowed/);
    expect(() => resolveStrategy(peek)).toThrow(/look-ahead is not allowed/);
  });

  it("trades the same up to any date whether or not later data exists", () => {
    // A 4:1 split and dividends after the cut-off make adjusted history lower before it; rules
    // on price levels and indicators must still see what was known at the time.
    const dates = sessions("2023-01-03", "2024-12-31");
    const path = walk("TEST_LEVEL", dates, 11, 140, 0.0008, 0.02);
    const split = dates.find((d) => d >= "2024-06-03")!;
    const s = dates.indexOf(split);
    const raw = {
      ...path,
      open: path.open.map((x, i) => (i >= s ? x / 4 : x)),
      close: path.close.map((x, i) => (i >= s ? x / 4 : x)),
    };
    const splits = [{ exDate: split, ratio: 4 }];
    const dividends = [
      { exDate: dates.find((d) => d >= "2024-03-01")!, amount: 0.8 },
      { exDate: dates.find((d) => d >= "2024-09-03")!, amount: 0.3 },
    ];
    const full = security({ ...raw, splits, dividends });
    expect(full.bars.splitFactor[0]).toBe(0.25);

    const levelRules = strategy({
      start: "2023-06-01",
      end: "2024-12-31",
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "price", field: "close" },
            op: ">",
            right: { kind: "const", value: 150 },
          },
          {
            left: { kind: "indicator", id: "sma", params: { period: 10 } },
            op: ">",
            right: { kind: "indicator", id: "sma", params: { period: 30 } },
          },
        ],
      },
      exit: {
        combine: "any",
        rules: [
          {
            left: { kind: "price", field: "close" },
            op: "<",
            right: { kind: "const", value: 145 },
          },
          {
            left: { kind: "indicator", id: "rsi", params: { period: 14 } },
            op: "crosses_above",
            right: { kind: "const", value: 70 },
          },
          {
            left: { kind: "indicator", id: "atr", params: { period: 14 } },
            op: ">",
            right: { kind: "const", value: 6 },
          },
        ],
      },
    });
    const fullRun = simulate(levelRules, data([full]));

    for (const cut of ["2024-02-15", "2024-05-31", "2024-08-30"]) {
      const k = dates.filter((d) => d <= cut).length;
      const truncated = security({
        ticker: raw.ticker,
        dates: dates.slice(0, k),
        open: raw.open.slice(0, k),
        close: raw.close.slice(0, k),
        splits: splits.filter((x) => x.exDate <= cut),
        dividends: dividends.filter((x) => x.exDate <= cut),
      });
      const cutRun = simulate({ ...levelRules, end: cut }, data([truncated]));
      const before = (f: { date: string }) => f.date <= cut;
      expect(cutRun.fills, cut).toEqual(fullRun.fills.filter(before));
      expect(cutRun.equity, cut).toEqual(fullRun.equity.slice(0, cutRun.equity.length));
    }
    expect(fullRun.fills.length).toBeGreaterThan(2);
  });

  it("uses fundamentals only from the session after they were filed", () => {
    const dates = D.slice(0, 80);
    const sec = security(walk("TEST_FUND", dates, 12, 50, 0, 0.001));
    sec.shares = [{ availableFrom: dates[0]!, asOf: dates[0]!, shares: 1_000_000 }];
    sec.fundamentals = fundamentalTimeline([
      // Filed on dates[30]: usable from dates[31].
      {
        frequency: "annual",
        periodEnd: "2023-12-31",
        revenue: { value: 20e6, filed: dates[30]! },
        netIncome: { value: 5e6, filed: dates[30]! },
      },
    ]);
    expect(sec.fundamentals[0]!.availableFrom).toBe(dates[31]);
    const sim = simulate(
      strategy({
        start: dates[0]!,
        end: dates[79]!,
        entry: {
          combine: "all",
          rules: [
            {
              left: { kind: "fundamental", metric: "pe_ttm" },
              op: "<",
              right: { kind: "const", value: 20 },
            },
          ],
        },
      }),
      data([sec]),
    );
    // P/E is about 50 × 1M ÷ 5M = 10 once known; the signal at dates[31]'s close fills next.
    expect(sim.fills[0]!.date).toBe(dates[32]);
  });
});

describe("determinism", () => {
  it("gives identical reports for identical inputs", () => {
    const dates = D.slice(0, 120);
    const secs = [1, 2, 3].map((n) => security(walk(`TEST_R${n}`, dates, 20 + n)));
    const s = strategy({
      start: dates[0]!,
      end: dates[119]!,
      sizing: { maxPositions: 2 },
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "indicator", id: "ema", params: { period: 5 } },
            op: "crosses_above",
            right: { kind: "indicator", id: "ema", params: { period: 20 } },
          },
        ],
      },
      exit: { combine: "all", rules: [{ ...ALWAYS, op: "<" }] },
      rank: { by: { kind: "indicator", id: "rsi", params: { period: 14 } }, order: "asc" },
    });
    expect(runBacktest(s, data(secs))).toEqual(runBacktest(s, data(secs)));
  });
});
