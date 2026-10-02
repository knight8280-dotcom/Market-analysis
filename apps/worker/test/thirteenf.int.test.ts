import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "../src/context";
import { retentionStart } from "../src/jobs/thirteenf";
import { harness, type Harness } from "./helpers/context";

/**
 * 13F institutional holdings (Phase 2 step H2) end to end on trimmed SEC recordings: the
 * listing pages, two fails-to-deliver files and two Form 13F data sets, with positions computed
 * independently in Python (packages/market-data/scripts/make_sec_dataset_fixtures.py).
 */
const REC = "../../../packages/market-data/test/fixtures/sec-edgar/recorded/";
const file = (p: string) => readFileSync(fileURLToPath(new URL(REC + p, import.meta.url)));

interface Position {
  filer_cik: string;
  report_period: string;
  ticker: string;
  shares: number;
  value_usd: number;
  filer_name: string;
  filed_on: string;
  accession_nos: string[];
}
const expected = JSON.parse(file("form13f/expected.json").toString()) as { positions: Position[] };

const SETS = ["01mar2026-31may2026_form13f.zip", "01jun2026-31aug2026_form13f.zip"];
const ROUTES: Record<string, () => Buffer> = {
  "/data-research/sec-markets-data/form-13f-data-sets": () => file("listing-form13f.trimmed.html"),
  "/data-research/sec-markets-data/fails-deliver-data": () => file("listing-ftd.trimmed.html"),
  "/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip": () =>
    file("form13f/01jun2026-31aug2026_form13f.zip"),
  "/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip": () =>
    file("form13f/01mar2026-31may2026_form13f.zip"),
  "/files/data/fails-deliver-data/cnsfails202609a.zip": () => file("ftd/cnsfails202609a.zip"),
  "/files/data/fails-deliver-data/cnsfails202608b.zip": () => file("ftd/cnsfails202608b.zip"),
};

const NOW = "2026-10-02T21:30:00Z";
let h: Harness;
const requests: string[] = [];

const TICKERS: [string, string, string][] = [
  ["AAPL", "Apple Inc.", "equity"],
  ["GOOGL", "Alphabet Inc.", "equity"],
  ["GOOG", "Alphabet Inc.", "equity"],
  ["BRK-B", "Berkshire Hathaway Inc.", "equity"],
  ["SPY", "SPDR S&P 500 ETF Trust", "etf"],
  ["META", "Meta Platforms, Inc.", "equity"],
  // A listing whose ticker SEC's files give to a company with another name: never matched.
  ["XYZ", "Unrelated Widgets Corp", "equity"],
];

beforeAll(async () => {
  const sec = new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    baseUrl: "https://sec.test",
    fetch: (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url.pathname);
      const body = ROUTES[url.pathname];
      return Promise.resolve(
        body ? new Response(body(), { status: 200 }) : new Response("not found", { status: 404 }),
      );
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(NOW),
  });
  h = await harness({ now: NOW, extraProviders: [sec] });
  for (const [ticker, name, assetClass] of TICKERS) {
    const { security_id } = await h.t.db
      .insertInto("market.securities")
      .values({ ticker, name, asset_class: assetClass })
      .returning("security_id")
      .executeTakeFirstOrThrow();
    await h.t.db
      .insertInto("market.provider_symbols")
      .values({ security_id, source: "tiingo", source_symbol: ticker, valid_from: "2020-01-01" })
      .execute();
  }
  // A synthetic listing with a real-looking ticker must never get a CUSIP.
  await h.run("ingest-securities", { source: "synthetic" });
});
afterAll(async () => {
  await h.t.drop();
});

