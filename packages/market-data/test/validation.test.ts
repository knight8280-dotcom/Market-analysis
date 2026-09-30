import { isTradingDay } from "@market/calendar";
import { describe, expect, it } from "vitest";
import type { DailyBar } from "../src/types";
import { validateDailyBars, type BarValidationContext } from "../src/validation";

const fetched = new Date("2026-09-30T00:00:00Z");
function bar(
  date: string,
  ohlcv: [number, number, number, number, number],
  vwap: number | null = null,
): DailyBar {
  const [open, high, low, close, volume] = ohlcv;
  return {
    source: "synthetic",
    source_symbol: "TEST_V",
    fetched_at: fetched,
    as_of: fetched,
    license_tier: "synthetic",
    date,
    open,
    high,
    low,
    close,
    volume,
    vwap,
  };
}
const ctx: BarValidationContext = { previousClose: null, actionDates: new Set(), isTradingDay };

describe("validateDailyBars", () => {
  it("accepts clean bars in date order", () => {
    const r = validateDailyBars(
      [bar("2024-01-03", [10, 11, 9, 10.5, 100]), bar("2024-01-02", [10, 11, 9, 10, 100])],
      ctx,
    );
    expect(r.issues).toEqual([]);
    expect(r.accepted.map((b) => b.date)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it.each([
    ["high below close", [10, 10.4, 9, 10.5, 100], "ohlc_inconsistent"],
    ["low above open", [10, 11, 10.2, 10.5, 100], "ohlc_inconsistent"],
    ["zero price", [0, 11, 0, 10.5, 100], "non_positive_price"],
    ["negative volume", [10, 11, 9, 10.5, -1], "negative_volume"],
    ["fractional volume", [10, 11, 9, 10.5, 100.5], "non_integer_volume"],
  ] as const)("rejects a bar with %s", (_name, ohlcv, rule) => {
    const r = validateDailyBars([bar("2024-01-02", [...ohlcv])], ctx);
    expect(r.accepted).toEqual([]);
    expect(r.issues).toMatchObject([
      { rule, severity: "error", action: "rejected", date: "2024-01-02" },
    ]);
  });

  it("collapses identical duplicates and rejects conflicting ones", () => {
    const same = validateDailyBars(
      [bar("2024-01-02", [10, 11, 9, 10, 100]), bar("2024-01-02", [10, 11, 9, 10, 100])],
      ctx,
    );
    expect(same.accepted).toHaveLength(1);
    expect(same.issues).toMatchObject([{ rule: "duplicate_bar", action: "skipped" }]);

    const conflict = validateDailyBars(
      [bar("2024-01-02", [10, 11, 9, 10, 100]), bar("2024-01-02", [10, 11, 9, 10.2, 100])],
      ctx,
    );
    expect(conflict.accepted).toEqual([]);
    expect(conflict.issues).toMatchObject([
      { rule: "conflicting_duplicate_bar", action: "rejected" },
    ]);
  });

  it("flags a >50% move without a corporate action but keeps the bar", () => {
    const r = validateDailyBars(
      [bar("2024-01-02", [10, 10, 10, 10, 1]), bar("2024-01-03", [16, 16, 16, 16, 1])],
      ctx,
    );
    expect(r.accepted).toHaveLength(2);
    expect(r.issues).toMatchObject([
      {
        rule: "large_move_without_action",
        severity: "warning",
        action: "flagged",
        date: "2024-01-03",
      },
    ]);
  });

  it("does not flag a large move on a corporate-action ex-date", () => {
    const r = validateDailyBars([bar("2020-08-31", [100, 101, 99, 100, 1])], {
      ...ctx,
      previousClose: 400,
      actionDates: new Set(["2020-08-31"]),
    });
    expect(r.issues).toEqual([]);
  });

  it("compares against the stored previous close for the first bar", () => {
    const r = validateDailyBars([bar("2024-01-03", [4, 4, 4, 4, 1])], {
      ...ctx,
      previousClose: 10,
    });
    expect(r.issues).toMatchObject([{ rule: "large_move_without_action" }]);
  });

  it("measures moves from the last accepted bar, skipping rejected ones", () => {
    const r = validateDailyBars(
      [
        bar("2024-01-02", [10, 10, 10, 10, 1]),
        bar("2024-01-03", [99, 1, 1, 99, 1]),
        bar("2024-01-04", [10.5, 10.5, 10.5, 10.5, 1]),
      ],
      ctx,
    );
    expect(r.accepted.map((b) => b.date)).toEqual(["2024-01-02", "2024-01-04"]);
    expect(r.issues.map((i) => i.rule)).toEqual(["ohlc_inconsistent"]);
  });

  it("flags bars on days the calendar says were closed", () => {
    const r = validateDailyBars([bar("2024-07-04", [10, 11, 9, 10, 100])], ctx);
    expect(r.accepted).toHaveLength(1);
    expect(r.issues).toMatchObject([{ rule: "non_trading_day", action: "flagged" }]);
  });
});
