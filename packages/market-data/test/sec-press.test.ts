import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORM_8K_ITEMS,
  filedDescription,
  filingIndexDocuments,
  pressReleaseExhibit,
  readPressRelease,
} from "../src/adapters/sec-press";
import { SecEdgarProvider } from "../src/adapters/sec-edgar";
import { decodeHtmlEntities, htmlBlocks } from "../src/html-text";
import { fixtureFetch } from "./helpers/fixtures";

/**
 * 8-K press releases (Phase 2 step I1) on exhibits recorded from EDGAR in October 2026 (public
 * SEC filings, trimmed after the lead paragraph; scripts/record-press-releases.ts). Each
 * expected headline was read off the filed document by hand.
 */
const dir = new URL("./fixtures/sec-edgar/recorded/press/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, dir), "utf8");

/** [accession, headline, start of the lead paragraph]; null where the document has none. */
const RELEASES: [string, string | null, string | null][] = [
  [
    "0001045810-26-000073",
    "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
    "SANTA CLARA, Calif.—Aug. 26, 2026―NVIDIA",
  ],
  [
    "0000002488-26-000121",
    "AMD Reports Second Quarter 2026 Financial Results",
    "SANTA CLARA, Calif. ― August 4, 2026 ― AMD",
  ],
  [
    "0001628280-26-049929",
    "Boeing Reports Second Quarter Results",
    "ARLINGTON, Va., July 28, 2026 – The Boeing Company",
  ],
  [
    "0000018230-26-000040",
    "Caterpillar Reports Second-Quarter 2026 Results",
    "IRVING, Texas, Aug. 4, 2026 – Caterpillar Inc.",
  ],
  [
    "0000027419-26-000034",
    "Target Corporation Reports Second Quarter Earnings",
    "MINNEAPOLIS (August 19, 2026) – Target Corporation",
  ],
  [
    "0000040545-26-000059",
    "GE AEROSPACE BOARD OF DIRECTORS APPOINTS WES BUSH AS INDEPENDENT LEAD DIRECTOR",
    "CINCINNATI — September 22, 2026 — GE Aerospace",
  ],
  [
    "0001193125-26-346806",
    "Intel Announces Proposed $15 Billion Common Stock Offering",
    "SANTA CLARA, Calif., August 10, 2026 - Intel Corporation",
  ],
  [
    "0000051143-26-000077",
    "IBM RELEASES SECOND-QUARTER RESULTS",
    "ARMONK, N.Y., July 22, 2026 . . . IBM",
  ],
  [
    "0000060667-26-000113",
    "LOWE’S REPORTS SECOND QUARTER 2026 SALES AND EARNINGS RESULTS",
    "MOORESVILLE, N.C., August 19, 2026 – Lowe’s",
  ],
  [
    "0000063908-26-000076",
    "McDONALD'S ADVANCES NEXT STRATEGY TO BECOME FIRST CHOICE FOR MORE CUSTOMERS, MORE OFTEN",
    "CHICAGO, IL - Today McDonald's Corporation",
  ],
  [
    "0000072971-26-000288",
    "Wells Fargo Reports Second Quarter 2026 Net Income of $6.4 billion, or $2.00 per Diluted Share",
    null,
  ],
  [
    "0000104169-26-000145",
    "Walmart reports second quarter results",
    "BENTONVILLE, Ark., August 20, 2026 – Walmart Inc.",
  ],
  [
    "0000354950-26-000145",
    "The Home Depot Announces Second Quarter Fiscal 2026 Results; Reaffirms Fiscal 2026 Guidance",
    "ATLANTA, August 18, 2026 -- The Home Depot",
  ],
  [
    "0000773840-26-000130",
    "Honeywell Technologies Announces Leadership Updates for Process Technology and Building Automation",
    "CHARLOTTE, N.C., Aug. 19, 2026 -- Honeywell",
  ],
  [
    "0000858877-26-000106",
    "CISCO REPORTS FOURTH QUARTER AND FISCAL YEAR 2026 EARNINGS",
    "SAN JOSE, Calif. -- August 12, 2026 -- Cisco",
  ],
  [
    "0001141391-26-000081",
    "Mastercard Incorporated Reports Second Quarter 2026 Financial Results",
    "Purchase, NY - July 30, 2026 - Mastercard",
  ],
  [
    "0001628280-26-059609",
    "UPS Announces Executive Leadership Changes and New Global Operating Model Effective September 1, 2026",
    "ATLANTA, August 31, 2026 – UPS",
  ],
  [
    "0001193125-26-389753",
    "Larry Ellison Cancels His Plan to Sell Oracle Stock",
    "AUSTIN, Texas, September 12, 2026 — Oracle",
  ],
  [
    "0001104659-26-090045",
    "Merck & Co., Inc., Rahway, N.J., USA Announces Second-Quarter 2026 Financial Results; Highlights Key Regulatory and Clinical Milestones Across Broad, Diverse Pipeline",
    "RAHWAY, N.J., Aug. 4, 2026 – Merck",
  ],
  [
    "0000080424-26-000094",
    "SHAILESH JEJURIKAR APPOINTED CHAIRMAN OF P&G BOARD OF DIRECTORS",
    "CINCINNATI, July 29, 2026 - The Procter & Gamble Company",
  ],
  [
    "0000829224-26-000129",
    "Starbucks Reports Q3 Fiscal Year 2026 Results",
    "SEATTLE; July 29, 2026 – Starbucks Corporation",
  ],
  // A dateline of eight words is the place and date only: no lead.
  ["0001403161-26-000103", "Visa Reports Fiscal Third Quarter 2026 Results", null],
  [
    "0000320187-26-000068",
    "John Rogers, Jr., founder of Ariel Investments, to retire from the NIKE, Inc. Board of Directors, Rogers to serve as strategic advisor to Nike focused on the future of sport and community",
    "(Beaverton, OR) -- June 18, 2026 -- NIKE, Inc.",
  ],
  [
    "0000886982-26-000294",
    "Goldman Sachs Reports Second Quarter Earnings Per Common Share of $20.98 and Increases the Quarterly Dividend to $5.00 Per Common Share in the Third Quarter",
    "NEW YORK, July 14, 2026 – The Goldman Sachs Group, Inc.",
  ],
  [
    "0001193125-26-266777",
    "Broadcom Inc. Commences Offers to Purchase for Cash Certain of its Outstanding Debt Securities",
    "PALO ALTO, Calif., June 11, 2026 — Broadcom Inc.",
  ],
  [
    "0001108524-26-000187",
    "Salesforce Delivers Record Second Quarter Fiscal 2027 Results",
    "SAN FRANCISCO, Calif. - August 26, 2026 - Salesforce",
  ],
  ["0000051143-26-000070", "Arvind Krishna's Letter to IBM Investors", null],
  // One block per page: a release this reader cannot take apart, so it is described instead.
  ["0000731766-26-000191", null, null],
  // A slide deck, a shareholder letter and an update deck: no headline to read.
  ["0001193125-26-380280", null, null],
  ["0001744489-26-000056", null, null],
  ["0001628280-26-049213", null, null],
];

describe("readPressRelease", () => {
  it.each(RELEASES)("%s", (accession, headline, lead) => {
    const read = readPressRelease(fixture(`${accession}.htm`));
    expect(read.headline).toBe(headline);
    if (lead === null) {
      expect(read.lead).toBeNull();
    } else {
      expect(read.lead?.startsWith(lead)).toBe(true);
      expect(read.lead!.length).toBeLessThanOrEqual(502);
    }
  });

  it("keeps leads to about 500 characters, ending at a sentence", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const html = `<p>Example Corp Schedules Product Release</p><p>NEW YORK, May 1, 2026 – Example Corp today said ${words}. Second sentence here.</p>`;
    const { headline, lead } = readPressRelease(html);
    expect(headline).toBe("Example Corp Schedules Product Release");
    expect(lead!.length).toBeLessThanOrEqual(502);
    expect(lead!.endsWith(" …")).toBe(true);
  });

  it("does not take contact lines, dates or release instructions for a headline", () => {
    const html = [
      "<div>Exhibit 99.1</div>",
      "<div>Media Contact:</div><div>Pat Example</div><div>(555) 010-0000</div>",
      "<div>pat@example.com</div><div>FOR IMMEDIATE RELEASE</div><div>September 1, 2026</div>",
      "<div>Example Corp Names New Chief Financial Officer</div>",
      "<div>• A bullet that is not the headline</div>",
      "<p>SPRINGFIELD, Ill., Sept. 1, 2026 – Example Corp (NYSE: EXM) today announced that a new officer starts next month.</p>",
    ].join("");
    expect(readPressRelease(html).headline).toBe("Example Corp Names New Chief Financial Officer");
  });
});

