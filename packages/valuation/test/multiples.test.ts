import { trailingTwelveMonths } from "@market/screener";
import { describe, expect, it } from "vitest";
import {
  latestAsOf,
  median,
  monthEnds,
  multiples,
  nearestByMarketCap,
  percentileRank,
  ttmAsOf,
  type PeriodValue,
} from "../src";

describe("multiples", () => {
  it("divide by positive figures only", () => {
    const m = multiples({
      price: 50,
      shares: 10,
      revenueTtm: 250,
      netIncomeTtm: 20,
      ebitdaTtm: 60,
      netDebt: 100,
    });
    expect(m).toEqual({ marketCap: 500, enterpriseValue: 600, pe: 25, ps: 2, evEbitda: 10 });
    const losses = multiples({
      price: 50,
      shares: 10,
      revenueTtm: 250,
      netIncomeTtm: -5,
      ebitdaTtm: -1,
      netDebt: null,
    });
    expect(losses).toEqual({
      marketCap: 500,
      enterpriseValue: null,
      pe: null,
      ps: 2,
      evEbitda: null,
    });
    expect(
      multiples({
        price: null,
        shares: 10,
        revenueTtm: 1,
        netIncomeTtm: 1,
        ebitdaTtm: 1,
        netDebt: 0,
      }).pe,
    ).toBeNull();
  });

  it("summarize peers with a median and a percentile rank", () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([null])).toBeNull();
    expect(percentileRank(2, [1, 2, 3])).toBeCloseTo(0.5, 12);
    expect(percentileRank(10, [1, 2, 3])).toBe(1);
    expect(percentileRank(null, [1])).toBeNull();
    expect(percentileRank(1, [])).toBeNull();
  });

  it("pick peers closest in market cap on a log scale", () => {
    const c = [
      { id: "a", marketCap: 1e9 },
      { id: "b", marketCap: 4e9 },
      { id: "c", marketCap: 10e9 },
      { id: "d", marketCap: null },
      { id: "s", marketCap: 2e9 },
    ];
    // log distance from 2e9: a = ln 2, b = ln 2, c = ln 5.
    expect(
      nearestByMarketCap({ id: "s", marketCap: 2e9 }, c, 2)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(nearestByMarketCap({ id: "s", marketCap: null }, c, 1).map((x) => x.id)).toEqual(["c"]);
  });
});

const q = (periodEnd: string, value: number | null, filed: string): PeriodValue => ({
  frequency: "quarterly",
  periodEnd,
  value: value === null ? null : { value, filed },
});
const fy = (periodEnd: string, value: number, filed: string): PeriodValue => ({
  frequency: "annual",
  periodEnd,
  value: { value, filed },
});

describe("figures as known on a date", () => {
  const revenue = [
    fy("2024-12-31", 1000, "2025-02-10"),
    q("2025-03-31", 280, "2025-05-01"),
    q("2025-06-30", 290, "2025-08-01"),
    q("2025-09-30", 300, "2025-11-01"),
    q("2025-12-31", 330, "2026-02-10"),
  ];

  it("use four quarters once all are filed, the fiscal year before that, and nothing earlier", () => {
    expect(ttmAsOf(revenue, "2025-02-10")).toBeNull(); // filed that day: usable from the next
    expect(ttmAsOf(revenue, "2025-02-11")).toMatchObject({ value: 1000, basis: "fiscal_year" });
    expect(ttmAsOf(revenue, "2026-02-11")).toMatchObject({
      value: 1200,
      basis: "four_quarters",
      periodEnd: "2025-12-31",
      filed: "2026-02-10",
    });
    // A fiscal year more than 460 days old is too stale to stand in.
    expect(ttmAsOf([revenue[0]!], "2026-04-10")).toBeNull();
  });

  it("agree with the screener's rule when every quarter reports both lines", () => {
    const net = [
      fy("2024-12-31", 100, "2025-02-10"),
      q("2025-03-31", 20, "2025-05-01"),
      q("2025-06-30", 25, "2025-08-01"),
      q("2025-09-30", 30, "2025-11-01"),
      q("2025-12-31", 55, "2026-02-10"),
    ];
    for (const asOf of ["2025-03-01", "2025-09-01", "2025-12-01", "2026-03-01", "2026-06-01"]) {
      const known = (rows: PeriodValue[], frequency: string) =>
        rows.filter((r) => r.frequency === frequency && r.value!.filed < asOf);
      const quarters = known(revenue, "quarterly").map((r, i) => ({
        periodEnd: r.periodEnd,
        revenue: String(r.value!.value),
        netIncome: String(known(net, "quarterly")[i]!.value!.value),
      }));
      const annual = known(revenue, "annual")[0];
      const screener = trailingTwelveMonths(
        quarters,
        annual
          ? { periodEnd: annual.periodEnd, revenue: String(annual.value!.value), netIncome: "100" }
          : null,
        asOf,
      );
      expect(ttmAsOf(revenue, asOf)?.value ?? null, asOf).toBe(
        screener.revenue === null ? null : Number(screener.revenue),
      );
      expect(ttmAsOf(net, asOf)?.value ?? null, asOf).toBe(
        screener.netIncome === null ? null : Number(screener.netIncome),
      );
    }
  });

  it("fall back to the fiscal year for a line some quarters do not report", () => {
    const da = [fy("2025-12-31", 90, "2026-02-10"), q("2025-12-31", null, "2026-02-10")];
    expect(ttmAsOf(da, "2026-03-01")).toMatchObject({ value: 90, basis: "fiscal_year" });
  });

  it("take the latest period's value for instants and per-period figures", () => {
    const debt = [
      fy("2024-12-31", 500, "2025-02-10"),
      q("2025-06-30", 450, "2025-08-01"),
      q("2025-09-30", 400, "2025-11-01"),
    ];
    expect(latestAsOf(debt, "2025-10-01")).toMatchObject({ value: 450, periodEnd: "2025-06-30" });
    expect(latestAsOf(debt, "2025-11-02")).toMatchObject({ value: 400, basis: "period" });
  });

  it("finds each month's last session", () => {
    expect(
      monthEnds(["2025-01-30", "2025-01-31", "2025-02-03", "2025-02-28", "2025-03-03"]),
    ).toEqual(["2025-01-31", "2025-02-28", "2025-03-03"]);
  });
});
