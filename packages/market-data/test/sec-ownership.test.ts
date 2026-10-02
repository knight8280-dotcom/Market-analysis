import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ownershipXmlFile, parseOwnershipDocument } from "../src/adapters/sec-ownership";
import { ProviderResponseError } from "../src/errors";

/**
 * Form 4 parsing against thirteen filings recorded from EDGAR on 2026-10-02 (README in the
 * fixture folder). Expected values were read independently with Python's xml.etree.
 */
const DIR = new URL("./fixtures/sec-edgar/recorded/form4/", import.meta.url);
const xml = (accession: string) => readFileSync(new URL(`${accession}.xml`, DIR), "utf8");
const FETCHED = new Date("2026-10-02T21:00:00Z");
const parse = (accession: string) =>
  parseOwnershipDocument(xml(accession), {
    accession_no: accession,
    filed_at: new Date("2026-10-01T20:00:00Z"),
    fetched_at: FETCHED,
  });

describe("ownershipXmlFile", () => {
  it("finds the XML behind the rendered primary document", () => {
    expect(ownershipXmlFile("xslF345X06/form4.xml")).toBe("form4.xml");
    expect(ownershipXmlFile("xslF345X05/wk-form4_1727213456.xml")).toBe("wk-form4_1727213456.xml");
    expect(ownershipXmlFile("doc4.xml")).toBe("doc4.xml");
    expect(ownershipXmlFile("form4.htm")).toBeNull();
    expect(ownershipXmlFile(null)).toBeNull();
    expect(ownershipXmlFile("../../etc/passwd.xml")).toBe("passwd.xml");
  });
});

