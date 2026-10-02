import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dataSetLinks,
  openZip,
  readFails,
  readForm13f,
  secDate,
} from "../src/adapters/sec-datasets";
import { ProviderResponseError } from "../src/errors";

/**
 * SEC bulk data sets (Phase 2 step H2) against trimmed recordings of two Form 13F data sets and
 * two fails-to-deliver files, with expected results computed independently in Python
 * (scripts/make_sec_dataset_fixtures.py).
 */
const DIR = new URL("./fixtures/sec-edgar/recorded/", import.meta.url);
const path = (p: string) => fileURLToPath(new URL(p, DIR));
const text = (p: string) => readFileSync(path(p), "utf8");

interface Expected {
  sets: Record<string, { filings: unknown[]; holdings: unknown[]; row_count_mismatches: string[] }>;
  ftd: Record<
    string,
    { symbol: string; description: string; first_seen: string; last_seen: string }
  >;
}
const expected = JSON.parse(text("form13f/expected.json")) as Expected;
const CUSIPS = new Set([
  "037833100",
  "02079K305",
  "02079K107",
  "084670702",
  "78462F103",
  "30303M102",
]);

async function* from(lines: string[]) {
  for (const l of lines) yield await Promise.resolve(l);
}

describe("secDate", () => {
  it("reads SEC's day-month-year dates, with or without dashes", () => {
    expect(secDate("30-JUN-2026")).toBe("2026-06-30");
    expect(secDate("01dec2025")).toBe("2025-12-01");
    expect(secDate("28-feb-2026")).toBe("2026-02-28");
  });

  it.each(["31-FEB-2026", "2026-06-30", "30-JUX-2026", ""])("refuses %j", (bad) => {
    expect(() => secDate(bad)).toThrow(/not an SEC date/);
  });
});

describe("dataSetLinks", () => {
  it("finds 13F data sets under whichever folder SEC put them, newest first", () => {
    const links = dataSetLinks(
      text("listing-form13f.trimmed.html"),
      "form13f",
      "https://www.sec.gov",
    );
    expect(links.map((l) => [l.name, l.from, l.to])).toEqual([
      ["01jun2026-31aug2026_form13f.zip", "2026-06-01", "2026-08-31"],
      ["01mar2026-31may2026_form13f.zip", "2026-03-01", "2026-05-31"],
      ["01dec2025-28feb2026_form13f.zip", "2025-12-01", "2026-02-28"],
      ["01sep2025-30nov2025_form13f.zip", "2025-09-01", "2025-11-30"],
      ["01jun2025-31aug2025_form13f.zip", "2025-06-01", "2025-08-31"],
      ["01mar2025-31may2025_form13f.zip", "2025-03-01", "2025-05-31"],
    ]);
    expect(links[0]!.url).toBe(
      "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip",
    );
    expect(links[1]!.url).toBe(
      "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip",
    );
  });

  it("finds fails-to-deliver halves with their settlement ranges", () => {
    const links = dataSetLinks(text("listing-ftd.trimmed.html"), "ftd", "https://www.sec.gov");
    expect(links).toHaveLength(10);
    expect(links.slice(0, 3).map((l) => [l.name, l.from, l.to])).toEqual([
      ["cnsfails202609a.zip", "2026-09-01", "2026-09-15"],
      ["cnsfails202608b.zip", "2026-08-16", "2026-08-31"],
      ["cnsfails202608a.zip", "2026-08-01", "2026-08-15"],
    ]);
    expect(links.find((l) => l.name === "cnsfails202605b.zip")!.url).toBe(
      "https://www.sec.gov/files/data/other/fails-deliver-data/cnsfails202605b.zip",
    );
  });

  it("ignores links to other hosts and files of another form", () => {
    const html = `<a href="https://evil.example/x/01jun2026-31aug2026_form13f.zip">x</a>
      <a href="/files/readme.zip">y</a><a href="/files/cnsfails202609c.zip">z</a>
      <a href="/files/cnsfails202609a.zip">ok</a>`;
    expect(dataSetLinks(html, "form13f", "https://www.sec.gov")).toEqual([]);
    expect(dataSetLinks(html, "ftd", "https://www.sec.gov").map((l) => l.name)).toEqual([
      "cnsfails202609a.zip",
    ]);
  });
});

