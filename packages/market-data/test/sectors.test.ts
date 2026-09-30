import { describe, expect, it } from "vitest";
import { sectorForSic } from "../src/sectors";

describe("sectorForSic", () => {
  it.each([
    ["3571", "Technology"], // Apple: electronic computers
    ["7372", "Technology"], // Microsoft: prepackaged software
    ["7370", "Technology"], // Alphabet (GICS would say Communication Services)
    ["3674", "Technology"], // semiconductors
    ["5961", "Consumer Discretionary"], // Amazon: catalog and mail-order
    ["3711", "Consumer Discretionary"], // Tesla: motor vehicles
    ["6021", "Financials"], // JPMorgan: national commercial banks
    ["6798", "Real Estate"], // REITs
    ["2911", "Energy"], // ExxonMobil: petroleum refining
    ["2834", "Health Care"], // pharmaceutical preparations
    ["2080", "Consumer Staples"], // Coca-Cola: beverages
    ["5331", "Consumer Discretionary"], // variety stores
    ["4911", "Utilities"], // electric services
    ["4813", "Communication Services"], // telephone communications
    ["3721", "Industrials"], // aircraft
    ["2821", "Materials"], // plastics materials
  ])("SIC %s -> %s", (sic, sector) => {
    expect(sectorForSic(sic)).toBe(sector);
  });

  it("returns null for missing or unmapped codes", () => {
    expect(sectorForSic(null)).toBeNull();
    expect(sectorForSic("")).toBeNull();
    expect(sectorForSic("9995")).toBeNull();
    expect(sectorForSic("abc")).toBeNull();
  });
});