describe("filing index pages", () => {
  it("lists documents with their EDGAR types and picks the first EX-99 as the release", () => {
    const docs = filingIndexDocuments(fixture("0001045810-26-000073-index.htm"));
    expect(docs.slice(0, 3)).toEqual([
      { sequence: 1, description: "8-K", file: "nvda-20260826.htm", type: "8-K" },
      { sequence: 2, description: "EX-99.1", file: "q2fy27pr.htm", type: "EX-99.1" },
      { sequence: 3, description: "EX-99.2", file: "q2fy27cfocommentary.htm", type: "EX-99.2" },
    ]);
    expect(docs.find((d) => d.type === "GRAPHIC")?.file).toBe("nvdalogoa19.jpg");
    expect(pressReleaseExhibit(docs)?.file).toBe("q2fy27pr.htm");
    const wells = filingIndexDocuments(fixture("0000072971-26-000288-index.htm"));
    expect(wells.filter((d) => d.type.startsWith("EX-99")).map((d) => d.type)).toEqual([
      "EX-99.1",
      "EX-99.2",
      "EX-99.3",
    ]);
    expect(pressReleaseExhibit(wells)?.file).toBe("wfc2qer07-14x26ex991xrelea.htm");
  });

  it("finds no release in an 8-K without an EX-99 exhibit", () => {
    expect(
      pressReleaseExhibit(filingIndexDocuments(fixture("0001045810-26-000078-index.htm"))),
    ).toBeNull();
  });

  it("reads EX-99 before EX-99.2, and never a picture or PDF", () => {
    const doc = (type: string, file: string, sequence: number) => ({
      sequence,
      description: type,
      file,
      type,
    });
    expect(
      pressReleaseExhibit([
        doc("EX-99.2", "b.htm", 3),
        doc("EX-99", "a.htm", 4),
        doc("EX-99.1", "chart.jpg", 2),
      ])?.file,
    ).toBe("a.htm");
    expect(pressReleaseExhibit([doc("EX-99.1", "release.pdf", 2)])).toBeNull();
  });
});

