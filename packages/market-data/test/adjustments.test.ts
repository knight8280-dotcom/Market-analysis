import { describe, expect, it } from "vitest";
import { computeAdjustmentFactors, factorFor, type AdjustableAction } from "../src/adjustments";

const split = (ex_date: string, ratio: number): AdjustableAction => ({
  type: "split",
  ex_date,
  ratio,
  cash_amount: null,
});
const cash = (
  ex_date: string,
  amount: number,
  type: "cash_dividend" | "special_dividend" = "cash_dividend",
): AdjustableAction => ({
  type,
  ex_date,
  ratio: null,
  cash_amount: amount,
});
const closes = (map: Record<string, number>) => (d: string) => map[d] ?? null;

describe("computeAdjustmentFactors", () => {
  it.each([
    ["4:1 split", 4, 0.25],
    ["20:1 split", 20, 0.05],
    ["1:10 reverse split", 0.1, 10],
  ])("%s scales earlier prices by 1/ratio", (_name, ratio, expected) => {
    const { factors, issues } = computeAdjustmentFactors([split("2020-08-31", ratio)], closes({}));
    expect(issues).toEqual([]);
    expect(factors).toHaveLength(1);
    expect(factors[0]!.ex_date).toBe("2020-08-31");
    expect(factors[0]!.split_factor).toBeCloseTo(expected, 12);
    expect(factors[0]!.dividend_factor).toBe(1);
    expect(factorFor("2020-08-28", factors).split).toBeCloseTo(expected, 12);
    expect(factorFor("2020-08-31", factors)).toEqual({ split: 1, dividend: 1 });
  });

  it("treats a 5% stock dividend as a 1.05 split", () => {
    const { factors } = computeAdjustmentFactors(
      [{ type: "stock_dividend", ex_date: "2019-06-17", ratio: 1.05, cash_amount: null }],
      closes({}),
    );
    expect(factors[0]!.split_factor).toBeCloseTo(1 / 1.05, 12);
  });

  it("scales by 1 - D/C using the raw close before the ex-date", () => {
    const { factors } = computeAdjustmentFactors(
      [cash("2024-02-09", 1), cash("2021-12-15", 5, "special_dividend")],
      closes({ "2024-02-09": 100, "2021-12-15": 50 }),
    );
    expect(factors.map((f) => f.ex_date)).toEqual(["2021-12-15", "2024-02-09"]);
    expect(factors[1]!.dividend_factor).toBeCloseTo(0.99, 12);
    // Earlier bars carry both dividends.
    expect(factors[0]!.dividend_factor).toBeCloseTo(0.99 * 0.9, 12);
  });

  it("accumulates factors from the latest action backwards", () => {
    // Dividend of 0.20 on a raw close of 440, then a 4:1 split three weeks later.
    const { factors } = computeAdjustmentFactors(
      [cash("2020-08-07", 0.2), split("2020-08-31", 4)],
      closes({ "2020-08-07": 440 }),
    );
    expect(factors).toEqual([
      { ex_date: "2020-08-07", split_factor: 0.25, dividend_factor: 1 - 0.2 / 440 },
      { ex_date: "2020-08-31", split_factor: 0.25, dividend_factor: 1 },
    ]);
    expect(factorFor("2020-08-06", factors)).toEqual({ split: 0.25, dividend: 1 - 0.2 / 440 });
    expect(factorFor("2020-08-07", factors)).toEqual({ split: 0.25, dividend: 1 });
  });

  it("uses post-split units when a dividend shares the split's ex-date", () => {
    const { factors } = computeAdjustmentFactors(
      [split("2022-07-18", 20), cash("2022-07-18", 1)],
      closes({ "2022-07-18": 2000 }),
    );
    // Price in new shares is 2000 / 20 = 100, so the dividend factor is 1 - 1/100.
    expect(factors[0]!.dividend_factor).toBeCloseTo(0.99, 12);
    expect(factors[0]!.split_factor).toBeCloseTo(0.05, 12);
  });

  it("does not guess when the previous close is missing or the dividend is too large", () => {
    const missing = computeAdjustmentFactors([cash("2024-02-09", 1)], closes({}));
    expect(missing.factors).toEqual([]);
    expect(missing.issues).toMatchObject([
      { rule: "dividend_prev_close_missing", ex_date: "2024-02-09" },
    ]);

    const tooBig = computeAdjustmentFactors([cash("2024-02-09", 12)], closes({ "2024-02-09": 10 }));
    expect(tooBig.factors).toEqual([]);
    expect(tooBig.issues).toMatchObject([{ rule: "dividend_exceeds_price" }]);
  });

  it("stores but does not price-adjust spin-offs and mergers", () => {
    const { factors, issues } = computeAdjustmentFactors(
      [{ type: "spin_off", ex_date: "2022-11-01", ratio: null, cash_amount: null }],
      closes({}),
    );
    expect(factors).toEqual([]);
    expect(issues).toMatchObject([{ rule: "action_not_adjusted", ex_date: "2022-11-01" }]);
  });

  it("does not mutate its inputs", () => {
    const actions = Object.freeze([Object.freeze(split("2020-08-31", 4))]);
    expect(() => computeAdjustmentFactors(actions, closes({}))).not.toThrow();
  });
});
