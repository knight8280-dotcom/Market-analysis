import { describe, expect, it } from "vitest";
import { ordinal } from "../src/lib/ordinal";
import { formOf, inputsOf, type FormValues } from "../src/lib/valuation-form";

const form: FormValues = {
  revenue0: "1,200",
  years: "5",
  growth: "5",
  ebitMargin: "15",
  taxRate: "21",
  daPct: "4",
  capexPct: "11.5",
  nwcPct: "0",
  wacc: "9",
  method: "growth",
  terminalGrowth: "2.5",
  evEbitda: "12",
  netDebt: "-60",
  shares: "51",
};

describe("DCF form", () => {
  it("turns millions and percents into model inputs and back", () => {
    const { inputs, problems } = inputsOf(form);
    expect(problems).toEqual([]);
    expect(inputs).toMatchObject({
      revenue0: 1.2e9,
      growth: 0.05,
      capexPct: 0.115,
      netDebt: -6e7,
      shares: 5.1e7,
      terminal: { method: "growth", growth: 0.025 },
    });
    expect(inputsOf(formOf(inputs!)).inputs).toEqual(inputs);
  });

  it("names the inputs that need attention", () => {
    expect(inputsOf({ ...form, revenue0: "" }).problems).toEqual([
      "Revenue, last twelve months: enter a number in range",
    ]);
    expect(inputsOf({ ...form, terminalGrowth: "9" }).problems).toEqual([
      "Terminal growth: terminal growth must be below the discount rate (WACC)",
    ]);
    expect(inputsOf({ ...form, shares: "" }).inputs?.shares).toBeNull();
    expect(inputsOf({ ...form, wacc: "abc" }).problems[0]).toMatch(/^Discount rate \(WACC\)/);
  });
});

describe("ordinal", () => {
  it("uses English suffixes", () => {
    expect([0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100].map(ordinal)).toEqual([
      "0th",
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "100th",
    ]);
  });
});
