import { describe, expect, it } from "vitest";
import { evaluateScreen, parseScreen, PRESETS, type SnapshotRow } from "../src";

describe("screen schema", () => {
  it("accepts the presets", () => {
    for (const p of PRESETS) expect(() => parseScreen(p.screen), p.id).not.toThrow();
  });

  it("defaults to no conditions, largest first", () => {
    expect(parseScreen({})).toEqual({
      conditions: [],
      sort: { field: "market_cap", dir: "desc" },
    });
  });

  it.each([
    [{ field: "nope", op: "gt", value: 1 }, "unknown field"],
    [{ field: "rsi14", op: "gt", value: "30" }, "needs a number"],
    [{ field: "rsi14", op: "between", value: [70, 30] }, "low must not exceed high"],
    [{ field: "rsi14", op: "in", value: ["1"] }, "not a list"],
    [{ field: "sector", op: "eq", value: "Crypto" }, "must be one of"],
    [{ field: "sector", op: "gt", value: "Energy" }, "text fields"],
    [{ field: "close", op: "eq", ref: "sma50" }, "compare fields"],
    [{ field: "sector", op: "gt", ref: "sma50" }, "only numeric"],
    [{ field: "pe", op: "is_null", value: 3 }, "takes no value"],
    [{ field: "pe", op: "gt", value: Number.POSITIVE_INFINITY }, "finite"],
  ] as [Record<string, unknown>, string][])("rejects %j (%s)", (condition, _why) => {
    expect(() => parseScreen({ conditions: [condition] })).toThrow();
  });

  it("rejects SQL in values the same as any other bad value", () => {
    expect(() =>
      parseScreen({ conditions: [{ field: "sector", op: "eq", value: "x'; drop table y; --" }] }),
    ).toThrow();
  });
});

describe("oracle", () => {
  const rows: SnapshotRow[] = [
    { ticker: "AAA", close: 10, sma200: 8, high_52w: 10, pe: 12, sector: "Energy" },
    { ticker: "BBB", close: 5, sma200: 6, high_52w: 10, pe: null, sector: "Technology" },
    { ticker: "CCC", close: 20, sma200: 10, high_52w: 25, pe: 30, sector: "technology" },
  ];

  it("drops rows whose field is null, compares fields and ignores text case", () => {
    const s = (conditions: unknown[], field = "close", dir = "desc") =>
      evaluateScreen(rows, parseScreen({ conditions, sort: { field, dir } })).map((r) => r.ticker);
    expect(s([{ field: "pe", op: "lt", value: 100 }])).toEqual(["CCC", "AAA"]);
    expect(s([{ field: "close", op: "gt", ref: "sma200" }])).toEqual(["CCC", "AAA"]);
    expect(s([{ field: "sector", op: "in", value: ["Technology"] }])).toEqual(["CCC", "BBB"]);
    expect(s([{ field: "pct_from_high_52w", op: "gte", value: 0 }])).toEqual(["AAA"]);
    expect(s([], "pe", "asc")).toEqual(["AAA", "CCC", "BBB"]); // nulls last
    expect(s([{ field: "pe", op: "is_null" }])).toEqual(["BBB"]);
  });
});
