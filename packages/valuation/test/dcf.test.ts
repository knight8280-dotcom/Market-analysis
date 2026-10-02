import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DcfInputs, runDcf, sensitivity } from "../src";

/** The DCF against scripts/make_fixture.py's row-by-row, spreadsheet-style computation. */
interface Fixture {
  inputs: unknown;
  result: Record<string, number | null> & { rows: Record<string, number>[] };
  sensitivity: { kind: string; waccs: number[]; columns: number[]; values: (number | null)[][] };
}
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/dcf.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;

const close = (a: number | null | undefined, b: number | null) => {
  if (b === null) {
    expect(a).toBeNull();
    return;
  }
  expect(a).not.toBeNull();
  expect(Math.abs(a! - b), `${a} vs ${b}`).toBeLessThanOrEqual(
    Math.max(Math.abs(b) * 1e-10, 1e-10),
  );
};

describe.each(Object.keys(fixtures))("scenario %s vs the spreadsheet", (name) => {
  const fx = fixtures[name]!;
  const inputs = DcfInputs.parse(fx.inputs);
  const result = runDcf(inputs);

  it("matches every year's row", () => {
    expect(result.rows).toHaveLength(fx.result.rows.length);
    result.rows.forEach((r, i) => {
      for (const key of Object.keys(fx.result.rows[i]!)) {
        close(r[key as keyof typeof r], fx.result.rows[i]![key]!);
      }
    });
  });

  it("matches the totals, per-share value and cross-checks", () => {
    for (const key of [
      "pvStage1",
      "terminalValue",
      "pvTerminal",
      "enterpriseValue",
      "equityValue",
      "perShare",
      "terminalShare",
      "impliedEvEbitda",
      "impliedGrowth",
    ] as const) {
      close(result[key], fx.result[key] as number | null);
    }
  });

  it("matches the sensitivity grid", () => {
    const grid = sensitivity(inputs);
    expect(grid.kind).toBe(fx.sensitivity.kind);
    grid.waccs.forEach((w, i) => close(w, fx.sensitivity.waccs[i]!));
    grid.columns.forEach((c, i) => close(c, fx.sensitivity.columns[i]!));
    grid.values.forEach((row, i) => row.forEach((v, j) => close(v, fx.sensitivity.values[i]![j]!)));
  });
});

describe("inputs", () => {
  const base = fixtures.growth!.inputs as Record<string, unknown>;

  it("refuse a terminal growth at or above the discount rate", () => {
    const bad = DcfInputs.safeParse({ ...base, terminal: { method: "growth", growth: 0.09 } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain(
      "terminal growth must be below the discount rate",
    );
  });

  it("refuse values outside their ranges", () => {
    for (const patch of [
      { revenue0: 0 },
      { years: 0 },
      { years: 2.5 },
      { wacc: 0 },
      { taxRate: 0.9 },
      { shares: -1 },
    ]) {
      expect(DcfInputs.safeParse({ ...base, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("marks sensitivity cells where the terminal growth reaches the discount rate", () => {
    const tight = DcfInputs.parse({
      ...base,
      wacc: 0.03,
      terminal: { method: "growth", growth: 0.02 },
    });
    const grid = sensitivity(tight);
    expect(grid.waccs).toEqual([0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(grid.values[0]!.every((v) => v === null)).toBe(true); // WACC 1% ≤ every growth
    expect(grid.values[4]![4]).not.toBeNull(); // 5% vs 3%
  });

  it("recomputes fast enough for live editing", () => {
    const inputs = DcfInputs.parse({ ...base, years: 15 });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) sensitivity(inputs);
    // 100 grids of 25 models each; the page does one per keystroke.
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
