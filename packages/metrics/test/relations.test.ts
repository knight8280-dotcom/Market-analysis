import { describe, expect, it } from "vitest";
import { beta, concentration, correlation, correlationMatrix, paired } from "../src";

describe("relations between return series", () => {
  it("pairs only positions where both returns are known", () => {
    expect(paired([1, null, 3, 4], [5, 6, null, 8])).toEqual({ a: [1, 4], b: [5, 8] });
  });

  it("gives beta and correlation of exact linear relations", () => {
    const m = [0.01, -0.02, 0.015, 0.003, -0.007];
    const twice = m.map((x) => 2 * x + 0.001);
    expect(beta(twice, m)).toBeCloseTo(2, 12);
    expect(correlation(twice, m)).toBeCloseTo(1, 12);
    expect(
      correlation(
        m.map((x) => -x),
        m,
      ),
    ).toBeCloseTo(-1, 12);
    // Too few pairs, or no variation: unavailable rather than 0 or ±1.
    expect(correlation([0.01, 0.02], [0.03, 0.01])).toBeNull();
    expect(beta(m, [0.01, 0.01, 0.01, 0.01, 0.01])).toBeNull();
  });

  it("builds a symmetric matrix with ones on the diagonal", () => {
    const a = [0.01, -0.02, 0.015, 0.003];
    const b = [0.02, -0.01, 0.0, 0.004];
    const flat = [0, 0, 0, 0];
    const m = correlationMatrix([a, b, flat]);
    expect(m[0]![0]).toBe(1);
    expect(m[0]![1]).toBe(m[1]![0]);
    expect(m[2]![2]).toBeNull();
    expect(m[0]![2]).toBeNull();
  });

  it("measures concentration of positive weights", () => {
    expect(concentration([50, 50])).toEqual({ top10: 1, hhi: 0.5, effectiveCount: 2, count: 2 });
    const twelve = concentration(Array.from({ length: 12 }, () => 1))!;
    expect(twelve.top10).toBeCloseTo(10 / 12, 12);
    expect(twelve.effectiveCount).toBeCloseTo(12, 12);
    expect(concentration([0, -5])).toBeNull();
  });
});