async function positions() {
  const rows = await h.t.db
    .selectFrom("market.institutional_holdings as h")
    .innerJoin("market.securities as s", "s.security_id", "h.security_id")
    .select([
      "h.filer_cik",
      "h.report_period",
      "s.ticker",
      "h.shares",
      "h.value_usd",
      "h.filer_name",
      "h.filed_on",
      "h.accession_nos",
    ])
    .execute();
  return rows
    .map((r) => ({ ...r, shares: Number(r.shares), value_usd: Number(r.value_usd) }))
    .sort((a, b) =>
      `${a.filer_cik}|${a.report_period}|${a.ticker}`.localeCompare(
        `${b.filer_cik}|${b.report_period}|${b.ticker}`,
      ),
    );
}
const want = () =>
  expected.positions
    .map(
      ({
        filer_cik,
        report_period,
        ticker,
        shares,
        value_usd,
        filer_name,
        filed_on,
        accession_nos,
      }) => ({
        filer_cik,
        report_period,
        ticker,
        shares,
        value_usd,
        filer_name,
        filed_on,
        accession_nos: [...accession_nos].sort(),
      }),
    )
    .sort((a, b) =>
      `${a.filer_cik}|${a.report_period}|${a.ticker}`.localeCompare(
        `${b.filer_cik}|${b.report_period}|${b.ticker}`,
      ),
    );

describe("retentionStart", () => {
  it("keeps eight quarter ends, the latest being the last completed quarter", () => {
    expect(retentionStart(new Date("2026-10-02T00:00:00Z"))).toBe("2024-12-31");
    expect(retentionStart(new Date("2026-03-31T23:00:00Z"))).toBe("2024-03-31");
    expect(retentionStart(new Date("2026-04-01T00:00:00Z"), 1)).toBe("2026-03-31");
  });
});

describe("refresh-cusips", () => {
  it("ties CUSIPs to our listings by ticker and name, and reports the rest", async () => {
    const result = await h.run("refresh-cusips", { files: 2 });
    expect(result).toEqual({
      files: ["cnsfails202609a.zip", "cnsfails202608b.zip"],
      cusipsSeen: 7,
      matched: 6,
      rejected: [],
    });
    const cusips = await h.t.db
      .selectFrom("market.security_cusips as c")
      .innerJoin("market.securities as s", "s.security_id", "c.security_id")
      .select(["s.ticker", "c.cusip", "c.symbol", "c.first_seen", "c.last_seen"])
      .orderBy("s.ticker")
      .execute();
    expect(cusips).toEqual([
      {
        ticker: "AAPL",
        cusip: "037833100",
        symbol: "AAPL",
        first_seen: "2026-08-17",
        last_seen: "2026-09-14",
      },
      {
        ticker: "BRK-B",
        cusip: "084670702",
        symbol: "BRKB",
        first_seen: "2026-08-20",
        last_seen: "2026-09-11",
      },
      {
        ticker: "GOOG",
        cusip: "02079K107",
        symbol: "GOOG",
        first_seen: "2026-08-21",
        last_seen: "2026-09-14",
      },
      {
        ticker: "GOOGL",
        cusip: "02079K305",
        symbol: "GOOGL",
        first_seen: "2026-08-17",
        last_seen: "2026-09-14",
      },
      {
        ticker: "META",
        cusip: "30303M102",
        symbol: "META",
        first_seen: "2026-08-19",
        last_seen: "2026-09-14",
      },
      {
        ticker: "SPY",
        cusip: "78462F103",
        symbol: "SPY",
        first_seen: "2026-08-17",
        last_seen: "2026-09-14",
      },
    ]);
  });
});

