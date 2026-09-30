import { describe, expect, it } from "vitest";
import {
  buildStatements,
  decimalSub,
  reportingPeriods,
  type FactRow,
  type StatementRow,
} from "../src/statements";

/**
 * A made-up registrant with calendar fiscal years: the FY2024 10-K, three FY2025 10-Qs and the
 * FY2025 10-K, which restates FY2024 revenue. Values are small round numbers, not real data.
 */
function fact(
  accession: string,
  filed: string,
  form: string,
  fy: number,
  fp: string,
  concept: string,
  value: string,
  start: string | null,
  end: string,
  unit = "USD",
): FactRow {
  return {
    taxonomy: "us-gaap",
    concept,
    unit,
    value,
    period_start: start,
    period_end: end,
    fiscal_year: fy,
    fiscal_period: fp,
    form,
    filed_at: filed,
    accession_no: accession,
  };
}

const K24 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-25-000001", "2025-02-10", "10-K", 2024, "FY", c, v, s, e, u);
const Q1 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-25-000010", "2025-05-01", "10-Q", 2025, "Q1", c, v, s, e, u);
const Q2 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-25-000020", "2025-08-01", "10-Q", 2025, "Q2", c, v, s, e, u);
const Q3 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-25-000030", "2025-11-01", "10-Q", 2025, "Q3", c, v, s, e, u);
const K25 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-26-000001", "2026-02-10", "10-K", 2025, "FY", c, v, s, e, u);

const FACTS: FactRow[] = [
  // FY2024 10-K: current year and prior-year comparatives.
  K24("Revenues", "1000", "2024-01-01", "2024-12-31"),
  K24("Revenues", "900", "2023-01-01", "2023-12-31"),
  K24("Revenues", "950", "2024-01-01", "2024-12-31", "EUR"), // another currency: ignored
  K24("CostOfRevenue", "600", "2024-01-01", "2024-12-31"), // second candidate concept
  K24("NetIncomeLoss", "100", "2024-01-01", "2024-12-31"),
  K24("EarningsPerShareBasic", "1.00", "2024-01-01", "2024-12-31", "USD/shares"),
  K24("Assets", "5000", null, "2024-12-31"),
  K24("Assets", "4500", null, "2023-12-31"),
  K24("NetCashProvidedByUsedInOperatingActivities", "300", "2024-01-01", "2024-12-31"),
  K24("PaymentsToAcquirePropertyPlantAndEquipment", "120", "2024-01-01", "2024-12-31"),
  // FY2025 quarters.
  Q1("Revenues", "280", "2025-01-01", "2025-03-31"),
  Q1("EarningsPerShareBasic", "0.25", "2025-01-01", "2025-03-31", "USD/shares"),
  Q1("NetCashProvidedByUsedInOperatingActivities", "70", "2025-01-01", "2025-03-31"),
  Q1("Assets", "5100", null, "2025-03-31"),
  Q2("Revenues", "290", "2025-04-01", "2025-06-30"),
  Q2("Revenues", "570", "2025-01-01", "2025-06-30"),
  Q2("NetCashProvidedByUsedInOperatingActivities", "150", "2025-01-01", "2025-06-30"),
  Q3("Revenues", "300", "2025-07-01", "2025-09-30"),
  Q3("Revenues", "870", "2025-01-01", "2025-09-30"),
  Q3("NetCashProvidedByUsedInOperatingActivities", "240", "2025-01-01", "2025-09-30"),
  // FY2025 10-K, restating FY2024 revenue from 1000 to 1010.
  K25("Revenues", "1200", "2025-01-01", "2025-12-31"),
  K25("Revenues", "1010", "2024-01-01", "2024-12-31"),
  K25("EarningsPerShareBasic", "1.20", "2025-01-01", "2025-12-31", "USD/shares"),
  K25("NetCashProvidedByUsedInOperatingActivities", "330", "2025-01-01", "2025-12-31"),
  K25("Assets", "5600", null, "2025-12-31"),
];

const rows = buildStatements(FACTS);
function row(
  statement: StatementRow["statement"],
  frequency: StatementRow["frequency"],
  basis: StatementRow["basis"],
  end: string,
): StatementRow {
  const r = rows.find(
    (x) =>
      x.statement === statement &&
      x.frequency === frequency &&
      x.basis === basis &&
      x.periodEnd === end,
  );
  if (!r) throw new Error(`no ${statement} ${frequency} ${basis} row ending ${end}`);
  return r;
}

