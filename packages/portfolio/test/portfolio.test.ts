import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzePortfolio,
  annualize,
  benchmarkIndex,
  benchmarkReturn,
  closeOn,
  maxDrawdown,
  oversoldSells,
  xirr,
  type PriceBook,
  type ShareAction,
  type Tx,
} from "../src";

interface Scenario {
  end: string;
  calendar: string[];
  prices: Record<string, { dates: string[]; closes: number[] }>;
  benchmark: { dates: string[]; closes: number[] };
  splits: ShareAction[];
  transactions: Tx[];
}
interface Expected {
  twr: number;
  xirr: number;
  maxDrawdown: number;
  value: number;
  cash: number;
  netContributions: number;
  realized: number;
  unrealized: number;
  dividends: number;
  fees: number;
  benchmarkTotal: number;
  positions: { securityId: string; quantity: number; costBasis: number; marketValue: number }[];
  days: { date: string; cash: number; value: number; flow: number; index: number }[];
}
const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const scenario = load<Scenario>("scenario.json");
const expected = load<Expected>("expected.json");
const prices: PriceBook = new Map(Object.entries(scenario.prices));

/** Within 0.01% (the plan's tolerance), or 1 cent for amounts near zero. */
function close(actual: number | null, want: number, abs = 0.01) {
  expect(actual).not.toBeNull();
  const tol = Math.max(Math.abs(want) * 1e-4, abs);
  expect(Math.abs(actual! - want), `${actual} vs ${want}`).toBeLessThanOrEqual(tol);
}

describe("analyzePortfolio vs the spreadsheet fixture", () => {
  const report = analyzePortfolio(scenario.transactions, scenario.splits, prices, {
    end: scenario.end,
    calendar: scenario.calendar,
  });

  it("matches every day of the table within 0.01%", () => {
    expect(report.days.map((d) => d.date)).toEqual(expected.days.map((d) => d.date));
    report.days.forEach((d, i) => {
      const want = expected.days[i]!;
      close(d.cash, want.cash);
      close(d.value, want.value);
      close(d.flow, want.flow);
      close(d.index, want.index, 1e-6);
    });
  });

  it("matches the summary figures within 0.01%", () => {
    close(report.twr, expected.twr, 1e-6);
    close(report.xirr, expected.xirr, 1e-6);
    close(report.maxDrawdown, expected.maxDrawdown, 1e-6);
    close(report.value, expected.value);
    close(report.cash, expected.cash);
    close(report.netContributions, expected.netContributions);
    close(report.realized, expected.realized);
    close(report.unrealized, expected.unrealized);
    close(report.dividends, expected.dividends);
    close(report.fees, expected.fees);
    expect(report.warnings).toEqual([]);
  });

  it("adjusts lots for the split and sells first-in, first-out", () => {
    const byId = new Map(report.positions.map((p) => [p.securityId, p]));
    for (const want of expected.positions) {
      const got = byId.get(want.securityId)!;
      close(got.quantity, want.quantity, 1e-9);
      close(got.costBasis, want.costBasis);
      close(got.marketValue, want.marketValue);
    }
    // 100 B bought before the 2:1 split, 300 after, 150 sold from the older lot: 350 left.
    expect(byId.get("B")!.quantity).toBe(350);
    // 70 A bought, 60 sold: 10 left from the second lot (20 @ 103.40 + $1 fee).
    expect(byId.get("A")!.quantity).toBe(10);
    close(byId.get("A")!.costBasis, (10 * (20 * 103.4 + 1)) / 20);
    const weights = report.positions.reduce((s, p) => s + p.weight, 0) + report.cash / report.value;
    close(weights, 1, 1e-9);
  });

  it("measures the benchmark over the same days", () => {
    const days = report.days.map((d) => d.date);
    const index = benchmarkIndex(days, scenario.benchmark);
    close(benchmarkReturn(days, index)!.total, expected.benchmarkTotal, 1e-6);
    expect(index[0]).toBe(1);
  });
});