describe("ingest-13f", () => {
  it("stores each filer's position as filed, with restatements and new holdings applied", async () => {
    const result = (await h.run("ingest-13f", { names: SETS })) as {
      read: { name: string; filings: number; positions: number; rowCountMismatches: number }[];
      fromPeriod: string;
      cusipRefresh: unknown;
    };
    expect(result.fromPeriod).toBe("2024-12-31");
    // CUSIPs were refreshed minutes ago, so not again.
    expect(result.cusipRefresh).toBeNull();
    expect(result.read.map((r) => [r.name, r.filings, r.rowCountMismatches])).toEqual([
      ["01mar2026-31may2026_form13f.zip", 5, 0],
      ["01jun2026-31aug2026_form13f.zip", 15, 1],
    ]);
    expect(await positions()).toEqual(want());
  });

  it("gives the same positions whatever order the data sets are read in", async () => {
    await h.t.db.deleteFrom("market.form13f_data_sets").execute();
    await h.t.db.deleteFrom("market.institutional_holdings").execute();
    await h.run("ingest-13f", { names: [SETS[1]!] });
    // Q1 so far holds only what June's set restated or added.
    const partial = await positions();
    expect(
      partial.find((p) => p.filer_cik === "0000733986" && p.report_period === "2026-03-31"),
    ).toMatchObject({
      shares: 22542,
      accession_nos: ["0001062993-26-003311"],
    });
    await h.run("ingest-13f", { names: [SETS[0]!] });
    expect(await positions()).toEqual(want());
  });

  it("is idempotent: reading a set again changes nothing", async () => {
    const before = await positions();
    await h.run("ingest-13f", { names: SETS });
    expect(await positions()).toEqual(before);
    const sets = await h.t.db
      .selectFrom("market.form13f_data_sets")
      .select(["name", "filings", "row_count_mismatches"])
      .orderBy("name")
      .execute();
    expect(sets).toEqual([
      {
        name: "01jun2026-31aug2026_form13f.zip",
        filings: 15,
        row_count_mismatches: ["0001911876-26-000019"],
      },
      { name: "01mar2026-31may2026_form13f.zip", filings: 5, row_count_mismatches: [] },
    ]);
  });

  it("drops quarters that leave the retention window", async () => {
    // CUSIPs count as fresh at the new date, so no refresh is attempted.
    const fresh = (at: string) =>
      h.t.db
        .updateTable("market.security_cusips")
        .set({ updated_at: new Date(at) })
        .execute();
    h.setNow("2028-01-15T12:00:00Z");
    try {
      await fresh("2028-01-15T12:00:00Z");
      // Eight quarters back from Q4 2027 starts at Q1 2026: Q1 and Q2 2026 stay.
      await h.run("ingest-13f", { names: [SETS[1]!] });
      const periods = new Set((await positions()).map((p) => p.report_period));
      expect([...periods].sort()).toEqual(["2026-03-31", "2026-06-30"]);
      // From Q1 2028 eight quarters reach back to Q2 2026: Q1 2026 is dropped.
      h.setNow("2028-04-15T12:00:00Z");
      await fresh("2028-04-15T12:00:00Z");
      await h.run("ingest-13f", { names: [SETS[1]!] });
      expect(new Set((await positions()).map((p) => p.report_period))).toEqual(
        new Set(["2026-06-30"]),
      );
    } finally {
      h.setNow(NOW);
      await fresh(NOW);
    }
  });
});

describe("schedule-13f", () => {
  it("queues a read only when SEC lists a data set we have not read", async () => {
    const dispatched: JobRequest[] = [];
    const spy = vi.spyOn(h.dispatcher, "dispatch").mockImplementation((job) => {
      dispatched.push(job);
      return Promise.resolve();
    });
    try {
      await h.run("ingest-13f", { names: SETS });
      expect(await h.run("schedule-13f")).toEqual({ listed: 6, missing: [] });
      expect(dispatched).toEqual([]);
      await h.t.db.deleteFrom("market.form13f_data_sets").where("name", "=", SETS[1]!).execute();
      expect(await h.run("schedule-13f")).toEqual({ listed: 6, missing: [SETS[1]] });
      expect(dispatched.map((j) => [j.name, j.jobId, j.data])).toEqual([
        ["ingest-13f", "ingest-13f/2026-10-02/01jun2026-31aug2026", { names: [SETS[1]] }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
