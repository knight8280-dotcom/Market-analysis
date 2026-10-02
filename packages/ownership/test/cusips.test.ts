import { describe, expect, it } from "vitest";
import { compactTicker, matchCusips, nameWords, namesAgree, type CusipSeen } from "../src";

/** CUSIP-to-security matching with descriptions as SEC's fails-to-deliver files print them. */
const seen = (cusip: string, symbol: string, description: string): CusipSeen => ({
  cusip,
  symbol,
  description,
  first_seen: "2026-08-17",
  last_seen: "2026-09-14",
});

describe("CUSIP matching", () => {
  it("compares tickers without separators", () => {
    expect(compactTicker("BRK-B")).toBe("BRKB");
    expect(compactTicker("brk.b")).toBe("BRKB");
    expect(compactTicker("BF/A")).toBe("BFA");
  });

  it("keeps the words that identify a name", () => {
    expect([...nameWords("BERKSHIRE HATHWY INC(HLDG CO)B")]).toEqual(["BERKSHIRE", "HATHWY"]);
    expect([...nameWords("STATE STREET SPDR S&P 500 ETF")]).toEqual([
      "STATE",
      "STREET",
      "SPDR",
      "S&P",
    ]);
    expect(namesAgree("SPDR S&P 500 ETF Trust", "STATE STREET SPDR S&P 500 ETF")).toBe(true);
    // Shared generic words or numbers are not enough.
    expect(namesAgree("Acme Holdings Inc 500", "Zenith Holdings Inc 500")).toBe(false);
    // The same start once punctuation is gone (descriptions from the 2026-09 files).
    expect(namesAgree("Walmart Inc.", "WAL-MART INC (DE)")).toBe(true);
    expect(namesAgree("3M CO", "3M COMPANY;COM USD0.01")).toBe(true);
    // A renamed company does not agree with its old name.
    expect(namesAgree("GENERAL ELECTRIC CO", "GE AEROSPACE COMMON STOCK")).toBe(false);
    expect(namesAgree("GEN Holdings", "GENE Corp")).toBe(false);
  });

  it("matches real descriptions to our names and rejects a reused ticker", () => {
    const securities = [
      { security_id: "1", ticker: "AAPL", name: "Apple Inc." },
      { security_id: "2", ticker: "BRK-B", name: "Berkshire Hathaway Inc." },
      { security_id: "3", ticker: "SPY", name: "SPDR S&P 500 ETF Trust" },
      { security_id: "4", ticker: "GOOGL", name: "Alphabet Inc." },
      { security_id: "5", ticker: "META", name: "Meta Platforms, Inc." },
      { security_id: "6", ticker: "XYZ", name: "Old Widgets Corp" },
    ];
    const { matched, rejected } = matchCusips(
      [
        seen("037833100", "AAPL", "APPLE INC;COM NPV"),
        seen("084670702", "BRKB", "BERKSHIRE HATHWY INC(HLDG CO)B"),
        seen("78462F103", "SPY", "STATE STREET SPDR S&P 500 ETF"),
        seen("02079K305", "GOOGL", "ALPHABET INC CAP STK CL A"),
        seen("02079K107", "GOOG", "ALPHABET INC CAP STK CL C"),
        seen("30303M102", "META", "META PLATFORMS, INC. CLASS A C"),
        seen("98765X101", "XYZ", "NEW BRIGHT ENERGY INC"),
      ],
      securities,
    );
    expect(matched.map((m) => [m.cusip, m.security_id])).toEqual([
      ["037833100", "1"],
      ["084670702", "2"],
      ["78462F103", "3"],
      ["02079K305", "4"],
      ["30303M102", "5"],
    ]);
    // GOOG is not among our securities; XYZ now belongs to another company.
    expect(rejected.map((r) => [r.cusip, r.ticker, r.description])).toEqual([
      ["98765X101", "XYZ", "NEW BRIGHT ENERGY INC"],
    ]);
  });
});
