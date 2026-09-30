import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTicker } from "../src/jobs/edgar";
import { assetClassMap, loadUniverse } from "../src/universe";

function writeUniverse(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "universe-"));
  const path = join(dir, "universe.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("universe", () => {
  it("loads the committed config/universe.json", () => {
    const universe = loadUniverse();
    expect(universe.symbols).toHaveLength(65);
    const classes = assetClassMap(universe);
    expect(classes.AAPL).toBe("equity");
    expect(classes.SPY).toBe("etf");
    expect(Object.values(classes).filter((c) => c === "etf")).toHaveLength(15);
  });

  it("rejects duplicate symbols", () => {
    const path = writeUniverse({
      symbols: [
        { symbol: "AAPL", asset_class: "equity" },
        { symbol: "AAPL", asset_class: "equity" },
      ],
    });
    expect(() => loadUniverse(path)).toThrow(/symbols must be unique/);
  });

  it("rejects a lower-case symbol or an unknown asset class", () => {
    expect(() =>
      loadUniverse(writeUniverse({ symbols: [{ symbol: "aapl", asset_class: "equity" }] })),
    ).toThrow(/Invalid universe file/);
    expect(() =>
      loadUniverse(writeUniverse({ symbols: [{ symbol: "AAPL", asset_class: "stock" }] })),
    ).toThrow(/Invalid universe file/);
  });

  it("rejects an empty universe", () => {
    expect(() => loadUniverse(writeUniverse({ symbols: [] }))).toThrow(/Invalid universe file/);
  });
});

describe("normalizeTicker", () => {
  it("matches vendor share-class spellings to SEC's", () => {
    expect(normalizeTicker("BRK.B")).toBe("BRK-B");
    expect(normalizeTicker("brk/b")).toBe("BRK-B");
    expect(normalizeTicker(" BRK-B ")).toBe("BRK-B");
    expect(normalizeTicker("AAPL")).toBe("AAPL");
  });
});