describe("parseOwnershipDocument", () => {
  it("reads a sale under a Rule 10b5-1 plan (Apple, X0609, true/false flags)", () => {
    const f = parse("0001140361-26-038307");
    expect(f).toMatchObject({
      source: "sec_edgar",
      source_symbol: "0000320193",
      license_tier: "public_domain",
      fetched_at: FETCHED,
      form_type: "4",
      schema_version: "X0609",
      period_of_report: "2026-09-29",
      original_filing_date: null,
      issuer_cik: "0000320193",
      issuer_name: "Apple Inc.",
      issuer_symbol: "AAPL",
      aff_10b5_1: true,
      no_longer_subject_to_section16: false,
      remarks: null,
    });
    expect(f.owners).toEqual([
      {
        cik: "0001780525",
        name: "Newstead Jennifer",
        is_director: false,
        is_officer: true,
        officer_title: "SVP, GC and Government Affairs",
        is_ten_percent_owner: false,
        is_other: false,
        other_text: null,
      },
    ]);
    expect(f.transactions).toEqual([
      {
        line: 1,
        derivative: false,
        security_title: "Common Stock",
        transaction_date: "2026-09-29",
        deemed_execution_date: null,
        code: "S",
        equity_swap: false,
        shares: 2399,
        price: 336.18,
        acquired_disposed: "D",
        shares_after: 41992,
        ownership: "D",
        ownership_nature: null,
        conversion_price: null,
        exercise_date: null,
        expiration_date: null,
        underlying_title: null,
        underlying_shares: null,
        footnote_ids: ["F1"],
      },
    ]);
    expect(f.footnotes.F1).toBe(
      "This transaction was made pursuant to a Rule 10b5-1 trading plan adopted by the reporting person on May 5, 2026.",
    );
  });

  it("reads an open-market purchase held indirectly (Intel, 0/1 flags, holdings lines skipped)", () => {
    const f = parse("0000050863-26-000177");
    expect(f.owners[0]).toMatchObject({
      cik: "0001008463",
      name: "TAN LIP BU",
      is_director: true,
      is_officer: true,
      officer_title: "CEO",
    });
    expect(f.aff_10b5_1).toBe(false);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      code: "P",
      shares: 105263,
      price: 95,
      acquired_disposed: "A",
      shares_after: 1314669,
      ownership: "I",
      ownership_nature: "by Family Trust",
      footnote_ids: [],
    });
  });

  it("reads restricted stock units vesting: prices given only in footnotes are null", () => {
    const f = parse("0000050863-26-000174");
    expect(f.owners[0]!.officer_title).toBe("EVP, CT & Ops Off, GM Foundry");
    expect(f.transactions.map((t) => [t.line, t.derivative, t.code, t.shares, t.price])).toEqual([
      [1, false, "M", 33007, null],
      [2, false, "F", 14738, 90.04],
      [3, true, "M", 33007, null],
    ]);
    expect(f.transactions[2]).toMatchObject({
      security_title: "Restricted Stock Units",
      acquired_disposed: "D",
      shares_after: 33008,
      conversion_price: null,
      exercise_date: null,
      expiration_date: null,
      underlying_title: "Common Stock",
      underlying_shares: 33007,
      footnote_ids: ["F1", "F2"],
    });
    expect(f.footnotes.F2).toMatch(/^Unless earlier forfeited/);
  });

  it("reads weighted-average sale prices and keeps each line's footnote", () => {
    const f = parse("0001910388-26-000007");
    expect(f.issuer_symbol).toBe("GS");
    expect(f.transactions.map((t) => [t.shares, t.price, t.shares_after, t.footnote_ids])).toEqual([
      [37, 1053.05, 11698, ["F1"]],
      [129, 1054.18, 11569, ["F2"]],
      [9, 1054.77, 11560, []],
    ]);
    expect(f.footnotes.F1).toMatch(/^Reflects a weighted average sale price of \$1,053\.05/);
  });

  it("reads an amendment with its original filing date and fractional units", () => {
    const f = parse("0001921955-26-000012");
    expect(f.form_type).toBe("4/A");
    expect(f.original_filing_date).toBe("2026-03-19");
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({
      line: 1,
      derivative: true,
      security_title: "Deferred Compensation Units",
      code: "I",
      shares: 3425.8308,
      price: 116.76,
      shares_after: 7134.728,
      footnote_ids: ["F1", "F2", "F3"],
    });
    // Footnote text keeps its words with whitespace collapsed (it spans lines in the file).
    expect(f.footnotes.F2).toContain(
      "is the economic equivalent of the purchase of the same number of shares",
    );
  });

  it("reads the older X0508 schema", () => {
    const f = parse("0000034088-26-000039");
    expect(f.schema_version).toBe("X0508");
    expect(f.transactions.map((t) => [t.code, t.shares, t.price, t.shares_after])).toEqual([
      ["S", 650, 139.755, 27934],
      ["S", 4350, 139.75, 23584],
    ]);
    expect(f.transactions[0]!.ownership_nature).toBe("By Revocable Trust");
  });

  it("reads an exit filing with no transactions", () => {
    const f = parse("0000034088-26-000085");
    expect(f.transactions).toEqual([]);
    expect(f.no_longer_subject_to_section16).toBe(true);
    expect(f.owners[0]).toMatchObject({ cik: "0001847774", name: "Fox Leonard M." });
  });

  it("reports the issuer as filed, so a filing about another company can be told apart", () => {
    // Listed in Goldman Sachs' submissions because it is a reporting owner, not the issuer.
    const f = parse("0000886982-26-000310");
    expect(f.issuer_cik).toBe("0001355096");
    expect(f.issuer_name).toBe("Old QVC Group, Inc.");
    expect(f.owners.map((o) => [o.cik, o.name, o.is_ten_percent_owner])).toEqual([
      ["0000886982", "GOLDMAN SACHS GROUP INC", true],
      ["0000769993", "GOLDMAN SACHS & CO. LLC", true],
    ]);
    expect(f.remarks).toMatch(/^On August 6, 2026, all of the Issuer's equity securities/);
  });

  it("refuses documents it cannot read, without guessing", () => {
    const meta = {
      accession_no: "0000000000-26-000001",
      filed_at: FETCHED,
      fetched_at: FETCHED,
    };
    const base = xml("0001140361-26-038307");
    const broken = [
      base.replace("<transactionCode>S</transactionCode>", "<transactionCode>Q</transactionCode>"),
      base.replace("<value>2399</value>", "<value>2,3x9</value>"),
      base.replace("<value>2026-09-29</value>", "<value>29/09/2026</value>"),
      base.replace("<isOfficer>true</isOfficer>", "<isOfficer>yes</isOfficer>"),
      base
        .replace("<ownershipDocument>", "<otherDocument>")
        .replace("</ownershipDocument>", "</otherDocument>"),
      base.replace("</issuer>", ""),
    ];
    for (const doc of broken) {
      expect(() => parseOwnershipDocument(doc, meta)).toThrow(ProviderResponseError);
    }
  });

  it("parses every recorded filing", () => {
    const files = readdirSync(fileURLToPath(DIR)).filter((f) => f.endsWith(".xml"));
    expect(files).toHaveLength(13);
    for (const file of files)
      expect(parse(file.replace(/\.xml$/, "")).owners.length).toBeGreaterThan(0);
  });
});
