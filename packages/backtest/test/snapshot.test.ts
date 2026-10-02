import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, type BacktestData } from "../src";
import { codeVersion, dataSnapshotId, PACKAGE_VERSION } from "../src/snapshot";
import { data, security, sessions, walk } from "./helpers";

const D = sessions("2024-01-02", "2024-03-28");
const build = () =>
  data([security(walk("TEST_S1", D, 1)), security(walk("TEST_S2", D, 2))], {
    riskFree: { dates: ["2024-01-02"], rate: [0.05] },
  });

/** The same value with every object's keys in reverse order. */
function reversedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reversedKeys(x)]),
    );
  }
  return v;
}

describe("data snapshot id", () => {
  it("is a SHA-256 that depends on content, not on key order", () => {
    const id = dataSnapshotId(build());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(dataSnapshotId(build())).toBe(id);
    expect(dataSnapshotId(reversedKeys(build()) as BacktestData)).toBe(id);
  });

  it("changes when any price, date or rate changes", () => {
    const id = dataSnapshotId(build());
    const price = build();
    price.securities[1]!.bars.close[30]! += 0.0001;
    expect(dataSnapshotId(price)).not.toBe(id);
    const rate = build();
    rate.riskFree!.rate[0] = 0.0501;
    expect(dataSnapshotId(rate)).not.toBe(id);
    const delisted = build();
    delisted.securities[0]!.delistedAt = "2024-03-28";
    expect(dataSnapshotId(delisted)).not.toBe(id);
  });

  it("tells an empty string from a missing value and an array from its contents", () => {
    const a = build();
    const b = build();
    a.securities[0]!.ticker = "";
    (b.securities[0] as unknown as { ticker: null }).ticker = null;
    expect(dataSnapshotId(a)).not.toBe(dataSnapshotId(b));
    const c = build();
    const d = build();
    c.sessions = ["2024-01-02", "2024-01-03"];
    d.sessions = ["2024-01-02,2024-01-03"];
    expect(dataSnapshotId(c)).not.toBe(dataSnapshotId(d));
  });
});

describe("code version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("names the package and engine versions and a short commit", () => {
    expect(codeVersion()).toBe(`backtest ${PACKAGE_VERSION}, engine ${ENGINE_VERSION}`);
    expect(codeVersion("0123456789abcdef0123")).toBe(
      `backtest ${PACKAGE_VERSION}, engine ${ENGINE_VERSION}, 0123456789ab`,
    );
  });
});