describe("filedDescription", () => {
  it("says what was filed, by SEC's item titles", () => {
    expect(filedDescription("Example Corp", "EX-99.1", ["2.02", "9.01"])).toBe(
      "Example Corp filed Exhibit 99.1 with a Form 8-K: Results of Operations and Financial Condition",
    );
    expect(filedDescription("Example Corp", "EX-99", ["7.01", "8.01", "9.01"])).toBe(
      "Example Corp filed Exhibit 99 with a Form 8-K: Regulation FD Disclosure; Other Events",
    );
    expect(filedDescription("Example Corp", "EX-99.1", ["9.01"])).toBe(
      "Example Corp filed Exhibit 99.1 with a Form 8-K",
    );
    expect(FORM_8K_ITEMS["1.05"]).toBe("Material Cybersecurity Incidents");
  });
});

describe("htmlBlocks", () => {
  it("splits on block tags, joins lines broken by <br> and decodes references", () => {
    expect(
      htmlBlocks(
        "<html><head><title>EX-99.1</title><style>p{}</style></head><body><!-- note -->" +
          "<div>Walmart reports <br>second quarter results</div><p>Q&amp;A &#8212; &rsquo;26&nbsp;&#x2013; done</p>" +
          "<script>alert(1)</script><td> </td><td>&unknown;</td></body></html>",
      ),
    ).toEqual(["Walmart reports second quarter results", "Q&A — ’26 – done", "&unknown;"]);
  });

  it("drops EDGAR's SGML document wrapper and invisible characters", () => {
    expect(
      htmlBlocks("<TYPE>EX-99.1\n<SEQUENCE>2\n<FILENAME>a.htm\n<TEXT><p>Head​line here</p>"),
    ).toEqual(["Headline here"]);
    expect(decodeHtmlEntities("&#0; &#xD800; &#65;")).toBe("&#0; &#xD800; A");
  });
});