describe("returns", () => {
  it("XIRR matches the spreadsheet function's documented example (37.34%)", () => {
    // Microsoft's XIRR help example.
    const r = xirr([
      { date: "2008-01-01", amount: -10000 },
      { date: "2008-03-01", amount: 2750 },
      { date: "2008-10-30", amount: 4250 },
      { date: "2009-02-15", amount: 3250 },
      { date: "2009-04-01", amount: 2750 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 8);
  });

  it("XIRR handles losses and refuses one-signed flows", () => {
    expect(
      xirr([
        { date: "2024-01-01", amount: -1000 },
        { date: "2025-01-01", amount: 500 },
      ]),
    ).toBeCloseTo(0.5 ** (365 / 366) - 1, 9);
    expect(xirr([{ date: "2024-01-01", amount: -1000 }])).toBeNull();
    expect(
      xirr([
        { date: "2024-01-01", amount: 5 },
        { date: "2024-06-01", amount: 5 },
      ]),
    ).toBeNull();
  });

  it("annualizes only periods of a year or more; drawdown from the peak", () => {
    expect(annualize(0.21, 730)).toBeCloseTo(0.1, 2);
    expect(annualize(0.05, 200)).toBeNull();
    expect(maxDrawdown([1, 1.2, 0.9, 1.3, 1.17])).toBeCloseTo(0.25, 12);
    expect(maxDrawdown([1, 1.1, 1.2])).toBe(0);
    expect(maxDrawdown([])).toBeNull();
  });
});

describe("edge cases", () => {
  const book: PriceBook = new Map([
    ["X", { dates: ["2025-01-02", "2025-01-03", "2025-01-06"], closes: [10, 11, 12] }],
  ]);

  it("returns an empty report without transactions", () => {
    const r = analyzePortfolio([], [], book, { end: "2025-01-06" });
    expect(r).toMatchObject({ start: null, twr: null, value: 0, positions: [] });
  });

  it("treats a buys-only ledger as funded by implicit deposits", () => {
    const r = analyzePortfolio(
      [
        {
          date: "2025-01-02",
          type: "buy",
          securityId: "X",
          quantity: 10,
          price: 10,
          amount: null,
          fees: 0,
        },
      ],
      [],
      book,
      { end: "2025-01-06" },
    );
    expect(r.netContributions).toBe(100);
    expect(r.value).toBe(120);
    expect(r.twr).toBeCloseTo(0.2, 12);
    expect(r.days.map((d) => d.date)).toEqual(["2025-01-02", "2025-01-03", "2025-01-06"]);
  });

  it("values a security without prices at cost, with a warning", () => {
    const r = analyzePortfolio(
      [
        {
          date: "2025-01-02",
          type: "buy",
          securityId: "Y",
          quantity: 2,
          price: 5,
          amount: null,
          fees: 1,
        },
      ],
      [],
      book,
      { end: "2025-01-03" },
    );
    expect(r.value).toBe(11);
    expect(r.warnings[0]).toMatch(/no price for security Y/);
  });

  it("finds closes on or before a date", () => {
    expect(closeOn(book, "X", "2025-01-04")).toEqual({ close: 11, date: "2025-01-03" });
    expect(closeOn(book, "X", "2025-01-01")).toBeNull();
    expect(closeOn(book, "Z", "2025-01-04")).toBeNull();
  });

  it("flags sells beyond the shares held, counting splits", () => {
    const tx = (date: string, type: "buy" | "sell", quantity: number): Tx => ({
      date,
      type,
      securityId: "X",
      quantity,
      price: 10,
      amount: null,
      fees: 0,
    });
    const split = [{ securityId: "X", exDate: "2025-02-01", ratio: 2 }];
    expect(
      oversoldSells([tx("2025-01-02", "buy", 10), tx("2025-03-01", "sell", 20)], split),
    ).toEqual([]);
    expect(
      oversoldSells([tx("2025-01-02", "buy", 10), tx("2025-01-10", "sell", 11)], split),
    ).toEqual([{ index: 1, held: 10 }]);
    // Listed out of order: still checked in date order.
    expect(oversoldSells([tx("2025-01-10", "sell", 5), tx("2025-01-02", "buy", 10)], [])).toEqual(
      [],
    );
  });
});
