import { describe, expect, it } from "vitest";
import {
  alignBenchmark,
  computeIndicators,
  DEFAULT_INDICATORS,
  INDICATORS,
  timeframeStart,
  type ChartBars,
} from "../src/lib/chart/catalog";

const bars: ChartBars = {
  time: Array.from({ length: 300 }, (_, i) =>
    new Date(Date.UTC(2025, 0, 2 + i)).toISOString().slice(0, 10),
  ),
  open: [],
  high: [],
  low: [],
  close: [],
  volume: [],
};
for (let i = 0; i < 300; i += 1) {
  const c = 100 + 10 * Math.sin(i / 10);
  bars.open.push(c - 0.5);
  bars.high.push(c + 1);
  bars.low.push(c - 1);
  bars.close.push(c);
  bars.volume.push(1000 + i);
}

describe("indicator catalog", () => {
  it("has unique ids, and every default exists", () => {
    const ids = INDICATORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of DEFAULT_INDICATORS) expect(ids).toContain(id);
  });

  it("computes each indicator at full length, with every declared line", () => {
    const all = INDICATORS.map((d) => d.id);
    const results = computeIndicators(bars, bars.close, all);
    for (const def of INDICATORS) {
      for (const line of def.lines) {
        expect(results[def.id]?.[line.key], `${def.id}.${line.key}`).toHaveLength(300);
      }
    }
  });

  it("skips relative strength without a benchmark", () => {
    expect(computeIndicators(bars, null, ["rs", "sma20"])).not.toHaveProperty("rs");
  });
});

describe("alignBenchmark", () => {
  it("carries the last close over the benchmark's missing dates", () => {
    expect(
      alignBenchmark(
        ["2025-01-02", "2025-01-03", "2025-01-06"],
        [
          ["2025-01-02", 10],
          ["2025-01-06", 12],
        ],
      ),
    ).toEqual([10, 10, 12]);
  });

  it("gives up when the security's history starts before the benchmark's", () => {
    expect(alignBenchmark(["2025-01-02", "2025-01-03"], [["2025-01-03", 10]])).toBeNull();
    expect(alignBenchmark(["2025-01-02"], null)).toBeNull();
  });
});

describe("timeframeStart", () => {
  it("counts back calendar months from the last session", () => {
    expect(timeframeStart("1M", "2026-09-29")).toBe("2026-08-29");
    expect(timeframeStart("1Y", "2026-09-29")).toBe("2025-09-29");
    expect(timeframeStart("5Y", "2026-09-29")).toBe("2021-09-29");
    expect(timeframeStart("YTD", "2026-09-29")).toBe("2026-01-01");
    expect(timeframeStart("MAX", "2026-09-29")).toBeNull();
  });
});
