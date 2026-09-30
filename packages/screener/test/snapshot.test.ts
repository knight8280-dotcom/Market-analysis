import { describe, expect, it } from "vitest";
import { computeSnapshot, trailingTwelveMonths, type AdjustedBar } from "../src";

/** Weekday bars from `start`, closes rising 0.1 a day from 100. */
function bars(start: string, n: number): AdjustedBar[] {
  const out: AdjustedBar[] = [];
  let d = Date.parse(start);
  let close = 100;
  while (out.length < n) {
    const day = new Date(d).getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push({
        date: new Date(d).toISOString().slice(0, 10),
        close,
        high: close + 1,
        low: close - 1,
        volume: 1000,
      });
      close += 0.1;
    }
    d += 86_400_000;
  }
  return out;
}

describe("computeSnapshot", () => {
  const b = bars("2025-06-02", 340); // through late September 2026
  const last = b.at(-1)!;

  it("computes returns from the close on or before each window start", () => {
    const s = computeSnapshot(b, null, null, last.close);
    expect(s.as_of).toBe(last.date);
    expect(s.change_1d).toBeCloseTo(last.close / b.at(-2)!.close - 1, 12);
    const anchor = b.filter((x) => x.date <= "2025-12-31").at(-1)!;
    expect(s.return_ytd).toBeCloseTo(last.close / anchor.close - 1, 12);
    expect(s.sma50).not.toBeNull();
    expect(s.sma200).not.toBeNull();
    expect(s.rsi14).toBe(100); // only rises
    expect(s.avg_volume_30d).toBe(1000);
  });

  it("leaves a return empty when the data has a gap at the window start", () => {
    const gapped = b.filter((x) => x.date < "2026-01-01" || x.date >= "2026-06-01");
    const s = computeSnapshot(gapped, null, null, gapped.at(-1)!.close);
    // The 6-month window starts in March 2026, inside the gap.
    expect(s.return_6m).toBeNull();
    expect(s.return_1y).not.toBeNull();
  });

  it("values only with positive inputs, and never estimates", () => {
    const f = {
      sharesOutstanding: 1_000_000,
      revenueTtm: "50000000",
      netIncomeTtm: "-1000000",
      equity: "20000000",
      asOf: "2026-06-30",
    };
    const s = computeSnapshot(b, f, 2.4, 120);
    expect(s.market_cap).toBe(120_000_000);
    expect(s.pe).toBeNull(); // losses: no P/E
    expect(s.ps).toBeCloseTo(2.4, 12);
    expect(s.pb).toBeCloseTo(6, 12);
    expect(s.dividend_yield).toBeCloseTo(0.02, 12);
    expect(computeSnapshot(b, null, null, 120).market_cap).toBeNull();
  });
});

describe("trailingTwelveMonths", () => {
  const q = (periodEnd: string, revenue: string | null, netIncome = "10") => ({
    periodEnd,
    revenue,
    netIncome,
  });

  it("sums four consecutive recent quarters exactly", () => {
    const ttm = trailingTwelveMonths(
      [
        q("2026-06-30", "100.5"),
        q("2026-03-31", "100"),
        q("2025-12-31", "100"),
        q("2025-09-30", "100"),
      ],
      null,
      "2026-09-29",
    );
    expect(ttm).toEqual({ revenue: "400.5", netIncome: "40", asOf: "2026-06-30" });
  });

  it("needs every quarter for a line, and falls back to a recent fiscal year", () => {
    const quarters = [
      q("2026-06-30", null),
      q("2026-03-31", "1"),
      q("2025-12-31", "1"),
      q("2025-09-30", "1"),
    ];
    expect(trailingTwelveMonths(quarters, null, "2026-09-29").revenue).toBeNull();
    const gap = [
      q("2026-06-30", "1"),
      q("2025-12-31", "1"),
      q("2025-09-30", "1"),
      q("2025-06-30", "1"),
    ];
    expect(trailingTwelveMonths(gap, q("2025-12-31", "9", "3"), "2026-09-29")).toEqual({
      revenue: "9",
      netIncome: "3",
      asOf: "2025-12-31",
    });
    expect(trailingTwelveMonths([], q("2024-12-31", "9"), "2026-09-29").revenue).toBeNull();
  });
});
