import { describe, expect, it } from "vitest";
import {
  AlertDefinition,
  describeAlert,
  evaluateAlert,
  parseAlert,
  type EvaluationInput,
  type LatestBar,
} from "../src";

const NOW = new Date("2026-09-29T22:50:00Z");
const bar = (prevClose: number | null, close: number, date = "2026-09-29"): LatestBar => ({
  date,
  close,
  prevDate: prevClose === null ? null : "2026-09-28",
  prevClose,
});
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  ticker: "TESTX",
  bar: bar(99, 101),
  earnings: null,
  today: "2026-09-29",
  now: NOW,
  lastFiredAt: null,
  cooldownHours: 24,
  ...over,
});
const above = (price: number) => AlertDefinition.parse({ kind: "price_above", params: { price } });
const below = (price: number) => AlertDefinition.parse({ kind: "price_below", params: { price } });

describe("price crossings", () => {
  it("fires when the close crosses the level, keyed by the bar date", () => {
    const r = evaluateAlert(above(100), input());
    expect(r).toMatchObject({ fire: true, key: "2026-09-29" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.subject).toBe("TESTX closed above $100.00");
    expect(r.text).toBe(
      "TESTX closed at $101.00 on Sep 29, 2026, above your level of $100.00 (previous close $99.00).",
    );
  });

  it("fires once per crossing: staying above does not fire again", () => {
    expect(evaluateAlert(above(100), input({ bar: bar(101, 103) }))).toEqual({
      fire: false,
      reason: "not_met",
    });
  });

  it("counts a previous close exactly at the level as below it", () => {
    expect(evaluateAlert(above(100), input({ bar: bar(100, 100.01) })).fire).toBe(true);
    expect(evaluateAlert(above(100), input({ bar: bar(99, 100) })).fire).toBe(false);
  });

  it("handles crossings downward", () => {
    expect(evaluateAlert(below(100), input({ bar: bar(101, 99) })).fire).toBe(true);
    expect(evaluateAlert(below(100), input({ bar: bar(99, 98) })).fire).toBe(false);
    expect(evaluateAlert(below(100), input({ bar: bar(99, 101) })).fire).toBe(false);
  });

  it("needs a previous bar", () => {
    expect(evaluateAlert(above(100), input({ bar: bar(null, 101) }))).toEqual({
      fire: false,
      reason: "no_data",
    });
    expect(evaluateAlert(above(100), input({ bar: null })).fire).toBe(false);
  });
});

describe("percentage moves", () => {
  const move = (pct: number, direction: "up" | "down" | "either") =>
    AlertDefinition.parse({ kind: "pct_move", params: { pct, direction } });

  it("fires at or beyond the threshold in the chosen direction", () => {
    expect(evaluateAlert(move(0.05, "up"), input({ bar: bar(100, 105) })).fire).toBe(true);
    expect(evaluateAlert(move(0.05, "up"), input({ bar: bar(100, 104.99) })).fire).toBe(false);
    expect(evaluateAlert(move(0.05, "up"), input({ bar: bar(100, 90) })).fire).toBe(false);
    expect(evaluateAlert(move(0.05, "down"), input({ bar: bar(100, 95) })).fire).toBe(true);
    expect(evaluateAlert(move(0.05, "either"), input({ bar: bar(100, 94) })).fire).toBe(true);
    expect(evaluateAlert(move(0.05, "either"), input({ bar: bar(100, 106) })).fire).toBe(true);
  });

  it("describes the move", () => {
    const r = evaluateAlert(move(0.05, "down"), input({ bar: bar(80, 72) }));
    if (!r.fire) throw new Error("expected to fire");
    expect(r.subject).toBe("TESTX fell 10.0% on Sep 29, 2026");
    expect(r.text).toContain("fell 10.00%");
    expect(r.text).toContain("split-adjusted");
  });

  it("uses the split-adjusted previous close (a 4:1 split is not a 75% drop)", () => {
    // The worker passes the previous close in the new share basis: 400 / 4 = 100.
    expect(evaluateAlert(move(0.05, "down"), input({ bar: bar(100, 99) })).fire).toBe(false);
  });
});

describe("earnings", () => {
  const soon = (days: number) =>
    AlertDefinition.parse({ kind: "earnings_upcoming", params: { days } });

  it("fires when the next report falls in the window, keyed by the report date", () => {
    const r = evaluateAlert(
      soon(7),
      input({ earnings: { date: "2026-10-06", hour: "amc" }, bar: null }),
    );
    expect(r).toMatchObject({ fire: true, key: "2026-10-06" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.text).toContain("Oct 6, 2026 (after the close)");
  });

  it("does not fire outside the window or for today's report", () => {
    expect(
      evaluateAlert(soon(7), input({ earnings: { date: "2026-10-07", hour: null } })).fire,
    ).toBe(false);
    expect(
      evaluateAlert(soon(7), input({ earnings: { date: "2026-09-29", hour: "amc" } })).fire,
    ).toBe(false);
    expect(evaluateAlert(soon(7), input({ earnings: null }))).toEqual({
      fire: false,
      reason: "no_data",
    });
  });
});

describe("cooldown", () => {
  it("stays quiet within the cooldown and fires after it", () => {
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    expect(evaluateAlert(above(100), input({ lastFiredAt: hoursAgo(23) }))).toEqual({
      fire: false,
      reason: "cooldown",
    });
    expect(evaluateAlert(above(100), input({ lastFiredAt: hoursAgo(24) })).fire).toBe(true);
    expect(
      evaluateAlert(above(100), input({ lastFiredAt: hoursAgo(1), cooldownHours: 0 })).fire,
    ).toBe(true);
  });

  it("reports an unmet condition as such even during a cooldown", () => {
    expect(evaluateAlert(above(100), input({ bar: bar(101, 102), lastFiredAt: NOW }))).toEqual({
      fire: false,
      reason: "not_met",
    });
  });
});

describe("definitions", () => {
  it("rejects bad parameters and unknown fields", () => {
    expect(parseAlert("price_above", { price: -1 })).toBeNull();
    expect(parseAlert("price_above", { price: 10, extra: 1 })).toBeNull();
    expect(parseAlert("pct_move", { pct: 0, direction: "up" })).toBeNull();
    expect(parseAlert("pct_move", { pct: 0.05, direction: "sideways" })).toBeNull();
    expect(parseAlert("earnings_upcoming", { days: 31 })).toBeNull();
    expect(parseAlert("nope", {})).toBeNull();
    expect(parseAlert("earnings_upcoming", { days: 7 })).toEqual({
      kind: "earnings_upcoming",
      params: { days: 7 },
    });
  });

  it("describes each kind in words", () => {
    expect(describeAlert(above(200))).toBe("Closes above $200.00");
    expect(describeAlert(below(0.5))).toBe("Closes below $0.50");
    expect(describeAlert(above(2.705))).toBe("Closes above $2.705");
    expect(
      describeAlert(
        AlertDefinition.parse({ kind: "pct_move", params: { pct: 0.05, direction: "either" } }),
      ),
    ).toBe("Moves 5.0% or more in a day (up or down)");
    expect(
      describeAlert(AlertDefinition.parse({ kind: "earnings_upcoming", params: { days: 1 } })),
    ).toBe("Earnings within 1 day");
  });
});