describe("reportingPeriods", () => {
  it("takes each filing's own period, labelled by that filing, and adds Q4", () => {
    const { annual, quarterly } = reportingPeriods(FACTS);
    // 2023 appears only as a comparative, so it is not a reporting period here.
    expect(annual.map((p) => [p.fiscalYear, p.fiscalPeriod, p.start, p.end])).toEqual([
      [2024, "FY", "2024-01-01", "2024-12-31"],
      [2025, "FY", "2025-01-01", "2025-12-31"],
    ]);
    expect(quarterly.map((p) => [p.fiscalPeriod, p.start, p.end])).toEqual([
      ["Q1", "2025-01-01", "2025-03-31"],
      ["Q2", "2025-04-01", "2025-06-30"],
      ["Q3", "2025-07-01", "2025-09-30"],
      ["Q4", "2025-10-01", "2025-12-31"],
    ]);
  });
});

describe("buildStatements", () => {
  it("applies restatements to the latest basis and keeps the original as reported", () => {
    const latest = row("income", "annual", "latest", "2024-12-31");
    const original = row("income", "annual", "as_reported", "2024-12-31");
    expect(latest.lineItems.revenue).toMatchObject({
      value: "1010",
      concept: "us-gaap:Revenues",
      accession: "0000000042-26-000001",
      filed: "2026-02-10",
    });
    expect(original.lineItems.revenue).toMatchObject({
      value: "1000",
      accession: "0000000042-25-000001",
    });
    expect(latest.restated).toBe(true);
    expect(original.restated).toBe(true);
    expect(row("income", "annual", "latest", "2025-12-31").restated).toBe(false);
  });

  it("falls back to the next candidate concept and records which one it used", () => {
    expect(row("income", "annual", "latest", "2024-12-31").lineItems.costOfRevenue).toMatchObject({
      value: "600",
      concept: "us-gaap:CostOfRevenue",
    });
  });

  it("ignores other currencies", () => {
    const values = rows.flatMap((r) => Object.values(r.lineItems).map((v) => v.unit));
    expect(values).not.toContain("EUR");
  });

  it("uses reported quarters and derives Q4 from the year, marked as derived", () => {
    const q = (end: string) => row("income", "quarterly", "latest", end).lineItems;
    expect(q("2025-03-31").revenue?.value).toBe("280");
    expect(q("2025-06-30").revenue).toMatchObject({ value: "290" });
    expect(q("2025-06-30").revenue?.derived).toBeUndefined();
    expect(q("2025-12-31").revenue).toMatchObject({ value: "330", derived: "FY − 9M YTD" });
    // Per-share values are never derived.
    expect(q("2025-03-31").epsBasic?.value).toBe("0.25");
    expect(q("2025-12-31").epsBasic).toBeUndefined();
  });

  it("derives quarterly cash flow from year-to-date values", () => {
    const cf = (end: string) => row("cashflow", "quarterly", "latest", end).lineItems;
    expect(cf("2025-03-31").operatingCashFlow?.value).toBe("70");
    expect(cf("2025-06-30").operatingCashFlow).toMatchObject({
      value: "80",
      derived: "6M YTD − 3M",
    });
    expect(cf("2025-09-30").operatingCashFlow).toMatchObject({
      value: "90",
      derived: "9M YTD − 6M YTD",
    });
    expect(cf("2025-12-31").operatingCashFlow).toMatchObject({
      value: "90",
      derived: "FY − 9M YTD",
    });
  });

  it("derives free cash flow, marked as derived", () => {
    expect(row("cashflow", "annual", "latest", "2024-12-31").lineItems.freeCashFlow).toMatchObject({
      value: "180",
      concept: "derived",
      derived: "cash from operations − capital expenditure",
    });
  });

  it("builds balance sheets from instants, with no period start", () => {
    const bs = row("balance", "annual", "latest", "2024-12-31");
    expect(bs.periodStart).toBeNull();
    expect(bs.lineItems.totalAssets?.value).toBe("5000");
    expect(row("balance", "quarterly", "latest", "2025-03-31").lineItems.totalAssets?.value).toBe(
      "5100",
    );
    expect(row("balance", "quarterly", "latest", "2025-12-31").fiscalPeriod).toBe("Q4");
  });

  it("returns nothing for no facts", () => {
    expect(buildStatements([])).toEqual([]);
  });
});

describe("decimalSub", () => {
  it("subtracts exactly", () => {
    expect(decimalSub("0.3", "0.1")).toBe("0.2");
    expect(decimalSub("100", "250")).toBe("-150");
    expect(decimalSub("1.50", "1.5")).toBe("0");
    expect(decimalSub("391035000000", "1")).toBe("391034999999");
    expect(decimalSub("-0.05", "0.05")).toBe("-0.1");
    expect(() => decimalSub("1e5", "1")).toThrow(RangeError);
  });
});