describe("readFails", () => {
  it("reads the recorded files, keeping SEC's '.' as no price", async () => {
    const zip = await openZip(path("ftd/cnsfails202609a.zip"));
    try {
      const rows = await readFails(zip.lines(zip.names[0]!, "latin1"));
      const aapl = rows.find((r) => r.cusip === "037833100")!;
      expect(aapl).toMatchObject({ symbol: "AAPL", description: "APPLE INC;COM NPV" });
      expect(rows.find((r) => r.symbol === "BRKB")!.description).toBe(
        "BERKSHIRE HATHWY INC(HLDG CO)B",
      );
      // Both recordings together give the expected CUSIP map (latest symbol and dates).
      const zip2 = await openZip(path("ftd/cnsfails202608b.zip"));
      const all = [...(await readFails(zip2.lines(zip2.names[0]!, "latin1"))), ...rows];
      zip2.close();
      expect(all.find((r) => r.cusip === "G8021C104")!.price).toBeNull();
      const latest: Expected["ftd"] = {};
      for (const r of all) {
        const prev = latest[r.cusip];
        latest[r.cusip] = {
          symbol: !prev || r.settlement_date >= prev.last_seen ? r.symbol : prev.symbol,
          description:
            !prev || r.settlement_date >= prev.last_seen ? r.description : prev.description,
          first_seen:
            prev && prev.first_seen < r.settlement_date ? prev.first_seen : r.settlement_date,
          last_seen:
            prev && prev.last_seen > r.settlement_date ? prev.last_seen : r.settlement_date,
        };
      }
      expect(latest).toEqual(expected.ftd);
    } finally {
      zip.close();
    }
  });

  it("refuses a file whose trailer count does not match, or a changed layout", async () => {
    const header = "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE";
    const row = "20260903|037833100|AAPL|1332|APPLE INC;COM NPV|324.96";
    await expect(readFails(from([header, row, "Trailer record count 2"]))).rejects.toThrow(
      /trailer says 2/,
    );
    await expect(readFails(from([header, row]))).rejects.toThrow(/trailer says nothing/);
    await expect(readFails(from(["DATE|CUSIP", row]))).rejects.toThrow(/header/);
    await expect(
      readFails(from([header, "20260903|037833100|AAPL|12x|APPLE|1", "Trailer record count 1"])),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(await readFails(from([header, row, "Trailer record count 1"]))).toHaveLength(1);
  });
});

describe("readForm13f", () => {
  it.each(Object.keys(expected.sets))(
    "reads %s: filings from 2024 on, and our share holdings summed per filing",
    async (name) => {
      const zip = await openZip(path(`form13f/${name}`));
      try {
        const set = await readForm13f((t) => zip.lines(t), {
          cusips: CUSIPS,
          fromPeriod: "2024-01-01",
        });
        expect(set.filings).toEqual(expected.sets[name]!.filings);
        expect(set.holdings).toEqual(expected.sets[name]!.holdings);
        // As filed: one amendment's summary page says 1 row and $0 for its 14 rows.
        expect(set.rowCountMismatches).toEqual(expected.sets[name]!.row_count_mismatches);
        expect(set.infotableRows).toBeGreaterThan(set.holdings.length);
      } finally {
        zip.close();
      }
    },
  );

  it("leaves out puts, calls and principal amounts, and reports summary mismatches", async () => {
    const header =
      "ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tFIGI\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL";
    const tables: Record<string, string[]> = {
      "COVERPAGE.tsv": [
        "ACCESSION_NUMBER\tAMENDMENTTYPE\tFILINGMANAGER_NAME\tREPORTTYPE",
        "0000000001-26-000001\t\tOld Units LLC\t13F HOLDINGS REPORT",
      ],
      "SUMMARYPAGE.tsv": [
        "ACCESSION_NUMBER\tTABLEENTRYTOTAL\tTABLEVALUETOTAL",
        "0000000001-26-000001\t5\t100",
      ],
      "SUBMISSION.tsv": [
        "ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT",
        // A CIK without its leading zeros, as a few submissions give it.
        "0000000001-26-000001\t14-NOV-2022\t13F-HR\t1\t30-SEP-2022",
      ],
      "INFOTABLE.tsv": [
        header,
        "0000000001-26-000001\t1\tAPPLE\tCOM\t037833100\t\t15\t100\tSH\t",
        "0000000001-26-000001\t2\tAPPLE\tCOM\t037833100\t\t9\t50\tSH\tPut",
        "0000000001-26-000001\t3\tAPPLE\tNOTE\t037833100\t\t9\t50\tPRN\t",
        "0000000001-26-000001\t4\tAPPLE\tCOM\t037833100\t\t5\t30\tSH\t",
      ],
    };
    const set = await readForm13f((t) => from(tables[t]!), {
      cusips: CUSIPS,
      fromPeriod: "2022-01-01",
    });
    // Filed before 2023-01-03: value in thousands of dollars.
    expect(set.holdings).toEqual([
      {
        accession_no: "0000000001-26-000001",
        cusip: "037833100",
        shares: 130,
        value_usd: 20000,
        rows: 2,
      },
    ]);
    expect(set.rowCountMismatches).toEqual(["0000000001-26-000001"]);
    expect(set.filings[0]!.filer_cik).toBe("0000000001");
  });

  it("refuses a table that lacks a column it needs", async () => {
    await expect(
      readForm13f((t) => from(t === "COVERPAGE.tsv" ? ["ACCESSION_NUMBER\tREPORTTYPE"] : []), {
        cusips: CUSIPS,
        fromPeriod: "2024-01-01",
      }),
    ).rejects.toThrow(/COVERPAGE lacks column\(s\) AMENDMENTTYPE, FILINGMANAGER_NAME/);
  });
});
