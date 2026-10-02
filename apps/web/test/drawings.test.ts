import { describe, expect, it } from "vitest";
import {
  describeDrawing,
  DrawingInput,
  fibLevels,
  sessionIndex,
  type DrawingInput as Input,
} from "../src/lib/chart/drawings";

/** Chart drawings (Phase 2 step F1): what is accepted, Fibonacci prices, snapping to sessions. */

const a = { time: "2026-09-01", price: 100 };
const b = { time: "2026-09-30", price: 200 };
const ok = (d: unknown) => DrawingInput.safeParse(d).success;

describe("DrawingInput", () => {
  it("takes the right number of points for each kind", () => {
    expect(ok({ kind: "trendline", basis: "adjusted", points: [a, b] })).toBe(true);
    expect(ok({ kind: "trendline", basis: "adjusted", points: [a] })).toBe(false);
    expect(ok({ kind: "horizontal", basis: "raw", points: [a] })).toBe(true);
    expect(ok({ kind: "horizontal", basis: "raw", points: [a, b] })).toBe(false);
    expect(ok({ kind: "fibonacci", basis: "raw", points: [a, b] })).toBe(true);
    expect(ok({ kind: "rectangle", basis: "raw", points: [a, b] })).toBe(true);
  });

  it("needs text for a text label, two different points, positive prices and real dates", () => {
    expect(ok({ kind: "text", basis: "raw", points: [a] })).toBe(false);
    expect(ok({ kind: "text", basis: "raw", points: [a], label: "  " })).toBe(false);
    expect(ok({ kind: "text", basis: "raw", points: [a], label: "Breakout" })).toBe(true);
    expect(ok({ kind: "trendline", basis: "raw", points: [a, a] })).toBe(false);
    expect(ok({ kind: "horizontal", basis: "raw", points: [{ ...a, price: 0 }] })).toBe(false);
    expect(ok({ kind: "horizontal", basis: "raw", points: [{ ...a, time: "2026-02-30" }] })).toBe(
      false,
    );
    expect(ok({ kind: "horizontal", basis: "both", points: [a] })).toBe(false);
    expect(ok({ kind: "text", basis: "raw", points: [a], label: "x".repeat(101) })).toBe(false);
  });
});

describe("fibLevels", () => {
  it("measures retracements back from the end of the move", () => {
    expect(fibLevels(100, 200).map((l) => [l.level, Number(l.price.toFixed(6))])).toEqual([
      [0, 200],
      [0.236, 176.4],
      [0.382, 161.8],
      [0.5, 150],
      [0.618, 138.2],
      [0.786, 121.4],
      [1, 100],
    ]);
    // A fall from 200 to 100 retraces upward.
    expect(fibLevels(200, 100).find((l) => l.level === 0.618)?.price).toBeCloseTo(161.8, 9);
  });
});

describe("sessionIndex", () => {
  const sessions = ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"];
  it("finds the session, or the one before a weekend or holiday", () => {
    expect(sessionIndex(sessions, "2026-09-28")).toBe(1);
    expect(sessionIndex(sessions, "2026-09-27")).toBe(0);
    expect(sessionIndex(sessions, "2026-10-05")).toBe(3);
    expect(sessionIndex(sessions, "2026-09-24")).toBe(-1);
    expect(sessionIndex([], "2026-09-24")).toBe(-1);
  });
});

describe("describeDrawing", () => {
  it("puts each drawing in words", () => {
    const d = (x: Partial<Input>): Input => ({
      kind: "trendline",
      basis: "adjusted",
      points: [a, b],
      ...x,
    });
    expect(describeDrawing(d({}))).toBe(
      "Trend line from Sep 1, 2026 at 100.00 to Sep 30, 2026 at 200.00",
    );
    expect(describeDrawing(d({ kind: "horizontal", points: [a], label: "Support" }))).toBe(
      "Horizontal line at 100.00 (“Support”)",
    );
    expect(describeDrawing(d({ kind: "text", points: [b], label: "Breakout" }))).toBe(
      "Text “Breakout” on Sep 30, 2026 at 200.00",
    );
    expect(describeDrawing(d({ kind: "fibonacci" }))).toBe(
      "Fibonacci retracement from Sep 1, 2026 at 100.00 to Sep 30, 2026 at 200.00: " +
        "23.6% 176.40, 38.2% 161.80, 50.0% 150.00, 61.8% 138.20, 78.6% 121.40",
    );
  });
});