describe("SecEdgarProvider.getPressRelease", () => {
  const folder = "/Archives/edgar/data/1045810/000104581026000073";
  const filedAt = new Date("2026-08-26T20:21:19Z");
  const sec = (routes: Parameters<typeof fixtureFetch>[0]) => {
    const f = fixtureFetch(routes);
    return {
      calls: f.calls,
      p: new SecEdgarProvider({
        appName: "Example Analytics",
        contactEmail: "admin@example.com",
        rateLimiter: { acquire: () => Promise.resolve(0) },
        baseUrl: "https://sec.test",
        fetch: f.fetch,
        sleep: () => Promise.resolve(),
        now: () => new Date("2026-10-02T12:00:00Z"),
      }),
    };
  };

  it("reads the filing index, then Exhibit 99.1, into a news item", async () => {
    const { p, calls } = sec({
      [`${folder}/0001045810-26-000073-index.htm`]:
        "sec-edgar/recorded/press/0001045810-26-000073-index.htm",
      [`${folder}/q2fy27pr.htm`]: "sec-edgar/recorded/press/0001045810-26-000073.htm",
    });
    const item = await p.getPressRelease({
      cik: "1045810",
      accession: "0001045810-26-000073",
      company: "NVIDIA CORP",
      items: ["2.02", "9.01"],
      filedAt,
    });
    expect(item).toMatchObject({
      source: "sec_edgar",
      source_symbol: "0001045810",
      as_of: filedAt,
      license_tier: "public_domain",
      source_id: "0001045810-26-000073/q2fy27pr.htm",
      url: `https://sec.test${folder}/q2fy27pr.htm`,
      headline: "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
      described: false,
      publisher: "NVIDIA CORP",
      category: "press release",
      published_at: filedAt,
      symbols: [],
    });
    expect(item!.summary).toMatch(/^SANTA CLARA, Calif\.—Aug\. 26, 2026―NVIDIA/);
    expect(calls).toHaveLength(2);
  });

  it("says what was filed when the exhibit has no headline, and is null without one", async () => {
    const msft = "/Archives/edgar/data/789019/000119312526380280";
    const { p } = sec({
      [`${msft}/0001193125-26-380280-index.htm`]: {
        status: 200,
        body: '<table><tr><td>1</td><td>EX-99.1</td><td><a href="/x/d291965dex991.htm">d291965dex991.htm</a></td><td>EX-99.1</td><td>1</td></tr></table>',
      },
      [`${msft}/d291965dex991.htm`]: "sec-edgar/recorded/press/0001193125-26-380280.htm",
    });
    const deck = await p.getPressRelease({
      cik: "789019",
      accession: "0001193125-26-380280",
      company: "MICROSOFT CORP",
      items: ["7.01", "9.01"],
      filedAt,
    });
    expect(deck).toMatchObject({
      headline: "MICROSOFT CORP filed Exhibit 99.1 with a Form 8-K: Regulation FD Disclosure",
      described: true,
      summary: null,
    });
    const none = sec({
      "/Archives/edgar/data/1045810/000104581026000078/0001045810-26-000078-index.htm":
        "sec-edgar/recorded/press/0001045810-26-000078-index.htm",
    });
    expect(
      await none.p.getPressRelease({
        cik: "1045810",
        accession: "0001045810-26-000078",
        company: "NVIDIA CORP",
        items: ["8.01"],
        filedAt,
      }),
    ).toBeNull();
    expect(none.calls).toHaveLength(1);
  });
});
