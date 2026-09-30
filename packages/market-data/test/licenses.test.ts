import { describe, expect, it } from "vitest";
import {
  attributionsFor,
  canDisplay,
  DATA_LICENSES,
  enforceDelay,
  type DataLicense,
} from "../src/licenses";
import { PROVIDER_IDS } from "../src/types";

describe("data licenses", () => {
  it("has an entry with attribution for every provider", () => {
    for (const p of PROVIDER_IDS) {
      expect(DATA_LICENSES[p].provider).toBe(p);
      expect(DATA_LICENSES[p].attribution.text.length).toBeGreaterThan(0);
    }
  });

  it("never allows synthetic data in production", () => {
    expect(canDisplay("synthetic", "daily_bars", "local")).toBe(true);
    expect(canDisplay("synthetic", "daily_bars", "production")).toBe(false);
  });

  it("blocks display of uncontracted commercial data", () => {
    for (const p of ["tiingo", "twelvedata", "massive"] as const) {
      expect(DATA_LICENSES[p].status).toBe("not_contracted");
      expect(canDisplay(p, "daily_bars", "production")).toBe(false);
      expect(canDisplay(p, "daily_bars", "local")).toBe(false);
    }
  });

  it("allows public government data for its datasets only", () => {
    expect(canDisplay("sec_edgar", "fundamentals", "production")).toBe(true);
    expect(canDisplay("sec_edgar", "daily_bars", "production")).toBe(false);
    expect(canDisplay("fred", "macro", "production")).toBe(true);
  });

  it("carries FRED's required notice verbatim", () => {
    expect(DATA_LICENSES.fred.attribution.text).toBe(
      "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    );
  });

  it("deduplicates attributions in first-seen order", () => {
    expect(attributionsFor(["fred", "sec_edgar", "fred"]).map((a) => a.provider)).toEqual([
      "fred",
      "sec_edgar",
    ]);
  });
});

describe("enforceDelay", () => {
  const delayed: DataLicense = {
    ...DATA_LICENSES.tiingo,
    status: "contracted",
    display: { allowed: true, realtime: false, intradayDelayMinutes: 15, datasets: ["daily_bars"] },
  };
  const now = new Date("2026-09-29T15:00:00Z");
  const at = (min: number) => ({ as_of: new Date(now.getTime() - min * 60_000), min });
  const records = [at(30), at(15), at(14), at(0)];

  it("drops prints newer than now minus the license delay", () => {
    const shown = enforceDelay(records, { license: delayed, entitledRealtime: false, now });
    expect(shown.map((r) => r.min)).toEqual([30, 15]);
  });

  it("ignores a real-time entitlement the license does not grant", () => {
    const shown = enforceDelay(records, { license: delayed, entitledRealtime: true, now });
    expect(shown.map((r) => r.min)).toEqual([30, 15]);
  });

  it("returns everything only for an entitled user on a real-time license", () => {
    const realtime = { ...delayed, display: { ...delayed.display, realtime: true } };
    expect(enforceDelay(records, { license: realtime, entitledRealtime: true, now })).toHaveLength(
      4,
    );
    expect(enforceDelay(records, { license: realtime, entitledRealtime: false, now })).toHaveLength(
      2,
    );
  });

  it("returns nothing when the license allows no intraday display", () => {
    expect(
      enforceDelay(records, { license: DATA_LICENSES.tiingo, entitledRealtime: true, now }),
    ).toEqual([]);
  });
});
